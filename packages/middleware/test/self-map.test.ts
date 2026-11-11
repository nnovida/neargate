import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentGateError, SELF_MAP_WINDOW_MS } from '@agentgate/shared';
import {
  bootGateway,
  newTestKey,
  postSelfMap,
  signSelfMap,
  sleep,
  startUpstream,
  testConfig,
  type TestGateway,
  type TestKey,
  type TestUpstream,
} from './helpers';

const OWNER = 'owner.mock';
const STRANGER = 'stranger.mock';

describe('self-service mapping POST /services/:id/map (NEAR full-access key)', () => {
  let gw: TestGateway;
  let upstream: TestUpstream;
  let ownerKey: TestKey;
  let fnCallKey: TestKey;
  let strangerKey: TestKey;

  // A fresh gateway per test: /services is rate-limited per IP and the replay
  // guard is per-gateway state, so tests must not share either.
  beforeEach(async () => {
    gw = await bootGateway();
    upstream = await startUpstream();
    gw.fake.addService({ id: 1, name: 'Owned Feed', owner: OWNER });
    gw.fake.addService({ id: 2, name: 'Other Feed', owner: OWNER });
    ownerKey = newTestKey();
    fnCallKey = newTestKey(); // a function-call access key of the owner: never registered as full access
    strangerKey = newTestKey();
    gw.fake.addFullAccessKey(OWNER, ownerKey.publicKey);
    gw.fake.addFullAccessKey(STRANGER, strangerKey.publicKey);
  });

  afterEach(async () => {
    await gw.close();
    await upstream.close();
  });

  const target = (): string => `${upstream.url}/data`;
  const sign = (over: Partial<Parameters<typeof signSelfMap>[0]> = {}) =>
    signSelfMap({ key: ownerKey, accountId: OWNER, serviceId: 1, upstreamUrl: target(), ...over });
  /** 503 = the service exists on-chain but this gateway has no mapping for it. */
  const isMapped = async (id: number): Promise<boolean> => (await fetch(`${gw.baseUrl}/svc/${id}`)).status !== 503;

  describe('success', () => {
    it('a valid signature by the owner full-access key maps the upstream (204) and persists it', async () => {
      expect(await isMapped(1)).toBe(false);
      const res = await postSelfMap(gw, 1, sign());
      expect(res.status).toBe(204);
      expect(await isMapped(1)).toBe(true);
      const list = await fetch(`${gw.baseUrl}/admin/services`, {
        headers: { authorization: `Bearer ${gw.config.adminToken}` },
      });
      expect(await list.json()).toEqual([{ serviceId: 1, upstreamUrl: target() }]);
      // ...and it is on disk, not just in memory (the 204 is only sent once the write landed)
      expect(JSON.parse(readFileSync(gw.upstreamsFile, 'utf8'))).toEqual({ '1': target() });
    });

    it('a later, newer-timestamp request re-maps the same service', async () => {
      const now = Date.now();
      expect((await postSelfMap(gw, 1, sign({ timestamp: now }))).status).toBe(204);
      const moved = `${upstream.url}/echo`;
      expect((await postSelfMap(gw, 1, sign({ upstreamUrl: moved, timestamp: now + 1 }))).status).toBe(204);
      const list = await fetch(`${gw.baseUrl}/admin/services`, {
        headers: { authorization: `Bearer ${gw.config.adminToken}` },
      });
      expect(await list.json()).toEqual([{ serviceId: 1, upstreamUrl: moved }]);
    });
  });

  describe('who may map', () => {
    it('another account, even with a valid signature by its own full-access key → 403 not_service_owner', async () => {
      const res = await postSelfMap(gw, 1, sign({ key: strangerKey, accountId: STRANGER }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_service_owner' });
      expect(await isMapped(1)).toBe(false);
    });

    it("the owner's function-call key → 403 key_not_full_access", async () => {
      const res = await postSelfMap(gw, 1, sign({ key: fnCallKey }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'key_not_full_access' });
      expect(await isMapped(1)).toBe(false);
    });

    it("a stranger's full-access key claimed for the owner account → 403 key_not_full_access", async () => {
      const res = await postSelfMap(gw, 1, sign({ key: strangerKey }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'key_not_full_access' });
    });
  });

  describe('signature', () => {
    it('a flipped signature byte → 401 owner_signature_invalid', async () => {
      const body = sign();
      const sig = Buffer.from(body.signature, 'base64');
      sig[10] = (sig[10] ?? 0) ^ 0x01;
      const res = await postSelfMap(gw, 1, { ...body, signature: sig.toString('base64') });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'owner_signature_invalid' });
      expect(await isMapped(1)).toBe(false);
    });

    it('a signature by a different key than the transmitted publicKey → 401', async () => {
      const res = await postSelfMap(gw, 1, { ...sign(), signature: sign({ key: strangerKey }).signature });
      expect(res.status).toBe(401);
    });

    it('a signed upstreamUrl that differs from the transmitted one → 401', async () => {
      const res = await postSelfMap(gw, 1, { ...sign(), upstreamUrl: `${upstream.url}/fail` });
      expect(res.status).toBe(401);
      expect(await isMapped(1)).toBe(false);
    });

    it('a signature for another network → 401', async () => {
      const res = await postSelfMap(gw, 1, sign({ network: 'near-testnet' }));
      expect(res.status).toBe(401);
    });

    it('a replay to another service id → 401', async () => {
      const body = sign({ serviceId: 1 });
      const res = await postSelfMap(gw, 2, body); // same owner, same bytes, other service
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'owner_signature_invalid' });
      expect(await isMapped(2)).toBe(false);
    });
  });

  describe('freshness and replay', () => {
    it('a timestamp off by more than SELF_MAP_WINDOW_MS (past or future) → 400 stale_timestamp', async () => {
      for (const skew of [-(SELF_MAP_WINDOW_MS + 2_000), SELF_MAP_WINDOW_MS + 2_000]) {
        const res = await postSelfMap(gw, 1, sign({ timestamp: Date.now() + skew }));
        expect(res.status, `skew ${skew}`).toBe(400);
        expect(await res.json()).toEqual({ error: 'stale_timestamp' });
      }
      expect(await isMapped(1)).toBe(false);
    });

    it('a timestamp inside the window is accepted', async () => {
      const res = await postSelfMap(gw, 1, sign({ timestamp: Date.now() - (SELF_MAP_WINDOW_MS - 5_000) }));
      expect(res.status).toBe(204);
    });

    it('an older-or-equal timestamp on the same service → 409 replayed', async () => {
      const t = Date.now();
      expect((await postSelfMap(gw, 1, sign({ timestamp: t }))).status).toBe(204);
      for (const ts of [t, t - 1, t - 10_000]) {
        const res = await postSelfMap(gw, 1, sign({ upstreamUrl: `${upstream.url}/echo`, timestamp: ts }));
        expect(res.status, `ts ${ts - t}`).toBe(409);
        expect(await res.json()).toEqual({ error: 'replayed' });
      }
      // the replays changed nothing
      const list = await fetch(`${gw.baseUrl}/admin/services`, {
        headers: { authorization: `Bearer ${gw.config.adminToken}` },
      });
      expect(await list.json()).toEqual([{ serviceId: 1, upstreamUrl: target() }]);
      // a newer one still goes through
      expect((await postSelfMap(gw, 1, sign({ timestamp: t + 1 }))).status).toBe(204);
    });

    it('the replay guard is per service', async () => {
      const t = Date.now();
      expect((await postSelfMap(gw, 1, sign({ timestamp: t }))).status).toBe(204);
      expect((await postSelfMap(gw, 2, sign({ serviceId: 2, timestamp: t }))).status).toBe(204);
    });

    it('a rejected request never advances the replay guard', async () => {
      const t = Date.now();
      // Each of these is refused at a different check, with a timestamp newer than the success below.
      expect((await postSelfMap(gw, 1, sign({ key: fnCallKey, timestamp: t + 30_000 }))).status).toBe(403);
      expect((await postSelfMap(gw, 1, sign({ upstreamUrl: 'ftp://example.com/x', timestamp: t + 20_000 }))).status).toBe(400);
      expect((await postSelfMap(gw, 1, { ...sign({ timestamp: t + 10_000 }), signature: 'AAAA' })).status).toBe(401);
      // t + 5_000 is older than every rejected request but newer than any accepted one: it must still map.
      expect((await postSelfMap(gw, 1, sign({ timestamp: t + 5_000 }))).status).toBe(204);
    });
  });

  describe('SSRF guard', () => {
    it('an invalid upstream URL → 400 and maps nothing', async () => {
      for (const upstreamUrl of ['ftp://example.com/x', 'not a url', 'http://user:pw@example.com/']) {
        const res = await postSelfMap(gw, 1, sign({ upstreamUrl, timestamp: Date.now() }));
        expect(res.status, upstreamUrl).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_upstream_url' });
      }
      expect(await isMapped(1)).toBe(false);
    });

    it('live mode refuses a loopback/private upstream (400 forbidden_upstream_host) and maps nothing', async () => {
      const live = await bootGateway({
        config: testConfig({ mode: 'live', adminToken: 'live-admin-secret', gatewayAccountId: 'gateway.testnet' }),
      });
      try {
        live.fake.addService({ id: 1, owner: OWNER });
        live.fake.addFullAccessKey(OWNER, ownerKey.publicKey);
        for (const upstreamUrl of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x']) {
          const res = await postSelfMap(live, 1, sign({ upstreamUrl }));
          expect(res.status, upstreamUrl).toBe(400);
          expect(await res.json()).toEqual({ error: 'forbidden_upstream_host' });
        }
        const list = await fetch(`${live.baseUrl}/admin/services`, {
          headers: { authorization: 'Bearer live-admin-secret' },
        });
        expect(await list.json()).toEqual([]);
        // the same owner and key map a public host fine
        expect((await postSelfMap(live, 1, sign({ upstreamUrl: 'https://api.example.com/gold' }))).status).toBe(204);
      } finally {
        await live.close();
      }
    });

    it('mock mode still allows a loopback upstream (local demo)', async () => {
      expect((await postSelfMap(gw, 1, sign({ upstreamUrl: 'http://127.0.0.1:4010/feed' }))).status).toBe(204);
    });
  });

  describe('request shape', () => {
    it('an unknown service id → 404 service_not_found', async () => {
      const res = await postSelfMap(gw, 999, sign({ serviceId: 999 }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'service_not_found' });
    });

    it('a non-numeric service id → 400 invalid_service_id', async () => {
      const res = await postSelfMap(gw, 'abc', sign());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_service_id' });
    });

    it('a malformed body → 400 invalid_body, never a chain call', async () => {
      // Any chain call would fail loudly: a malformed account id must never reach isFullAccessKey.
      gw.fake.keyLookupFailure = new AgentGateError('ERR_INVALID_ACCOUNT_ID', 'ERR_INVALID_ACCOUNT_ID: bad id', 400);
      const good = sign();
      const shortKey = `ed25519:${'1'.repeat(10)}`; // base58, but nowhere near 32 bytes
      const bodies: unknown[] = [
        [],
        {},
        { ...good, upstreamUrl: 42 },
        { ...good, upstreamUrl: undefined },
        { ...good, accountId: 'Not A Valid Account!' },
        { ...good, accountId: 'UPPER.mock' },
        { ...good, accountId: 7 },
        { ...good, publicKey: good.publicKey.slice('ed25519:'.length) },
        { ...good, publicKey: 'secp256k1:abcdef' },
        { ...good, publicKey: 'ed25519:0OIl' },
        { ...good, publicKey: shortKey },
        { ...good, publicKey: 12 },
      ];
      for (const body of bodies) {
        const res = await postSelfMap(gw, 1, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_body' });
      }
      expect(await isMapped(1)).toBe(false);
    });

    it('a malformed timestamp or signature → 400 invalid_body', async () => {
      const good = sign();
      const bodies: unknown[] = [
        { ...good, timestamp: String(good.timestamp) },
        { ...good, timestamp: good.timestamp + 0.5 },
        { ...good, timestamp: 2 ** 60 },
        { ...good, signature: '!!!not base64!!!' },
        { ...good, signature: Buffer.alloc(100, 1).toString('base64') }, // valid base64, 136 chars: past the 128-char cap
        { ...good, signature: 5 },
        { ...good, signature: undefined },
      ];
      for (const body of bodies) {
        const res = await postSelfMap(gw, 1, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_body' });
      }
      expect(await isMapped(1)).toBe(false);
    });

    it('a body that is not a JSON object or array → 400 invalid_json', async () => {
      for (const raw of ['{nope', 'null', '"a string"']) {
        const res = await fetch(`${gw.baseUrl}/services/1/map`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        });
        expect(res.status, raw).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_json' });
      }
    });
  });

  describe('check order', () => {
    it('the body shape runs before the service lookup (malformed body + unknown service → 400)', async () => {
      const res = await postSelfMap(gw, 999, { ...sign({ serviceId: 999 }), signature: 5 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
      expect((await postSelfMap(gw, 999, {})).status).toBe(400);
    });

    it('the service lookup runs before the freshness check (unknown service + stale → 404)', async () => {
      const res = await postSelfMap(gw, 999, sign({ serviceId: 999, timestamp: Date.now() - 10 * SELF_MAP_WINDOW_MS }));
      expect(res.status).toBe(404);
    });

    it('freshness runs before the signature (stale + bad signature → 400)', async () => {
      const stale = sign({ timestamp: Date.now() - 10 * SELF_MAP_WINDOW_MS });
      const res = await postSelfMap(gw, 1, { ...stale, signature: sign().signature });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'stale_timestamp' });
    });

    it('the signature runs before the ownership check (bad signature by a stranger → 401)', async () => {
      const res = await postSelfMap(gw, 1, { ...sign({ key: strangerKey, accountId: STRANGER }), signature: sign().signature });
      expect(res.status).toBe(401);
    });

    it('ownership runs before the key lookup (a stranger does not trigger a chain call)', async () => {
      gw.fake.keyLookupFailure = new Error('chain down');
      const res = await postSelfMap(gw, 1, sign({ key: strangerKey, accountId: STRANGER }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_service_owner' });
    });

    it('the key lookup runs before the replay guard (function-call key at an old timestamp → 403)', async () => {
      const t = Date.now();
      expect((await postSelfMap(gw, 1, sign({ timestamp: t }))).status).toBe(204);
      const res = await postSelfMap(gw, 1, sign({ key: fnCallKey, timestamp: t - 1 }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'key_not_full_access' });
    });

    it('the replay guard runs before the SSRF check (old timestamp + forbidden URL → 409)', async () => {
      const t = Date.now();
      expect((await postSelfMap(gw, 1, sign({ timestamp: t }))).status).toBe(204);
      const res = await postSelfMap(gw, 1, sign({ upstreamUrl: 'ftp://example.com/x', timestamp: t - 1 }));
      expect(res.status).toBe(409);
    });
  });

  describe('concurrency and persistence', () => {
    it('two or more concurrent identical requests: exactly one 204, the rest 409 replayed', async () => {
      // Hold every request at the key lookup so all of them are in flight past the cheap checks together.
      const real = gw.fake.isFullAccessKey.bind(gw.fake);
      gw.fake.isFullAccessKey = async (accountId, publicKey) => {
        await sleep(30);
        return real(accountId, publicKey);
      };
      const body = sign();
      const results = await Promise.all([postSelfMap(gw, 1, body), postSelfMap(gw, 1, body), postSelfMap(gw, 1, body)]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409, 409]);
    });

    it('a persist failure is a 500 and the guard moves with the in-memory mapping: the same body is then 409', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'agentgate-selfmap-'));
      const blocker = path.join(dir, 'state'); // the upstreams file will live inside this directory
      const broken = await bootGateway({ fake: gw.fake, upstreamsFile: path.join(blocker, 'upstreams.json') });
      try {
        // A regular file where the directory should be makes every later write fail (even for root).
        writeFileSync(blocker, 'not a directory');
        const t = Date.now();
        const body = sign({ timestamp: t });
        const first = await postSelfMap(broken, 1, body);
        expect(first.status).toBe(500);
        expect(await first.json()).toEqual({ error: 'internal_error' });

        // The store updates memory before it persists, so the gateway IS serving the new URL: the guard
        // must say the same thing, or the failed request could be replayed against a mapping it already changed.
        expect((await fetch(`${broken.baseUrl}/svc/1`)).status).toBe(402);
        const replay = await postSelfMap(broken, 1, body);
        expect(replay.status).toBe(409);
        expect(await replay.json()).toEqual({ error: 'replayed' });

        // Recovery: fix the disk, re-sign with a newer timestamp.
        await rm(blocker);
        expect((await postSelfMap(broken, 1, sign({ timestamp: t + 1 }))).status).toBe(204);
        expect(JSON.parse(readFileSync(broken.upstreamsFile, 'utf8'))).toEqual({ '1': target() });
      } finally {
        await broken.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('chain trouble', () => {
    it('an unreachable chain on the key lookup → 503, never 204, and nothing is mapped', async () => {
      gw.fake.keyLookupFailure = new AgentGateError('devnet_unreachable', 'devnet request failed', 502);
      const body = sign();
      const res = await postSelfMap(gw, 1, body);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain_unavailable' });
      expect(await isMapped(1)).toBe(false);

      // The failed attempt did not advance the replay guard: the same signed request works once the chain is back.
      gw.fake.keyLookupFailure = null;
      expect((await postSelfMap(gw, 1, body)).status).toBe(204);
    });

    it('fails closed: any answer other than a literal true is a refusal', async () => {
      for (const answer of ['yes', 1, {}, null, undefined, 'true']) {
        gw.fake.isFullAccessKey = () => Promise.resolve(answer as unknown as boolean);
        const res = await postSelfMap(gw, 1, sign({ timestamp: Date.now() }));
        expect(res.status, JSON.stringify(answer)).toBe(403);
        expect(await res.json()).toEqual({ error: 'key_not_full_access' });
      }
      expect(await isMapped(1)).toBe(false);
    });

    it('a contract rejection on the key lookup is also a 503, not a verdict on the key', async () => {
      gw.fake.keyLookupFailure = new AgentGateError('ERR_INVALID_ACCOUNT_ID', 'ERR_INVALID_ACCOUNT_ID: bad id', 400);
      const res = await postSelfMap(gw, 1, sign());
      expect(res.status).toBe(503);
    });
  });
});
