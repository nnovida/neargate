/**
 * e2e/escrow.test.ts — the prepaid-escrow rail against the mock stack (Task 10b).
 *
 * Boots devnet + oracle (static fixture) + middleware on port 0, wraps the oracle, then:
 *
 *   - in-process: deposit → `buy --from-escrow` → the escrow, not the account, pays exactly
 *     price + 0.002 NEAR; the gateway serves the `pay_from_escrow` proof and attests the call; an
 *     escrow that cannot cover the next call is refused before anything is sent; withdraw
 *     returns the rest;
 *   - the real `neargate` bin as a subprocess: `escrow deposit|balance|withdraw`,
 *     `buy --from-escrow`, and `agent-key add` answering that agent keys need live mode.
 *
 * Mock mode carries no keys, so the restriction itself (a function-call key that can only call
 * `pay_from_escrow`) is a live-chain property; see the contract's integration test.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient } from '@agentgate/chain';
import { buyService, createDemoAccounts, depositToEscrow, withdrawFromEscrow, wrapService } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  ESCROW_STORAGE_FEE_YOCTO,
  PAYMENT_STORAGE_FEE_YOCTO,
  chainErrorCode,
  isNearTxHash,
  loadConfig,
  nearToYocto,
  type Logger,
  type MockSigner,
} from '@agentgate/shared';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'packages/cli/src/bin.ts');

const PRICE = BigInt(nearToYocto('0.5'));
const FEE = BigInt(PAYMENT_STORAGE_FEE_YOCTO);
/** What one call costs the escrow: price + the 0.002 NEAR storage fee. */
const TOTAL = PRICE + FEE;
const ESCROW_FEE = BigInt(ESCROW_STORAGE_FEE_YOCTO);

