import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { verifyNearSignature } from '@agentgate/chain';
import {
  buildSelfMapMessage,
  isBase64,
  nativeNearOption,
  type AnySigner,
  type ChainClient,
  type NearKeySigner,
  type ServiceRecord,
} from '@agentgate/shared';
import { mapService } from '../src/index';

const SELLER = 'seller.testnet';
const UPSTREAM = 'https://api.example.com/gold';
const PRICE = '500000000000000000000000';

let dir: string;
let key: { secretKey: string; publicKey: string };
let keyPath: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function record(over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: 9,
    name: 'Gold',
    description: '',
    endpointUrl: 'https://gw.example/svc/9',
    priceYocto: PRICE,
    paymentTarget: SELLER,
    owner: SELLER,
    attestor: SELLER,
    active: true,
    createdAt: 1_700_000_000_000,
    accepts: [nativeNearOption(PRICE)],
    ...over,
  };
}

/** A ChainClient fake: `map` only reads the service record. */
function chainWith(service: ServiceRecord | null): ChainClient & { reads: number[] } {
  const reads: number[] = [];
  return {
    network: 'near-testnet',
    registryId: 'registry.testnet',
    reads,
    getService: vi.fn(async (id: number) => {
      reads.push(id);
      return service;
    }),
  } as unknown as ChainClient & { reads: number[] };
}

function fakeFetch(respond: () => Response | Promise<Response>): {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

function nearSigner(over: Partial<NearKeySigner> = {}): NearKeySigner {
  return { kind: 'near', accountId: SELLER, keyPath, ...over };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'neargate-map-'));
  vi.stubEnv('HOME', dir);
  const keyPair = KeyPair.fromRandom('ed25519');
  key = { secretKey: keyPair.toString(), publicKey: keyPair.getPublicKey().toString() };
  keyPath = join(dir, `${SELLER}.json`);
  await writeFile(keyPath, JSON.stringify({ account_id: SELLER, public_key: key.publicKey, private_key: key.secretKey }));
  await chmod(keyPath, 0o600);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('mapService (`neargate map <id> <upstream>`): re-runs only the self-map POST of `wrap`', () => {
  it('POSTs the signed self-map request to the gateway the registry records for the service', async () => {
    const chain = chainWith(record());
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));

    const before = Date.now();
    const result = await mapService({ serviceId: 9, upstreamUrl: ` ${UPSTREAM} `, chain, signer: nearSigner(), fetchImpl: impl });

    expect(result).toEqual({ serviceId: 9, gateway: 'https://gw.example', publicUrl: 'https://gw.example/svc/9' });
    expect(chain.reads).toEqual([9]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://gw.example/services/9/map');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.redirect).toBe('manual');
    expect(new Headers(call.init?.headers).get('authorization')).toBeNull();

    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accountId', 'publicKey', 'signature', 'timestamp', 'upstreamUrl']);
    expect(body).toMatchObject({ upstreamUrl: UPSTREAM, accountId: SELLER, publicKey: key.publicKey });
    expect(body['timestamp'] as number).toBeGreaterThanOrEqual(before);
    expect(isBase64(body['signature'])).toBe(true);
    const message = buildSelfMapMessage({
      network: 'near-testnet',
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      timestamp: body['timestamp'] as number,
    });
    expect(verifyNearSignature(key.publicKey, message, body['signature'] as string)).toBe(true);
  });

  it('signs with *_PRIVATE_KEY too, and never prints the key', async () => {
    const chain = chainWith(record());
    const { impl, calls } = fakeFetch(() => new Response('nope', { status: 401 }));

    const err = await mapService({
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      chain,
      signer: { kind: 'near', accountId: SELLER, secretKey: key.secretKey },
      fetchImpl: impl,
    }).catch((e: unknown) => e);

    expect(calls).toHaveLength(1);
    expect(err).toMatchObject({ code: 'MAPPING_FAILED' });
    expect((err as Error).message).toContain('HTTP 401');
    expect((err as Error).message).not.toContain(key.secretKey);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).not.toContain(key.secretKey);
  });

  it('an unknown service → SERVICE_NOT_FOUND, nothing POSTed', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(
      mapService({ serviceId: 9, upstreamUrl: UPSTREAM, chain: chainWith(null), signer: nearSigner(), fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND' });
    expect(calls).toHaveLength(0);
  });

  it('a service owned by another account → NOT_SERVICE_OWNER naming the owner, nothing POSTed', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const err = await mapService({
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      chain: chainWith(record({ owner: 'someone-else.testnet' })),
      signer: nearSigner(),
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NOT_SERVICE_OWNER' });
    expect((err as Error).message).toContain('someone-else.testnet');
    expect(calls).toHaveLength(0);
  });

  it('a mock signer → LIVE_ONLY: mock mode maps through the gateway admin route', async () => {
    const chain = chainWith(record());
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const signer: AnySigner = { kind: 'mock', accountId: 'seller.mock' };
    const err = await mapService({ serviceId: 9, upstreamUrl: UPSTREAM, chain, signer, fetchImpl: impl }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'LIVE_ONLY' });
    expect((err as Error).message).toContain('/admin/services');
    expect(chain.reads).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a gateway refusal → MAPPING_FAILED with the status and the gateway answer', async () => {
    const { impl } = fakeFetch(() => new Response('{"error":"key_not_full_access"}', { status: 403 }));
    const err = await mapService({
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      chain: chainWith(record()),
      signer: nearSigner(),
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MAPPING_FAILED' });
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as Error).message).toContain('key_not_full_access');
  });

  it('a redirect → MAPPING_FAILED; it is never followed', async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/steal' } }),
    );
    const err = await mapService({
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      chain: chainWith(record()),
      signer: nearSigner(),
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MAPPING_FAILED' });
    expect((err as Error).message).toContain('HTTP 302');
    expect((err as Error).message).toContain('redirect');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe('manual');
  });

  it.each([
    ['a network error', new TypeError('fetch failed'), 'fetch failed'],
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'timed out'],
  ])('%s → MAPPING_FAILED', async (_title, thrown, text) => {
    const impl = async (): Promise<Response> => {
      throw thrown;
    };
    const err = await mapService({
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      chain: chainWith(record()),
      signer: nearSigner(),
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'MAPPING_FAILED' });
    expect((err as Error).message).toContain(text);
  });

  it('validates the id, the upstream URL and the key before any chain read', async () => {
    const chain = chainWith(record());
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const base = { upstreamUrl: UPSTREAM, chain, signer: nearSigner(), fetchImpl: impl };

    await expect(mapService({ ...base, serviceId: 0 })).rejects.toMatchObject({ code: 'INVALID_SERVICE_ID' });
    await expect(mapService({ ...base, serviceId: 9, upstreamUrl: 'ftp://files.example/x' })).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
    await expect(
      mapService({ ...base, serviceId: 9, signer: nearSigner({ keyPath: join(dir, 'missing.json') }) }),
    ).rejects.toMatchObject({ code: 'SIGNER_KEY_UNREADABLE' });
    expect(chain.reads).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refuses a registered cleartext non-localhost gateway in live mode (INSECURE_URL), nothing POSTed', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(
      mapService({
        serviceId: 9,
        upstreamUrl: UPSTREAM,
        chain: chainWith(record({ endpointUrl: 'http://gw.example/svc/9' })),
        signer: nearSigner(),
        mode: 'live',
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'INSECURE_URL' });
    expect(calls).toHaveLength(0);
  });
});
