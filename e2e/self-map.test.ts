/**
 * e2e/self-map.test.ts — the CLI's NEAR-key self-map POST against the REAL gateway route.
 *
 * `wrap` (live, NEAR key signer) and `neargate map` send `POST <gateway>/services/<id>/map`;
 * here that request hits the real middleware (`startServer`) backed by the middleware's
 * in-memory fake chain, so any drift between the fields the CLI sends and the fields the
 * route checks fails a test instead of a seller's first live wrap.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapService, wrapService } from '@neargate/cli';
import type { NearKeySigner } from '@agentgate/shared';
import { bootGateway, startUpstream, type TestGateway, type TestUpstream } from '../packages/middleware/test/helpers';

const SELLER = 'seller.testnet';

interface KeyFile {
  path: string;
  publicKey: string;
}

describe('CLI self-map POST → real gateway route POST /services/:id/map', () => {
  let gw: TestGateway;
  let upstream: TestUpstream;
  let dir: string;
  let ownerKey: KeyFile;

  async function writeKey(name: string): Promise<KeyFile> {
    const keyPair = KeyPair.fromRandom('ed25519');
    const file = path.join(dir, name);
    const publicKey = keyPair.getPublicKey().toString();
    await writeFile(file, JSON.stringify({ account_id: SELLER, public_key: publicKey, private_key: keyPair.toString() }));
    await chmod(file, 0o600);
    return { path: file, publicKey };
  }

  const signer = (key: KeyFile = ownerKey): NearKeySigner => ({ kind: 'near', accountId: SELLER, keyPath: key.path });
  const upstreamUrl = (): string => `${upstream.url}/data`;
  /** 503 = registered but not mapped on this gateway; 402 = mapped (an unpaid call gets the invoice). */
  const svcStatus = async (id: number): Promise<number> => (await fetch(`${gw.baseUrl}/svc/${id}`)).status;

  function wrapOpts(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
    return {
      upstreamUrl: upstreamUrl(),
      priceNear: '0.5',
      name: 'Self-mapped Feed',
      gateway: gw.baseUrl,
      chain: gw.fake,
      signer: signer(),
      mode: 'live' as const,
      nearNetwork: 'testnet' as const,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    };
  }

  beforeEach(async () => {
    // A fresh gateway per test: /services is rate-limited per IP and the replay guard is per gateway.
    gw = await bootGateway();
    upstream = await startUpstream();
    dir = await mkdtemp(path.join(os.tmpdir(), 'neargate-e2e-selfmap-'));
    vi.stubEnv('HOME', dir);
    ownerKey = await writeKey('owner.json');
    gw.fake.addFullAccessKey(SELLER, ownerKey.publicKey);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await gw.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('`wrap` registers and its signed mapping is accepted (204): the service answers 402, not 503', async () => {
    const wrapped = await wrapService(wrapOpts());

    expect(wrapped.adminOk, wrapped.adminWarning).toBe(true);
    expect(gw.fake.services.get(wrapped.serviceId)?.owner).toBe(SELLER);
    expect(await svcStatus(wrapped.serviceId)).toBe(402);
  });

  it('a mapping that failed during `wrap` is retried by `neargate map` — same route, no second registration', async () => {
    const down = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    const wrapped = await wrapService(wrapOpts(down));
    expect(wrapped.adminOk).toBe(false);
    expect(wrapped.adminWarning).toContain(`neargate map ${wrapped.serviceId} '${upstreamUrl()}'`);
    expect(await svcStatus(wrapped.serviceId)).toBe(503);

    const mapped = await mapService({
      serviceId: wrapped.serviceId,
      upstreamUrl: upstreamUrl(),
      chain: gw.fake,
      signer: signer(),
      mode: 'live',
      nearNetwork: 'testnet',
    });

    expect(mapped).toEqual({ serviceId: wrapped.serviceId, gateway: gw.baseUrl, publicUrl: wrapped.publicUrl });
    expect(await svcStatus(wrapped.serviceId)).toBe(402);
    expect(gw.fake.services.size).toBe(1);
  });

  it('a key that is not a full-access key of the owner: the route answers 403 and `map` surfaces it', async () => {
    const wrapped = await wrapService(wrapOpts(async () => new Response(null, { status: 500 })));
    const otherKey = await writeKey('function-call.json');

    const err = await mapService({
      serviceId: wrapped.serviceId,
      upstreamUrl: upstreamUrl(),
      chain: gw.fake,
      signer: signer(otherKey),
      mode: 'live',
      nearNetwork: 'testnet',
    }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'MAPPING_FAILED' });
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as Error).message).toContain('key_not_full_access');
    expect(await svcStatus(wrapped.serviceId)).toBe(503);
  });
});