interface Running {
  port: number;
  close(): Promise<void>;
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function quietLogger(name = 'e2e-escrow'): Logger {
  const noop = (): void => undefined;
  return { name, level: 'error', debug: noop, info: noop, warn: noop, error: noop, child: (n) => quietLogger(`${name}.${n}`) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('escrow rail (e2e, mock stack)', () => {
  const baseConfig = loadConfig({});
  let devnet: Running;
  let oracle: Running;
  let middleware: Running;
  let home: string;
  let devnetUrl: string;
  let chain: MockChainHttpClient;
  let seller: MockSigner;
  let serviceId: number;

  const balanceOf = async (accountId: string): Promise<bigint> => BigInt(await chain.getBalance(accountId));
  const escrowOf = async (accountId: string): Promise<bigint> => BigInt(await chain.escrowOf(accountId));

  /** A fresh funded buyer, so each describe's numbers start from nothing. */
  async function freshBuyer(): Promise<MockSigner> {
    const accounts = await createDemoAccounts({ devnetUrl });
    return { kind: 'mock', accountId: accounts.buyer.accountId };
  }

  function runCli(args: string[], buyer: MockSigner, envOver: Record<string, string> = {}): Promise<CliRun> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', BIN, ...args],
        {
          cwd: REPO_ROOT,
          // Never inherit the host shell's NearGate settings.
          env: { PATH: process.env['PATH'] ?? '', HOME: home, DEVNET_URL: devnetUrl, MOCK_BUYER_ACCOUNT: buyer.accountId, ...envOver },
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
    home = await mkdtemp(path.join(os.tmpdir(), 'neargate-e2e-escrow-'));
    devnet = await startDevnet({ port: 0, config: baseConfig, logger: quietLogger() });
    devnetUrl = `http://127.0.0.1:${devnet.port}`;
    const cfg = { ...baseConfig, devnetUrl, oracleStatic: true };
    oracle = await startOracle({ port: 0, config: cfg, logger: quietLogger() });
    chain = new MockChainHttpClient(devnetUrl);
    middleware = await startMiddleware({
      port: 0,
      config: cfg,
      chain,
      upstreamsFile: path.join(home, 'upstreams.json'),
      attestationRetryDelayMs: 250,
      logger: quietLogger(),
    });
    const accounts = await createDemoAccounts({ devnetUrl });
    seller = { kind: 'mock', accountId: accounts.seller.accountId };
    const wrapped = await wrapService({
      upstreamUrl: `http://127.0.0.1:${oracle.port}/feed`,
      priceNear: '0.5',
      name: 'Escrow Oracle',
      gateway: `http://127.0.0.1:${middleware.port}`,
      chain,
      signer: seller,
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

  describe('in-process: deposit → buy --from-escrow → withdraw', () => {
    let buyer: MockSigner;
    let paidTxHash: string;
    let paidNonce: string;

    beforeAll(async () => {
      buyer = await freshBuyer();
    });

    it('deposit credits the escrow minus the 0.002 NEAR storage fee; the account pays the whole deposit', async () => {
      const accountBefore = await balanceOf(buyer.accountId);
      const result = await depositToEscrow({ chain, signer: buyer, amountNear: '1' });
      expect(isNearTxHash(result.txHash)).toBe(true);
      expect(result).toMatchObject({ escrowBeforeYocto: '0', escrowYocto: (BigInt(nearToYocto('1')) - ESCROW_FEE).toString() });
      expect(accountBefore - (await balanceOf(buyer.accountId))).toBe(BigInt(nearToYocto('1')));
    });

    it('escrow buy debits escrow by exactly price + 0.002 NEAR and leaves the account balance untouched', async () => {
      const escrowBefore = await escrowOf(buyer.accountId);
      const accountBefore = await balanceOf(buyer.accountId);
      const sellerBefore = await balanceOf(seller.accountId);

      const { result } = await buyService({ chain, signer: buyer, id: serviceId, fromEscrow: true });

      expect(result).toMatchObject({ status: 200, paid: true, payFrom: 'escrow', priceYocto: PRICE.toString(), depositYocto: TOTAL.toString() });
      expect((result.body as { attribution: string }).attribution).toBe('static-fixture'); // the oracle's bytes
      expect(result.settlement).toMatchObject({ success: true, transaction: result.txHash });
      expect(escrowBefore - (await escrowOf(buyer.accountId))).toBe(TOTAL); // price + 0.002 NEAR, to the yocto
      expect(await balanceOf(buyer.accountId)).toBe(accountBefore); // the account itself paid nothing
      expect((await balanceOf(seller.accountId)) - sellerBefore).toBe(PRICE); // and the seller got the full price
      paidTxHash = result.txHash!;
      paidNonce = result.requirements!.extra.nonce;
    });

    it('the escrow payment is a normal payment: recorded for the payer, and attested by the gateway', async () => {
      expect(await chain.getPayment(paidNonce)).toMatchObject({
        payer: buyer.accountId,
        serviceId,
        amountYocto: PRICE.toString(),
        selfPaid: false,
      });
      const deadline = Date.now() + 5_000;
      let found;
      for (;;) {
        found = (await chain.listAttestations(serviceId, 50)).find((a) => a.paymentTxHash === paidTxHash);
        if (found !== undefined || Date.now() >= deadline) break;
        await sleep(200);
      }
      expect(found, 'attestation for the pay_from_escrow tx').toBeDefined();
      expect(found!.success).toBe(true);
      expect(found!.nonce).toBe(paidNonce);
      expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 1, successCalls: 1 });
      const payment = (await chain.listRecentActivity(100)).find((e) => e.kind === 'payment' && e.txHash === paidTxHash);
      expect(payment).toMatchObject({ account: buyer.accountId, amountYocto: PRICE.toString(), nonce: paidNonce });
    });

    it('an escrow below price + fee is refused before anything is sent: nothing debited, no payment, no gateway call paid', async () => {
      const left = await escrowOf(buyer.accountId);
      expect(left).toBeLessThan(TOTAL); // 0.998 − 0.502 = 0.496 NEAR
      const accountBefore = await balanceOf(buyer.accountId);
      const activityBefore = (await chain.listRecentActivity(200)).length;

      const err = await buyService({ chain, signer: buyer, id: serviceId, fromEscrow: true }).catch((e: unknown) => e);

      expect(chainErrorCode(err)).toBe('ERR_ESCROW_INSUFFICIENT');
      expect((err as Error).message).toBe(
        `ERR_ESCROW_INSUFFICIENT: the escrow holds ${left} yocto, the payment needs ${TOTAL} (price + storage fee); nothing was sent`,
      );
      expect(await escrowOf(buyer.accountId)).toBe(left);
      expect(await balanceOf(buyer.accountId)).toBe(accountBefore);
      expect((await chain.listRecentActivity(200)).length).toBe(activityBefore); // no block, no payment event
    });

    it('top up, buy again, and a different nonce each time: the escrow drains by one total per call', async () => {
      await depositToEscrow({ chain, signer: buyer, amountNear: '1' }); // a top-up: credited in full
      const before = await escrowOf(buyer.accountId);
      const first = await buyService({ chain, signer: buyer, id: serviceId, fromEscrow: true });
      const second = await buyService({ chain, signer: buyer, id: serviceId, fromEscrow: true });
      expect(first.result.requirements!.extra.nonce).not.toBe(second.result.requirements!.extra.nonce);
      expect(before - (await escrowOf(buyer.accountId))).toBe(TOTAL * 2n);
    });

    it('withdraw returns part of the escrow to the account (1 yocto stays in the registry) and refuses more than is left', async () => {
      const escrowBefore = await escrowOf(buyer.accountId);
      const accountBefore = await balanceOf(buyer.accountId);
      const quarter = nearToYocto('0.25');

      const withdrawn = await withdrawFromEscrow({ chain, signer: buyer, amountNear: '0.25' });
      expect(withdrawn.escrowYocto).toBe((escrowBefore - BigInt(quarter)).toString());
      expect((await balanceOf(buyer.accountId)) - accountBefore).toBe(BigInt(quarter) - 1n);

      const tooMuch = await withdrawFromEscrow({ chain, signer: buyer, amountNear: '50' }).catch((e: unknown) => e);
      expect(chainErrorCode(tooMuch)).toBe('ERR_ESCROW_INSUFFICIENT');
      expect(await escrowOf(buyer.accountId)).toBe(escrowBefore - BigInt(quarter));
    });
  });

  describe('the neargate bin (subprocess, mock mode)', () => {
    let buyer: MockSigner;

    beforeAll(async () => {
      buyer = await freshBuyer();
    });

    it('`escrow balance` of an account that never deposited prints 0 NEAR', async () => {
      const run = await runCli(['escrow', 'balance', '--mode', 'mock'], buyer);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe(`account:  ${buyer.accountId}\nescrow:   0 NEAR\n`);
      expect(run.stderr).toBe('');
    });

    it('`escrow deposit 1` credits 0.998 NEAR and says what the registry kept', async () => {
      const run = await runCli(['escrow', 'deposit', '1', '--mode', 'mock'], buyer);
      expect(run.code, run.stderr).toBe(0);
      const lines = run.stdout.trimEnd().split('\n');
      expect(lines[0]).toBe(`account:    ${buyer.accountId}`);
      expect(lines[1]).toBe('deposited:  1 NEAR');
      expect(lines[2]).toBe('escrow:     0.998 NEAR');
      const tx = /^tx: {9}(\S+)$/.exec(lines[3] ?? '');
      expect(tx).not.toBeNull();
      expect(isNearTxHash(tx![1])).toBe(true);
      expect(lines[4]).toBe("note:       the first deposit keeps 0.002 NEAR as the escrow's storage fee");
      expect(await escrowOf(buyer.accountId)).toBe(BigInt(nearToYocto('0.998')));
    });

    it('`escrow balance <account>` reads any account without a key', async () => {
      const run = await runCli(['escrow', 'balance', buyer.accountId, '--mode', 'mock'], { kind: 'mock', accountId: 'someone-else.mock' });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe(`account:  ${buyer.accountId}\nescrow:   0.998 NEAR\n`);
    });

    it('`buy --from-escrow` prints the body on stdout and a receipt that says the escrow paid', async () => {
      const accountBefore = await balanceOf(buyer.accountId);
      const run = await runCli(['buy', String(serviceId), '--from-escrow', '--mode', 'mock'], buyer);
      expect(run.code, run.stderr).toBe(0);
      expect((JSON.parse(run.stdout) as { attribution: string }).attribution).toBe('static-fixture');
      expect(run.stderr).toContain('paid:     0.5 NEAR + 0.002 NEAR storage');
      expect(run.stderr).toContain('from:     escrow (nothing attached; the escrow was debited)');
      expect(run.stderr).toContain('status:   200');
      expect(await balanceOf(buyer.accountId)).toBe(accountBefore);
      expect(await escrowOf(buyer.accountId)).toBe(BigInt(nearToYocto('0.998')) - TOTAL);
    });

    it('`buy --from-escrow` with an escrow below price + 0.002 NEAR exits 1 with ERR_ESCROW_INSUFFICIENT and prints no body', async () => {
      const run = await runCli(['buy', String(serviceId), '--from-escrow', '--mode', 'mock'], buyer); // 0.496 NEAR left
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^error: ERR_ESCROW_INSUFFICIENT: the escrow holds 496000000000000000000000 yocto/);
    });

    it('`buy --from-escrow --max` still caps the total attached', async () => {
      const run = await runCli(['buy', String(serviceId), '--from-escrow', '--max', '0.5', '--mode', 'mock'], buyer);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('BUDGET_EXCEEDED');
    });

    it('`escrow withdraw 0.4` returns NEAR to the account; withdrawing more than is left exits 1 before sending', async () => {
      const ok = await runCli(['escrow', 'withdraw', '0.4', '--mode', 'mock'], buyer);
      expect(ok.code, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('withdrawn:  0.4 NEAR');
      expect(ok.stdout).toContain('escrow:     0.096 NEAR');
      const refused = await runCli(['escrow', 'withdraw', '5', '--mode', 'mock'], buyer);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/^error: ERR_ESCROW_INSUFFICIENT: the amount must be between 1 and the escrow balance, 96000000000000000000000 yocto; nothing was sent/);
      expect(await escrowOf(buyer.accountId)).toBe(BigInt(nearToYocto('0.096')));
    });

    it('rejects a zero or malformed amount and a malformed account before any chain call', async () => {
      const zero = await runCli(['escrow', 'deposit', '0', '--mode', 'mock'], buyer);
      expect(zero.code).toBe(1);
      expect(zero.stderr).toMatch(/^error: INVALID_AMOUNT: /);
      const bad = await runCli(['escrow', 'withdraw', 'lots', '--mode', 'mock'], buyer);
      expect(bad.stderr).toMatch(/^error: INVALID_AMOUNT: /);
      const account = await runCli(['escrow', 'balance', 'Not An Account', '--mode', 'mock'], buyer);
      expect(account.stderr).toMatch(/^error: INVALID_ACCOUNT_ID: /);
      expect(await escrowOf(buyer.accountId)).toBe(BigInt(nearToYocto('0.096')));
    });

    it('`agent-key add` in mock mode says agent keys need live mode: exit 1, no key file anywhere', async () => {
      const run = await runCli(['agent-key', 'add', '--allowance', '0.25', '--mode', 'mock'], buyer);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^error: LIVE_ONLY: agent keys need live mode/);
      await expect(readdir(path.join(home, '.near-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('`agent-key add` in live mode needs the account\'s key first: SIGNER_MISSING, before any key is generated or any RPC call', async () => {
      const run = await runCli(
        ['agent-key', 'add', '--allowance', '0.25', '--mode', 'live', '--registry', 'neargate-registry.testnet', '--account', 'buyer.testnet'],
        buyer,
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^error: SIGNER_MISSING: no NEAR key for buyer\.testnet/);
      await expect(readdir(path.join(home, '.near-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('`agent-key add` refuses a zero allowance (INVALID_AMOUNT) before it touches anything', async () => {
      const run = await runCli(
        ['agent-key', 'add', '--allowance', '0', '--mode', 'live', '--registry', 'neargate-registry.testnet', '--account', 'buyer.testnet'],
        buyer,
        { BUYER_PRIVATE_KEY: KeyPair.fromRandom('ed25519').toString() }, // a valid key: the allowance is what fails
      );
      expect(run.code).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(/^error: INVALID_AMOUNT: the agent key allowance must be greater than zero/);
      await expect(readdir(path.join(home, '.near-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
