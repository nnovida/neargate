/**
 * e2e/testnet-scripts.test.ts — the testnet seed and smoke scripts, run in-process against the
 * offline mock stack (devnet + oracle fixture + gateway). The scripts take their chain,
 * signers and gateway URL as options, so the very code that runs on testnet runs here:
 * register → map → 402 → pay → serve → poll the gateway receipt → attestation tx → score.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient, TxTimeoutError } from '@agentgate/chain';
import { PaidNotServedError } from '@agentgate/client';
import { createDemoAccounts } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  isNearTxHash,
  loadConfig,
  type AgentGateConfig,
  type AnySigner,
  type ChainClient,
  type Logger,
} from '@agentgate/shared';
import { describeSeedFailure, resolveGatewayGuard, runSeed } from '../scripts/near/seed-testnet';
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
