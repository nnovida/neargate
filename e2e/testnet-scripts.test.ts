/**
 * e2e/testnet-scripts.test.ts — the testnet seed and smoke scripts, run in-process against the
 * offline mock stack (devnet + oracle fixture + gateway). The scripts take their chain,
 * signers and gateway URL as options, so the very code that runs on testnet runs here:
 * register → map → 402 → pay → serve → poll the gateway receipt → attestation tx → score.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainHttpClient, TxTimeoutError } from '@agentgate/chain';
import { PaidNotServedError } from '@agentgate/client';
import { createDemoAccounts } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  isNearTxHash,
  loadConfig,
  nativeNearOption,
  type AgentGateConfig,
  type AnySigner,
  type ChainClient,
  type Logger,
  type ServiceRecord,
} from '@agentgate/shared';
import {
  describeSeedFailure,
  resolveGatewayGuard,
  runSeed,
  type SeedOptions,
  type SeedProgress,
} from '../scripts/near/seed-testnet';
import { loadDotenv } from '../scripts/near/dotenv';
import { runSmoke } from '../scripts/near/smoke-live';

interface Running {
  port: number;
  close(): Promise<void>;
}

const EXPLORER = 'https://explorer.test';
const TX_LINK = new RegExp(`^  ${EXPLORER}/txns/(\\S+)$`);

/** The servers' logs are not what these tests are about. */
const quiet: Logger = {
  name: 'test',
  level: 'error',
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

function tmpFile(tag: string): string {
  return path.join(os.tmpdir(), `neargate-scripts-${tag}-${process.pid}-${Date.now()}.json`);
}

/** A mock stack: devnet, oracle fixture, gateway on ephemeral ports. */
async function bootStack(tag: string): Promise<{
  chain: MockChainHttpClient;
  config: AgentGateConfig;
  gatewayUrl: string;
  feedUrl: string;
  seller: AnySigner;
  buyer: AnySigner;
  stop(): Promise<void>;
}> {
  const base = loadConfig({});
  const devnet: Running = await startDevnet({ port: 0, config: base, logger: quiet });
  const devnetUrl = `http://127.0.0.1:${devnet.port}`;
  const config = { ...base, devnetUrl, oracleStatic: true };
  const oracle: Running = await startOracle({ port: 0, config, logger: quiet });
  const chain = new MockChainHttpClient(devnetUrl);
  const upstreamsFile = tmpFile(tag);
  const gateway: Running = await startMiddleware({
    port: 0,
    config,
    chain,
    logger: quiet,
    upstreamsFile,
    attestationRetryDelayMs: 100,
    invoiceStorePath: '',
    attestationQueuePath: '',
  });
  const accounts = await createDemoAccounts({ devnetUrl });
  return {
    chain,
    config,
    gatewayUrl: `http://127.0.0.1:${gateway.port}`,
    feedUrl: `http://127.0.0.1:${oracle.port}/feed`,
    seller: { kind: 'mock', accountId: accounts.seller.accountId },
    buyer: { kind: 'mock', accountId: accounts.buyer.accountId },
    async stop() {
      await gateway.close().catch(() => undefined);
      await oracle.close().catch(() => undefined);
      await devnet.close().catch(() => undefined);
      await rm(upstreamsFile, { force: true }).catch(() => undefined);
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ...(e.code !== undefined ? { code: e.code } : {}), message: e.message ?? String(err) };
  }
  throw new Error('expected the promise to reject');
}

describe('seed-testnet + smoke-live against the mock stack', () => {
  let stack: Awaited<ReturnType<typeof bootStack>>;
  const seedLog: string[] = [];

  beforeAll(async () => {
    stack = await bootStack('main');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('the smoke test passes on an empty registry as a list-only check, and fails when a service was asked for by id', async () => {
    const empty = await bootStack('empty');
    try {
      const lines: string[] = [];
      const result = await runSmoke({
        chain: empty.chain,
        serviceId: 1,
        allowEmptyRegistry: true,
        rejectPrivateHosts: false,
        log: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ services: 0, checked: false });
      expect(lines.join('\n')).toContain('list: 0 service(s)');
      expect(lines.join('\n')).toContain('no service registered yet');

      const named = await rejection(
        runSmoke({
          chain: empty.chain,
          serviceId: 1,
          allowEmptyRegistry: false,
          rejectPrivateHosts: false,
          log: () => undefined,
        }),
      );
      expect(named.code).toBe('SERVICE_NOT_FOUND');
    } finally {
      await empty.stop();
    }
  });

  it('seeds: registers service #1, buys one call, waits for the gateway receipt and prints the whole triple', async () => {
    const result = await runSeed({
      chain: stack.chain,
      seller: stack.seller,
      buyer: stack.buyer,
      attestor: stack.seller.accountId,
      gatewayUrl: stack.gatewayUrl,
      upstreamUrl: stack.feedUrl,
      priceNear: '0.01',
      mode: 'mock',
      nearNetwork: 'testnet',
      explorerUrl: EXPLORER,
      adminToken: stack.config.adminToken,
      allowLocalGateway: false,
      attestationTimeoutMs: 10_000,
      pollIntervalMs: 20,
      log: (line) => seedLog.push(line),
    });

    const registered = seedLog.find((l) => l.startsWith('registered service #'));
    expect(registered).toBe('registered service #1');
    const paid = /^paid: tx (\S+)$/.exec(seedLog.find((l) => l.startsWith('paid: tx')) ?? '');
    const attested = /^attested: tx (\S+)$/.exec(seedLog.find((l) => l.startsWith('attested: tx')) ?? '');
    expect(paid, seedLog.join('\n')).not.toBeNull();
    expect(attested, seedLog.join('\n')).not.toBeNull();
    expect(isNearTxHash(paid![1])).toBe(true);
    expect(isNearTxHash(attested![1])).toBe(true);
    expect(attested![1]).not.toBe(paid![1]);
    expect(seedLog).toContain('score 1/1');

    // every tx line is followed by its explorer link, in the order register, pay, attest
    const links = seedLog.map((l) => TX_LINK.exec(l)?.[1]).filter((h): h is string => h !== undefined);
    expect(links).toEqual([result.registerTxHash, paid![1], attested![1]]);

    // the tx the receipt named is the attestation the registry really holds
    const activity = await stack.chain.listRecentActivity(50);
    const event = activity.find((e) => e.kind === 'attestation' && e.paymentTxHash === paid![1]);
    expect(event?.txHash).toBe(attested![1]);

    expect(result).toMatchObject({
      serviceId: 1,
      paymentTxHash: paid![1],
      attestationTxHash: attested![1],
      score: { successCalls: 1, totalCalls: 1 },
    });
    // the registry records the gateway as the service's endpoint and the buyer was not the seller
    expect((await stack.chain.getService(1))?.endpointUrl).toBe(`${stack.gatewayUrl}/svc/1`);
  });

  it('smoke: list, status 1 and one 402 invoice from the gateway; pays nothing', async () => {
    const before = await stack.chain.getBalance(stack.buyer.accountId);
    const lines: string[] = [];
    const result = await runSmoke({
      chain: stack.chain,
      serviceId: 1,
      allowEmptyRegistry: false,
      rejectPrivateHosts: false,
      log: (line) => lines.push(line),
    });
    const text = lines.join('\n');
    expect(result).toMatchObject({ services: 1, checked: true });
    expect(text).toContain('list: 1 service(s)');
    expect(text).toMatch(/status #1: .*score 1\/1/);
    expect(text).toContain(`402 invoice: 0.01 NEAR + 0.002 NEAR storage from ${stack.gatewayUrl}/svc/1`);
    expect(lines.at(-1)).toBe('smoke ok');
    expect(await stack.chain.getBalance(stack.buyer.accountId)).toBe(before);
  });

  it('smoke: a gateway override replaces the registered gateway for the invoice request', async () => {
    const lines: string[] = [];
    await runSmoke({
      chain: stack.chain,
      serviceId: 1,
      gatewayUrl: `${stack.gatewayUrl}/`,
      allowEmptyRegistry: false,
      rejectPrivateHosts: false,
      log: (line) => lines.push(line),
    });
    expect(lines.join('\n')).toContain(`from ${stack.gatewayUrl}/svc/1`);
  });

  it('smoke: fails when the gateway does not answer with a 402 invoice (here: the service is not mapped)', async () => {
    const { serviceId } = await stack.chain.registerService(
      {
        name: 'Unmapped',
        description: 'registered, never mapped at the gateway',
        gatewayBaseUrl: stack.gatewayUrl,
        priceYocto: '10000000000000000000000',
        paymentTarget: stack.seller.accountId,
        attestor: stack.seller.accountId,
      },
      stack.seller,
    );
    const failed = await rejection(
      runSmoke({
        chain: stack.chain,
        serviceId,
        allowEmptyRegistry: false,
        rejectPrivateHosts: false,
        log: () => undefined,
      }),
    );
    expect(failed.code).toBe('SMOKE_FAILED');
    expect(failed.message).toContain('503');
  });

  it('smoke: does not read an endless answer from the gateway (BODY_TOO_LARGE)', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
            if (pulls >= 10_000) controller.close();
          },
        }),
        { status: 402 },
      )) as unknown as typeof fetch;
    const refused = await rejection(
      runSmoke({
        chain: stack.chain,
        serviceId: 1,
        allowEmptyRegistry: false,
        rejectPrivateHosts: false,
        fetchImpl,
        log: () => undefined,
      }),
    );
    expect(refused.code).toBe('BODY_TOO_LARGE');
    expect(pulls).toBeLessThan(40);
  });

  it('smoke: keeps the private-host guard on unless told otherwise', async () => {
    const refused = await rejection(
      runSmoke({
        chain: stack.chain,
        serviceId: 1,
        allowEmptyRegistry: false,
        rejectPrivateHosts: true,
        log: () => undefined,
      }),
    );
    expect(refused.code).toBe('FORBIDDEN_HOST');
  });
});

