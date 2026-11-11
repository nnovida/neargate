import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { verifyNearSignature } from '@agentgate/chain';
import { buildSelfMapMessage, isBase64 } from '@agentgate/shared';
import type { AnySigner, ChainClient, NearKeySigner, RegisterServiceInput } from '@agentgate/shared';
import { wrapService } from '../src/index';

const SELLER = 'seller.testnet';
const UPSTREAM = 'https://api.example.com/gold';
const REGISTER_TX = 'F'.repeat(44);

let dir: string;
let key: { secretKey: string; publicKey: string };
let keyPath: string;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

interface LiveFakeChain extends ChainClient {
  order: string[];
  registered: Array<{ input: RegisterServiceInput; signer: AnySigner }>;
}

/** A live-network ChainClient fake: wrapService only checks the payment target and registers. */
function liveChain(opts: { targetExists?: boolean } = {}): LiveFakeChain {
  const order: string[] = [];
  const registered: LiveFakeChain['registered'] = [];
  return {
    network: 'near-testnet',
    registryId: 'registry.testnet',
    order,
    registered,
    accountExists: vi.fn(async (accountId: string) => {
      order.push(`accountExists:${accountId}`);
      return opts.targetExists ?? true;
    }),
    registerService: vi.fn(async (input: RegisterServiceInput, signer: AnySigner) => {
      order.push('register');
      registered.push({ input, signer });
      return { serviceId: 9, txHash: REGISTER_TX };
    }),
  } as unknown as LiveFakeChain;
}

function capturingFetch(status = 204) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : 'gateway says no', { status });
  };
  return { impl, calls };
}

function liveOpts(chain: ChainClient, signer: AnySigner, fetchImpl: (u: string, i?: RequestInit) => Promise<Response>) {
  return {
    upstreamUrl: UPSTREAM,
    priceNear: '0.5',
    name: 'Gold',
    gateway: 'https://gw.example/',
    chain,
    signer,
    mode: 'live' as const,
    nearNetwork: 'testnet' as const,
    fetchImpl,
  };
}

