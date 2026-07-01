import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyAlgorithm, PrivateKey } from 'casper-js-sdk';
import { buildSelfMapMessage } from '@agentgate/shared';
import { bootGateway, startUpstream, type TestGateway, type TestUpstream } from './helpers';

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

interface BodyOverrides {
  serviceId?: number;
  upstreamUrl?: string;
  timestamp?: number;
  publicKeyHex?: string;
  signatureHex?: string;
}

describe('self-service mapping POST /services/:id/map (mock mode)', () => {
  let gw: TestGateway;
  let upstream: TestUpstream;
  let priv: PrivateKey;
  let pubHex: string;

  beforeAll(async () => {
    gw = await bootGateway();
    upstream = await startUpstream();
    priv = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    pubHex = priv.publicKey.toHex();
    const ownerAcct = priv.publicKey.accountHash().toPrefixedString();
    // #1 owned by our test key; #2 owned by someone else.
    gw.fake.addService({ id: 1, name: 'Owned Feed', owner: ownerAcct });
    gw.fake.addService({ id: 2, name: 'Someone Elses', owner: `account-hash-${'bb'.repeat(32)}` });
  });

  afterAll(async () => {
    await gw.close();
    await upstream.close();
  });

  /** Build a well-formed, owner-signed body (fields overridable to force reject paths). */
  function signedBody(o: BodyOverrides = {}): Record<string, unknown> {
    const serviceId = o.serviceId ?? 1;
    const upstreamUrl = o.upstreamUrl ?? `${upstream.url}/data`;
    const timestamp = o.timestamp ?? Date.now();
    const message = buildSelfMapMessage({ network: gw.fake.network, serviceId, upstreamUrl, timestamp });
    const signatureHex = o.signatureHex ?? bytesToHex(priv.signAndAddAlgorithmBytes(message));
    return { upstreamUrl, publicKeyHex: o.publicKeyHex ?? pubHex, timestamp, signatureHex };
  }

  const post = (id: number, body: unknown): Promise<Response> =>
    fetch(`${gw.baseUrl}/services/${id}/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('maps the upstream for a valid owner signature (204), and /svc/1 then serves a 402', async () => {
    const res = await post(1, signedBody());
    expect(res.status).toBe(204);
    const svc = await fetch(`${gw.baseUrl}/svc/1`);
    expect(svc.status).toBe(402); // mapped + active ⇒ payment required (not an unmapped error)
  });

  it('rejects a signature from a non-owner key (403 not_service_owner)', async () => {
    const other = PrivateKey.generate(KeyAlgorithm.ED25519);
    const upstreamUrl = `${upstream.url}/data`;
    const timestamp = Date.now();
    const message = buildSelfMapMessage({ network: gw.fake.network, serviceId: 1, upstreamUrl, timestamp });
    const res = await post(1, {
      upstreamUrl,
      publicKeyHex: other.publicKey.toHex(),
      timestamp,
      signatureHex: bytesToHex(other.signAndAddAlgorithmBytes(message)),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_service_owner' });
  });

  it('rejects a tampered signature (401 invalid_signature)', async () => {
    const body = signedBody();
    const sig = body.signatureHex as string;
    body.signatureHex = sig.slice(0, -2) + (sig.endsWith('00') ? '11' : '00');
    const res = await post(1, body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_signature' });
  });

  it('rejects a stale timestamp (401 stale_request)', async () => {
    const res = await post(1, signedBody({ timestamp: Date.now() - 10 * 60_000 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'stale_request' });
  });

  it('rejects an unknown service (404 service_not_found)', async () => {
    const res = await post(999, signedBody({ serviceId: 999 }));
    expect(res.status).toBe(404);
  });

  it('rejects a replayed (older-or-equal) timestamp (409 replayed)', async () => {
    const ts = Date.now();
    expect((await post(1, signedBody({ timestamp: ts }))).status).toBe(204);
    const replay = await post(1, signedBody({ timestamp: ts }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'replayed' });
  });

  it('rejects a malformed body (400 invalid_body)', async () => {
    const res = await post(1, { upstreamUrl: 'https://x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });
});