describe('seed gateway guard (ruling R42)', () => {
  it('a loopback or private gateway is refused on a live network', async () => {
    for (const url of ['http://127.0.0.1:4021', 'http://localhost:4021', 'http://10.0.0.5:4021']) {
      const refused = await rejection(
        resolveGatewayGuard({ gatewayUrl: url, network: 'near-testnet', allowLocalGateway: false }),
      );
      expect(refused.code, url).toBe('SEED_GATEWAY_LOCAL');
      expect(refused.message).toContain('SEED_ALLOW_LOCAL_GATEWAY=1');
    }
  });

  it('SEED_ALLOW_LOCAL_GATEWAY=1 lifts the guard for that gateway only, with a warning', async () => {
    const verdict = await resolveGatewayGuard({
      gatewayUrl: 'http://127.0.0.1:4021',
      network: 'near-testnet',
      allowLocalGateway: true,
    });
    expect(verdict.rejectPrivateHosts).toBe(false);
    expect(verdict.warning).toMatch(/dev-only/i);
  });

  it('a public gateway keeps the guard on even when the escape hatch is set', async () => {
    const verdict = await resolveGatewayGuard({
      gatewayUrl: 'https://1.1.1.1',
      network: 'near-testnet',
      allowLocalGateway: true,
    });
    expect(verdict).toEqual({ rejectPrivateHosts: true });
  });

  it('the offline mock network needs no guard', async () => {
    expect(
      await resolveGatewayGuard({ gatewayUrl: 'http://127.0.0.1:4021', network: 'near-mock', allowLocalGateway: false }),
    ).toEqual({ rejectPrivateHosts: false });
  });

  it('a malformed gateway URL is refused as such, not as a local one', async () => {
    const refused = await rejection(
      resolveGatewayGuard({ gatewayUrl: 'not a url', network: 'near-testnet', allowLocalGateway: true }),
    );
    expect(refused.code).toBe('BAD_URL');
  });

  it('runSeed refuses a loopback gateway on a live network before it sends anything', async () => {
    const sent: string[] = [];
    const chain = {
      network: 'near-testnet',
      registryId: 'registry.testnet',
      registerService: async () => {
        sent.push('registerService');
        throw new Error('must not be reached');
      },
      pay: async () => {
        sent.push('pay');
        throw new Error('must not be reached');
      },
    } as unknown as ChainClient;
    const refused = await rejection(
      runSeed({
        chain,
        seller: { kind: 'near', accountId: 'seller.testnet' },
        buyer: { kind: 'near', accountId: 'buyer.testnet' },
        attestor: 'gateway.testnet',
        gatewayUrl: 'http://127.0.0.1:4021',
        upstreamUrl: 'https://open.er-api.com/v6/latest/USD',
        priceNear: '0.01',
        mode: 'live',
        nearNetwork: 'testnet',
        explorerUrl: EXPLORER,
        allowLocalGateway: false,
        log: () => undefined,
      }),
    );
    expect(refused.code).toBe('SEED_GATEWAY_LOCAL');
    expect(sent).toEqual([]);
  });

  it('runSeed refuses a buyer that is the seller (a self-paid call is never attested) before it sends anything', async () => {
    const refused = await rejection(
      runSeed({
        chain: { network: 'near-mock', registryId: 'registry.mock' } as unknown as ChainClient,
        seller: { kind: 'mock', accountId: 'same.mock' },
        buyer: { kind: 'mock', accountId: 'same.mock' },
        attestor: 'gateway.mock',
        gatewayUrl: 'http://127.0.0.1:4021',
        upstreamUrl: 'http://127.0.0.1:1/feed',
        priceNear: '0.01',
        mode: 'mock',
        nearNetwork: 'testnet',
        explorerUrl: EXPLORER,
        allowLocalGateway: false,
        log: () => undefined,
      }),
    );
    expect(refused.code).toBe('SEED_SELF_PAYMENT');
  });
});

