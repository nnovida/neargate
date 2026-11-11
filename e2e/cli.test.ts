/**
 * e2e/cli.test.ts — the real `neargate` bin as a subprocess against in-process mock servers.
 *
 * Boots devnet + oracle (static fixture) + middleware on port 0, wraps the oracle, then runs
 * `node --import tsx packages/cli/src/bin.ts …` with a controlled environment and checks what
 * lands on stdout (the purchased body only) versus stderr (the receipt).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient } from '@agentgate/chain';
import { createDemoAccounts, wrapService } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import { isNearTxHash, loadConfig, type Logger } from '@agentgate/shared';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'packages/cli/src/bin.ts');

interface Running {
  port: number;
  close(): Promise<void>;
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function quietLogger(name = 'e2e-cli'): Logger {
  const noop = (): void => undefined;
  return { name, level: 'error', debug: noop, info: noop, warn: noop, error: noop, child: (n) => quietLogger(`${name}.${n}`) };
}

describe('neargate bin (subprocess, mock mode)', () => {
  const baseConfig = loadConfig({});
  let devnet: Running;
  let oracle: Running;
  let middleware: Running;
  let home: string;
  let upstreamsFile: string;
  let devnetUrl: string;
  let buyerAccount: string;
  let serviceId: number;

  function runCli(args: string[]): Promise<CliRun> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', BIN, ...args],
        {
          cwd: REPO_ROOT,
          // Never inherit the host shell's NearGate settings.
          env: { PATH: process.env['PATH'] ?? '', HOME: home, DEVNET_URL: devnetUrl, MOCK_BUYER_ACCOUNT: buyerAccount },
          timeout: 20_000,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'neargate-e2e-cli-'));
    upstreamsFile = path.join(home, 'upstreams.json');
    devnet = await startDevnet({ port: 0, config: baseConfig, logger: quietLogger() });
    devnetUrl = `http://127.0.0.1:${devnet.port}`;
    const cfg = { ...baseConfig, devnetUrl, oracleStatic: true };
    oracle = await startOracle({ port: 0, config: cfg, logger: quietLogger() });
    const chain = new MockChainHttpClient(devnetUrl);
    middleware = await startMiddleware({ port: 0, config: cfg, chain, upstreamsFile, logger: quietLogger() });

    const accounts = await createDemoAccounts({ devnetUrl });
    buyerAccount = accounts.buyer.accountId;
    const wrapped = await wrapService({
      upstreamUrl: `http://127.0.0.1:${oracle.port}/feed`,
      priceNear: '0.5',
      name: 'CLI Oracle',
      gateway: `http://127.0.0.1:${middleware.port}`,
      chain,
      signer: { kind: 'mock', accountId: accounts.seller.accountId },
      adminToken: cfg.adminToken,
    });
    expect(wrapped.adminOk).toBe(true);
    serviceId = wrapped.serviceId;
  });

  afterAll(async () => {
    await middleware?.close().catch(() => undefined);
    await oracle?.close().catch(() => undefined);
    await devnet?.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('`neargate list` prints the `id  name  price(NEAR)  calls  tier  active` table', async () => {
    const run = await runCli(['list', '--mode', 'mock']);
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines[0]!.split(/\s{2,}/)).toEqual(['id', 'name', 'price(NEAR)', 'calls', 'tier', 'active']);
    expect(lines[1]!.split(/\s{2,}/)).toEqual([String(serviceId), 'CLI Oracle', '0.5', '0/0', 'new', 'yes']);
  });

  it('`neargate buy` prints the body to stdout and the receipt to stderr', async () => {
    const run = await runCli(['buy', String(serviceId), '--mode', 'mock']);
    expect(run.code, run.stderr).toBe(0);

    // stdout is exactly the purchased body: pipeable JSON, nothing else.
    const body = JSON.parse(run.stdout) as { attribution: string; pairs: { xau_usd: { value: number } } };
    expect(body.attribution).toBe('static-fixture');
    expect(body.pairs.xau_usd.value).toBe(3310.25);

    // stderr is the receipt.
    expect(run.stderr).toContain(`service:  #${serviceId} CLI Oracle`);
    expect(run.stderr).toContain('paid:     0.5 NEAR + 0.002 NEAR storage');
    const payment = /^payment: {2}(\S+)$/m.exec(run.stderr);
    expect(payment).not.toBeNull();
    expect(isNearTxHash(payment![1])).toBe(true);
    expect(run.stderr).toContain('status:   200');
    expect(run.stderr).not.toContain('static-fixture');
  });

  it('`neargate buy --max` below price + storage refuses with BUDGET_EXCEEDED and prints no body', async () => {
    const run = await runCli(['buy', String(serviceId), '--mode', 'mock', '--max', '0.5']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('BUDGET_EXCEEDED');
  });
});