function printed(): string {
  return [...consoleErrorSpy.mock.calls, ...stderrSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'neargate-wrap-'));
  vi.stubEnv('HOME', dir); // no stray ~/.near-credentials lookups outside the temp dir
  const keyPair = KeyPair.fromRandom('ed25519');
  key = { secretKey: keyPair.toString(), publicKey: keyPair.getPublicKey().toString() };
  keyPath = join(dir, `${SELLER}.json`);
  await writeFile(keyPath, JSON.stringify({ account_id: SELLER, public_key: key.publicKey, private_key: key.secretKey }));
  await chmod(keyPath, 0o600);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  consoleErrorSpy.mockRestore();
  stderrSpy.mockRestore();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('wrapService in live mode: NEAR-key self-map', () => {
  it('maps via POST <gateway>/services/<id>/map with a base64 ed25519 signature, no admin token', async () => {
    const chain = liveChain();
    const { impl, calls } = capturingFetch();
    const signer: NearKeySigner = { kind: 'near', accountId: SELLER, keyPath };

    const before = Date.now();
    const result = await wrapService(liveOpts(chain, signer, impl));

    expect(result).toMatchObject({ serviceId: 9, txHash: REGISTER_TX, adminOk: true, publicUrl: 'https://gw.example/svc/9' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://gw.example/services/9/map');
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');

    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accountId', 'publicKey', 'signature', 'timestamp', 'upstreamUrl']);
    expect(body).toMatchObject({ upstreamUrl: UPSTREAM, accountId: SELLER, publicKey: key.publicKey });
    expect(typeof body['timestamp']).toBe('number');
    expect(body['timestamp'] as number).toBeGreaterThanOrEqual(before);
    expect(isBase64(body['signature'])).toBe(true);
    expect(Buffer.from(body['signature'] as string, 'base64')).toHaveLength(64);

    // the signature covers the canonical self-map message for this network + service
    const message = buildSelfMapMessage({
      network: 'near-testnet',
      serviceId: 9,
      upstreamUrl: UPSTREAM,
      timestamp: body['timestamp'] as number,
    });
    expect(verifyNearSignature(key.publicKey, message, body['signature'] as string)).toBe(true);
    const otherService = buildSelfMapMessage({
      network: 'near-testnet',
      serviceId: 10,
      upstreamUrl: UPSTREAM,
      timestamp: body['timestamp'] as number,
    });
    expect(verifyNearSignature(key.publicKey, otherService, body['signature'] as string)).toBe(false);

    // registered with the resolved key source, after the payment-target check
    expect(chain.registered[0]!.signer).toEqual({ kind: 'near', accountId: SELLER, keyPath });
    expect(chain.order).toEqual([`accountExists:${SELLER}`, 'register']);
    expect(printed()).not.toContain(key.secretKey);
  });

  it('checks it can sign BEFORE registering: an unreadable key file registers nothing', async () => {
    const chain = liveChain();
    const { impl, calls } = capturingFetch();
    const signer: NearKeySigner = { kind: 'near', accountId: SELLER, keyPath: join(dir, 'missing.json') };

    await expect(wrapService(liveOpts(chain, signer, impl))).rejects.toMatchObject({ code: 'SIGNER_KEY_UNREADABLE' });
    expect(chain.registered).toHaveLength(0);
    expect(chain.order).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refuses a payment target that does not exist on chain (ACCOUNT_NOT_FOUND) before registering', async () => {
    const chain = liveChain({ targetExists: false });
    const { impl, calls } = capturingFetch();
    const signer: NearKeySigner = { kind: 'near', accountId: SELLER, keyPath };

    const err = await wrapService({ ...liveOpts(chain, signer, impl), paymentTarget: 'typo-target.testnet' }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect((err as Error).message).toContain('typo-target.testnet');
    expect(chain.order).toEqual(['accountExists:typo-target.testnet']);
    expect(chain.registered).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('a failed mapping keeps the registration and never prints the key', async () => {
    const chain = liveChain();
    const { impl } = capturingFetch(401);
    const signer: NearKeySigner = { kind: 'near', accountId: SELLER, secretKey: key.secretKey };

    const result = await wrapService(liveOpts(chain, signer, impl));

    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('HTTP 401');
    expect(result.adminWarning).toContain('NOT rolled back');
    expect(result.adminWarning).not.toContain('AGENTGATE_ADMIN_TOKEN');
    expect(result.adminWarning).not.toContain(key.secretKey);
    expect(printed()).not.toContain(key.secretKey);
    expect(chain.registered).toHaveLength(1);
    // the retry is `neargate map` (the key came from *_PRIVATE_KEY, so no --key-file to repeat)
    expect(result.adminWarning).toContain(`neargate map 9 '${UPSTREAM}' --account ${SELLER} --registry registry.testnet`);
    expect(result.adminWarning).not.toContain('--key-file');
  });

  it('a failed mapping names the exact `neargate map` retry, with the key file, and says not to re-wrap', async () => {
    const chain = liveChain();
    const { impl } = capturingFetch(503);
    const signer: NearKeySigner = { kind: 'near', accountId: SELLER, keyPath };

    const result = await wrapService(liveOpts(chain, signer, impl));

    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('HTTP 503');
    expect(result.adminWarning).toContain('answers 503 until the mapping exists');
    expect(result.adminWarning).toContain(
      `neargate map 9 '${UPSTREAM}' --account ${SELLER} --key-file '${keyPath}' --registry registry.testnet`,
    );
    expect(result.adminWarning).toContain('do NOT re-run `wrap`');
  });

  it('never follows a redirect on the self-map POST (the signed body stays on the registered gateway)', async () => {
    const chain = liveChain();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    };

    const result = await wrapService(liveOpts(chain, { kind: 'near', accountId: SELLER, keyPath }, impl));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('HTTP 307');
    expect(result.adminWarning).toContain('redirect');
  });
});