describe('loadDotenv', () => {
  it('reads KEY=VALUE lines, skips comments, strips quotes, and lets the shell environment win', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'neargate-dotenv-'));
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      [
        '# a comment line',
        'NEARGATE_TEST_PLAIN=plain',
        'NEARGATE_TEST_QUOTED="with spaces"',
        "NEARGATE_TEST_SINGLE='single'",
        'NEARGATE_TEST_EMPTY=',
        'NEARGATE_TEST_SHELL=from the file',
        'not a variable line',
      ].join('\n'),
    );
    process.env['NEARGATE_TEST_SHELL'] = 'from the shell';
    try {
      loadDotenv(file);
      expect(process.env['NEARGATE_TEST_PLAIN']).toBe('plain');
      expect(process.env['NEARGATE_TEST_QUOTED']).toBe('with spaces');
      expect(process.env['NEARGATE_TEST_SINGLE']).toBe('single');
      expect(process.env['NEARGATE_TEST_EMPTY']).toBe('');
      expect(process.env['NEARGATE_TEST_SHELL']).toBe('from the shell');
      expect(() => loadDotenv(path.join(dir, 'missing.env'))).not.toThrow();
    } finally {
      for (const key of ['PLAIN', 'QUOTED', 'SINGLE', 'EMPTY', 'SHELL']) delete process.env[`NEARGATE_TEST_${key}`];
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * runSeed against a live-shaped STUB: a testnet chain client and a gateway whose HTTP is a fetch
 * stub (public IP-literal gateway, so no DNS and no socket). Reaches the paths the mock stack
 * cannot: the mapping retry (a near signer), a paid call that is not served, and the unknown
 * outcome of a sent transaction.
 */
describe('seed on a live-shaped stub', () => {
  const REGISTER_TX = 'F'.repeat(44);
  const PAY_TX = 'D'.repeat(44);
  const ATTEST_TX = 'E'.repeat(44);
  const NONCE = '424242';
  const GATEWAY = 'https://1.1.1.1';
  const PRICE = '10000000000000000000000'; // 0.01 NEAR
  const FEE = '2000000000000000000000'; // 0.002 NEAR

  interface Script {
    /** HTTP status of each POST /services/1/map, in order (default 204 once they run out). */
    mapStatuses?: number[];
    /** The unpaid GET answers 200 instead of a 402 invoice. */
    free?: boolean;
    /** Status of the GET that carries the payment proof. */
    paidStatus?: number;
    /** Receipt body (null = 404). */
    receipt?: unknown;
    registerError?: Error;
    payError?: Error;
  }

  function stub(script: Script = {}) {
    const sent: string[] = [];
    const posts: string[] = [];
    const service: ServiceRecord = {
      id: 1,
      name: 'USD exchange rates',
      description: 'seed',
      endpointUrl: `${GATEWAY}/svc/1`,
      priceYocto: PRICE,
      paymentTarget: 'seller.testnet',
      owner: 'seller.testnet',
      attestor: 'gateway.testnet',
      active: true,
      createdAt: 1,
      accepts: [nativeNearOption(PRICE)],
    };
    const chain = {
      network: 'near-testnet',
      registryId: 'registry.testnet',
      accountExists: async () => true,
      getService: async () => service,
      getScore: async () => ({ totalCalls: 1, successCalls: 1 }),
      registerService: async () => {
        sent.push('registerService');
        if (script.registerError) throw script.registerError;
        return { serviceId: 1, txHash: REGISTER_TX };
      },
      pay: async () => {
        sent.push('pay');
        if (script.payError) throw script.payError;
        return { txHash: PAY_TX };
      },
    } as unknown as ChainClient;
    const mapStatuses = [...(script.mapStatuses ?? [])];
    const invoice = Response.json(
      {
        x402Version: 1,
        error: 'X-PAYMENT header is required',
        accepts: [
          {
            scheme: 'exact',
            network: 'near-testnet',
            maxAmountRequired: '12000000000000000000000',
            asset: 'NEAR',
            payTo: 'registry.testnet',
            resource: `${GATEWAY}/svc/1`,
            description: 'seed',
            maxTimeoutSeconds: 300,
            extra: {
              nonce: NONCE,
              serviceId: 1,
              expiresAtMs: Date.now() + 300_000,
              settlement: 'neargate-registry-pay',
              contractId: 'registry.testnet',
              method: 'pay',
              priceYocto: PRICE,
              storageFeeYocto: FEE,
              seller: 'seller.testnet',
              caip2: 'near:testnet',
            },
          },
        ],
      },
      { status: 402 },
    );
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === `${GATEWAY}/services/1/map`) {
        posts.push(url);
        const status = mapStatuses.shift() ?? 204;
        return new Response(status === 204 ? null : 'gateway down', { status });
      }
      if (url === `${GATEWAY}/svc/1`) {
        if (script.free) return Response.json({ free: true });
        if (!new Headers(init?.headers).has('X-PAYMENT')) return invoice.clone();
        return Response.json({ rates: {} }, { status: script.paidStatus ?? 200 });
      }
      if (url === `${GATEWAY}/receipts/${NONCE}`) {
        if (script.receipt === null) return Response.json({ error: 'receipt_not_found' }, { status: 404 });
        return Response.json(
          script.receipt ?? {
            nonce: NONCE,
            serviceId: 1,
            paymentTxHash: PAY_TX,
            attestation: { status: 'recorded', txHash: ATTEST_TX },
          },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    return { chain, fetchImpl, sent, posts };
  }

  function seedOptions(
    s: ReturnType<typeof stub>,
    progress: SeedProgress,
    log: string[],
  ): SeedOptions {
    return {
      chain: s.chain,
      seller: { kind: 'near', accountId: 'seller.testnet', secretKey: KeyPair.fromRandom('ed25519').toString() },
      buyer: { kind: 'near', accountId: 'buyer.testnet' },
      attestor: 'gateway.testnet',
      gatewayUrl: GATEWAY,
      upstreamUrl: 'https://open.er-api.com/v6/latest/USD',
      priceNear: '0.01',
      mode: 'live',
      nearNetwork: 'testnet',
      explorerUrl: EXPLORER,
      allowLocalGateway: false,
      fetchImpl: s.fetchImpl,
      settleDelayMs: 0,
      mappingRetryDelayMs: 1,
      attestationTimeoutMs: 300,
      pollIntervalMs: 5,
      progress,
      log: (line) => log.push(line),
    };
  }

  /** wrapService prints its own mapping warning to stderr; keep the test output clean. */
  async function quietly<T>(run: () => Promise<T>): Promise<T> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      return await run();
    } finally {
      spy.mockRestore();
    }
  }

  it('the happy path on the stub prints the whole triple (the harness itself works)', async () => {
    const s = stub();
    const log: string[] = [];
    const progress: SeedProgress = {};
    const result = await runSeed(seedOptions(s, progress, log));
    expect(result).toMatchObject({ serviceId: 1, registerTxHash: REGISTER_TX, paymentTxHash: PAY_TX, attestationTxHash: ATTEST_TX });
    expect(log).toContain('registered service #1');
    expect(log).toContain(`paid: tx ${PAY_TX}`);
    expect(log).toContain(`attested: tx ${ATTEST_TX}`);
    expect(progress).toEqual({ serviceId: 1, registerTxHash: REGISTER_TX, paymentTxHash: PAY_TX });
    expect(s.sent).toEqual(['registerService', 'pay']);
  });

  it('retryMapping: a mapping that failed after registration is retried (and only the mapping), then the run goes on', async () => {
    const s = stub({ mapStatuses: [503, 503, 204] }); // wrap's own POST, then retry 1 fails, retry 2 maps it
    const log: string[] = [];
    const result = await quietly(() => runSeed(seedOptions(s, {}, log)));
    expect(result.serviceId).toBe(1);
    expect(s.posts).toHaveLength(3);
    expect(s.sent).toEqual(['registerService', 'pay']); // registered once
    expect(log.filter((l) => l.startsWith('mapping failed'))).toHaveLength(2);
  });

  it('retryMapping: after 3 failed retries it stops with SEED_MAPPING_FAILED, never pays, never registers again', async () => {
    const s = stub({ mapStatuses: [503, 503, 503, 503, 503] });
    const progress: SeedProgress = {};
    const refused = await quietly(() => rejection(runSeed(seedOptions(s, progress, []))));
    expect(refused.code).toBe('SEED_MAPPING_FAILED');
    expect(refused.message).toContain('service #1 is registered but the gateway has not mapped it');
    expect(s.posts).toHaveLength(4); // wrap's POST + 3 retries
    expect(s.sent).toEqual(['registerService']);
    const report = describeSeedFailure(Object.assign(new Error(refused.message), { code: refused.code }), EXPLORER, progress);
    expect(report.lines.join('\n')).toMatch(/service #1 is registered/);
  });

  it('SEED_NOT_PAID: a gateway that answers without asking for payment stops the run before any pay', async () => {
    const s = stub({ free: true });
    const progress: SeedProgress = {};
    const refused = await rejection(runSeed(seedOptions(s, progress, [])));
    expect(refused.code).toBe('SEED_NOT_PAID');
    expect(s.sent).toEqual(['registerService']);
    expect(progress).toEqual({ serviceId: 1, registerTxHash: REGISTER_TX });
  });

  it('SEED_NOT_SERVED: a paid call whose upstream failed stops after the pay, with the payment named', async () => {
    const s = stub({ paidStatus: 500 });
    const log: string[] = [];
    const progress: SeedProgress = {};
    const refused = await rejection(runSeed(seedOptions(s, progress, log)));
    expect(refused.code).toBe('SEED_NOT_SERVED');
    expect(refused.message).toContain(PAY_TX);
    expect(log).toContain(`paid: tx ${PAY_TX}`);
    expect(s.sent).toEqual(['registerService', 'pay']);
    expect(progress.paymentTxHash).toBe(PAY_TX);
  });

  it('a TxTimeoutError from registerService stops at once: explorer link, exit 2, nothing retried, nothing else sent', async () => {
    const timeout = new TxTimeoutError('the NEAR RPC timed out after the register_service tx was sent', REGISTER_TX, EXPLORER);
    const s = stub({ registerError: timeout });
    const progress: SeedProgress = {};
    const err = await runSeed(seedOptions(s, progress, [])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(timeout);
    expect(s.sent).toEqual(['registerService']); // one attempt, no retry, no pay
    const report = describeSeedFailure(err, EXPLORER, progress);
    expect(report.exitCode).toBe(2);
    const text = report.lines.join('\n');
    expect(text).toContain(`${EXPLORER}/txns/${REGISTER_TX}`);
    expect(text).toMatch(/do not retry register_service or pay/i);
    expect(text).not.toMatch(/is registered/); // whether it was registered is exactly what is unknown
  });

  it('a TxTimeoutError from pay stops at once: link, exit 2, the service is named as registered, no second pay', async () => {
    const timeout = new TxTimeoutError('the NEAR RPC timed out after the pay tx was sent', PAY_TX, EXPLORER);
    const s = stub({ payError: timeout });
    const progress: SeedProgress = {};
    const err = await runSeed(seedOptions(s, progress, [])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(timeout);
    expect(s.sent).toEqual(['registerService', 'pay']);
    const report = describeSeedFailure(err, EXPLORER, progress);
    expect(report.exitCode).toBe(2);
    const text = report.lines.join('\n');
    expect(text).toContain(`${EXPLORER}/txns/${PAY_TX}`);
    expect(text).toContain('service #1 is registered');
    expect(text).toMatch(/do not rerun the seed/i);
  });

  it('any failure after the pay names the service and the payment and says not to rerun, whatever its kind', async () => {
    const s = stub({ receipt: null }); // the gateway has no receipt: SEED_NO_RECEIPT
    const progress: SeedProgress = {};
    const err = await runSeed(seedOptions(s, progress, [])).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe('SEED_NO_RECEIPT');
    const report = describeSeedFailure(err, EXPLORER, progress);
    expect(report.exitCode).toBe(1);
    const text = report.lines.join('\n');
    expect(text).toContain('service #1 is registered');
    expect(text).toContain(`${EXPLORER}/txns/${REGISTER_TX}`);
    expect(text).toContain(`paid (tx ${PAY_TX})`);
    expect(text).toContain(`${EXPLORER}/txns/${PAY_TX}`);
    expect(text).toMatch(/do not rerun the seed/i);
    expect(text).toMatch(/do not pay for it again/i);
  });

  it('a failure after the register but before the pay says how to finish by hand', async () => {
    const s = stub({ free: true });
    const progress: SeedProgress = {};
    const err = await runSeed(seedOptions(s, progress, [])).then(
      () => undefined,
      (e: unknown) => e,
    );
    const text = describeSeedFailure(err, EXPLORER, progress).lines.join('\n');
    expect(text).toContain('service #1 is registered');
    expect(text).toMatch(/do not rerun the seed/i);
    expect(text).toContain('neargate -- buy 1');
    expect(text).not.toContain('paid (tx');
  });

  it('a failure before anything was sent adds no state lines', async () => {
    const s = stub();
    const progress: SeedProgress = {};
    const err = await runSeed({ ...seedOptions(s, progress, []), buyer: { kind: 'near', accountId: 'seller.testnet' } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(describeSeedFailure(err, EXPLORER, progress).lines).toHaveLength(1);
    expect(s.sent).toEqual([]);
  });
});

describe('seed failure report', () => {
  const HASH = 'D'.repeat(44);

  it('a sent change call with an unknown outcome stops with its explorer link and exit code 2', () => {
    const err = new TxTimeoutError('the NEAR RPC timed out after the pay tx was sent', HASH, EXPLORER);
    const report = describeSeedFailure(err, EXPLORER);
    expect(report.exitCode).toBe(2);
    const text = report.lines.join('\n');
    expect(text).toContain(`${EXPLORER}/txns/${HASH}`);
    expect(text).toMatch(/do not retry/i);
  });

  it('a paid call that was not served stops with the payment link and the proof to re-present', () => {
    const err = new PaidNotServedError(
      { txHash: HASH, nonce: '424242', serviceId: 1, depositYocto: '12000000000000000000000' },
      'refused',
      402,
      'the gateway refused the proof',
    );
    const report = describeSeedFailure(err, EXPLORER);
    expect(report.exitCode).toBe(1);
    const text = report.lines.join('\n');
    expect(text).toContain(`${EXPLORER}/txns/${HASH}`);
    expect(text).toContain('424242');
    expect(text).toMatch(/do not pay again/i);
  });

  it('any other failure is one line and exit code 1', () => {
    const report = describeSeedFailure(new Error('boom'), EXPLORER);
    expect(report).toEqual({ lines: ['seed failed: boom'], exitCode: 1 });
  });
});
