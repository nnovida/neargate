/**
 * e2e/gasless.test.ts — the gasless rail against the mock stack (Task 10c).
 *
 * Boots devnet + oracle (static fixture) + a middleware with the relayer on (RELAYER_ENABLED,
 * GATEWAY_ACCOUNT_ID=gateway.mock) on port 0, wraps the oracle, then:
 *
 *   - in-process: deposit → `buy --gasless` → the buyer signs a NEP-366 `pay_from_escrow`
 *     delegate, the gateway relays it (it is the relay's signer), the escrow pays exactly price +
 *     0.002 NEAR and the buyer's account balance does not move; the call is served and attested;
 *   - two back-to-back gasless buys with the same key: distinct delegate nonces, both served;
 *   - a relay whose devnet answer times out after the devnet ran it: settlement_pending naming the
 *     relay tx, then the client presents the same delegate again and is served, relayed once;
 *   - the real `neargate` bin as a subprocess: `buy --gasless` prints the body and a receipt
 *     saying the gateway relayed it.
 *
 * The gateway's chain client is its own MockChainHttpClient, so the test sees what it relays.
 * What the mock cannot show: the devnet charges no gas to anyone, so "the buyer's balance did
 * not move" holds whoever would have paid the gas, and "the gateway is the relay's signer" checks
 * the signer the gateway handed relayPay, not who NEAR charged. The live testnet run (7b) is the
 * proof that the relayer pays the gas.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainHttpClient, decodeSignedDelegate, devnetRelayTxHash } from '@agentgate/chain';
import { buyService, createDemoAccounts, depositToEscrow, wrapService } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  PAYMENT_STORAGE_FEE_YOCTO,
  isNearTxHash,
  loadConfig,
  nearToYocto,
  type AnySigner,
  type Logger,
  type MockSigner,
} from '@agentgate/shared';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'packages/cli/src/bin.ts');
const GATEWAY_ACCOUNT = 'gateway.mock';

const PRICE = BigInt(nearToYocto('0.5'));
/** What one call costs the escrow: price + the 0.002 NEAR storage fee. */
const TOTAL = PRICE + BigInt(PAYMENT_STORAGE_FEE_YOCTO);

interface Running {
  port: number;
  close(): Promise<void>;
}

function quietLogger(name = 'e2e-gasless'): Logger {
  const noop = (): void => undefined;
  return { name, level: 'error', debug: noop, info: noop, warn: noop, error: noop, child: (n) => quietLogger(`${name}.${n}`) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('gasless rail (e2e, mock stack)', () => {
  const baseConfig = loadConfig({});
  let devnet: Running;
  let oracle: Running;
  let middleware: Running;
  let home: string;
  let devnetUrl: string;
  let chain: MockChainHttpClient;
  /** What the gateway relayed: the delegate, the relayer it signed as, the relay tx. */
  const relays: Array<{ signedDelegate: string; relayer: AnySigner; txHash: string }> = [];
  /** Every relayPay call the gateway made, answered or not. */
  const relayAttempts: string[] = [];
  let seller: MockSigner;
  let serviceId: number;

  const balanceOf = async (accountId: string): Promise<bigint> => BigInt(await chain.getBalance(accountId));
  const escrowOf = async (accountId: string): Promise<bigint> => BigInt(await chain.escrowOf(accountId));

  async function escrowBuyer(): Promise<MockSigner> {
    const accounts = await createDemoAccounts({ devnetUrl });
    const buyer: MockSigner = { kind: 'mock', accountId: accounts.buyer.accountId };
    await depositToEscrow({ chain, signer: buyer, amountNear: '2' });
    return buyer;
  }

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'neargate-e2e-gasless-'));
    devnet = await startDevnet({ port: 0, config: baseConfig, logger: quietLogger() });
    devnetUrl = `http://127.0.0.1:${devnet.port}`;
    const cfg = { ...baseConfig, devnetUrl, oracleStatic: true, relayerEnabled: true, gatewayAccountId: GATEWAY_ACCOUNT };
    oracle = await startOracle({ port: 0, config: cfg, logger: quietLogger() });
    chain = new MockChainHttpClient(devnetUrl);
    const gatewayChain = new MockChainHttpClient(devnetUrl);
    const relayPay = gatewayChain.relayPay.bind(gatewayChain);
    gatewayChain.relayPay = async (signedDelegate, relayer) => {
      relayAttempts.push(signedDelegate);
      const result = await relayPay(signedDelegate, relayer);
      relays.push({ signedDelegate, relayer, txHash: result.txHash });
      return result;
    };
    middleware = await startMiddleware({
      port: 0,
      config: cfg,
      chain: gatewayChain,
      upstreamsFile: path.join(home, 'upstreams.json'),
      attestationRetryDelayMs: 250,
      logger: quietLogger(),
    });
    const accounts = await createDemoAccounts({ devnetUrl });
    seller = { kind: 'mock', accountId: accounts.seller.accountId };
    const wrapped = await wrapService({
      upstreamUrl: `http://127.0.0.1:${oracle.port}/feed`,
      priceNear: '0.5',
      name: 'Gasless Oracle',
      gateway: `http://127.0.0.1:${middleware.port}`,
      chain,
      signer: seller,
      adminToken: cfg.adminToken,
    });
    expect(wrapped.adminOk).toBe(true);
    serviceId = wrapped.serviceId;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await middleware?.close().catch(() => undefined);
    await oracle?.close().catch(() => undefined);
    await devnet?.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it("gasless buy leaves the buyer's account balance unchanged and debits escrow by exactly price + 0.002 NEAR; the relay tx's signer is the gateway", async () => {
    const buyer = await escrowBuyer();
    const escrowBefore = await escrowOf(buyer.accountId);
    const accountBefore = await balanceOf(buyer.accountId);
    const sellerBefore = await balanceOf(seller.accountId);
    const relaysBefore = relays.length;

    const { result } = await buyService({ chain, signer: buyer, id: serviceId, gasless: true });

    expect(result).toMatchObject({ status: 200, paid: true, gasless: true, relayer: GATEWAY_ACCOUNT, payFrom: 'escrow' });
    expect((result.body as { attribution: string }).attribution).toBe('static-fixture'); // the oracle's bytes
    // The devnet charges no gas, so this holds whoever would pay it: it shows the escrow, not the
    // account, paid the call. Who pays the gas is the live run's to prove (7b).
    expect(await balanceOf(buyer.accountId)).toBe(accountBefore);
    expect(escrowBefore - (await escrowOf(buyer.accountId))).toBe(TOTAL); // price + 0.002 NEAR, to the yocto
    expect((await balanceOf(seller.accountId)) - sellerBefore).toBe(PRICE);

    // One relay of the buyer's own pay_from_escrow delegate, which the gateway handed relayPay to
    // sign as the gateway account (what the gateway passed; the devnet charges no one).
    expect(relays).toHaveLength(relaysBefore + 1);
    const relay = relays.at(-1)!;
    expect(relay.relayer).toEqual({ kind: 'mock', accountId: GATEWAY_ACCOUNT });
    expect(decodeSignedDelegate(relay.signedDelegate)).toMatchObject({ senderId: buyer.accountId, receiverId: chain.registryId });
    expect(isNearTxHash(relay.txHash)).toBe(true);
    expect(result.txHash).toBe(relay.txHash);
    expect(result.settlement).toMatchObject({ success: true, transaction: relay.txHash, payer: buyer.accountId });

    // A normal payment for the payer, attested by the gateway against the relay tx.
    const nonce = result.requirements!.extra.nonce;
    expect(await chain.getPayment(nonce)).toMatchObject({ payer: buyer.accountId, serviceId, amountYocto: PRICE.toString() });
    const deadline = Date.now() + 5_000;
    let attested;
    for (;;) {
      attested = (await chain.listAttestations(serviceId, 50)).find((a) => a.nonce === nonce);
      if (attested !== undefined || Date.now() >= deadline) break;
      await sleep(200);
    }
    expect(attested).toMatchObject({ paymentTxHash: relay.txHash, success: true });
  });

  it('two back-to-back gasless buys with the same key sign distinct delegate nonces; both are relayed and served', async () => {
    const buyer = await escrowBuyer();
    const relaysBefore = relays.length;
    const first = await buyService({ chain, signer: buyer, id: serviceId, gasless: true });
    const second = await buyService({ chain, signer: buyer, id: serviceId, gasless: true });
    expect(first.result).toMatchObject({ status: 200, paid: true, gasless: true });
    expect(second.result).toMatchObject({ status: 200, paid: true, gasless: true });
    const nonces = relays.slice(relaysBefore).map((r) => decodeSignedDelegate(r.signedDelegate)?.nonce);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).toBe(nonces[0]! + 1n);
  });

  it("a relay whose devnet answer times out after the devnet ran it is settlement_pending, then served on the client's retry: relayed once", async () => {
    const buyer = await escrowBuyer();
    const escrowBefore = await escrowOf(buyer.accountId);
    const attemptsBefore = relayAttempts.length;
    // The gateway's relay POST reaches the devnet, which runs it; its answer then times out.
    const realFetch = globalThis.fetch;
    let armed = true;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (!armed || !url.endsWith('/registry/relay')) return realFetch(input, init);
      armed = false;
      await realFetch(input, init);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const waits: Array<{ attempt: number; transaction?: string }> = [];
    const { result } = await buyService({
      chain,
      signer: buyer,
      id: serviceId,
      gasless: true,
      onGaslessWait: ({ attempt, transaction }) => waits.push({ attempt, ...(transaction !== undefined ? { transaction } : {}) }),
    });

    expect(armed).toBe(false); // the relay's answer did time out
    expect(relayAttempts).toHaveLength(attemptsBefore + 1); // relayed once: the retry was served from it
    const relayTx = devnetRelayTxHash(relayAttempts.at(-1)!);
    expect(waits).toEqual([{ attempt: 1, transaction: relayTx }]); // one settlement_pending, naming the relay tx
    expect(result).toMatchObject({ status: 200, paid: true, gasless: true, txHash: relayTx });
    expect(escrowBefore - (await escrowOf(buyer.accountId))).toBe(TOTAL); // paid once
  });

  it('an escrow below price + fee is refused before anything is signed or relayed', async () => {
    const accounts = await createDemoAccounts({ devnetUrl });
    const buyer: MockSigner = { kind: 'mock', accountId: accounts.buyer.accountId };
    await depositToEscrow({ chain, signer: buyer, amountNear: '0.1' });
    const relaysBefore = relays.length;
    await expect(buyService({ chain, signer: buyer, id: serviceId, gasless: true })).rejects.toMatchObject({
      code: 'ERR_ESCROW_INSUFFICIENT',
    });
    expect(relays).toHaveLength(relaysBefore);
  });

  it('`neargate buy --gasless` prints the body on stdout and a receipt saying the gateway relayed it', async () => {
    const buyer = await escrowBuyer();
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', BIN, 'buy', String(serviceId), '--gasless', '--mode', 'mock'],
        {
          cwd: REPO_ROOT,
          // Never inherit the host shell's NearGate settings.
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: home,
            DEVNET_URL: devnetUrl,
            MOCK_BUYER_ACCOUNT: buyer.accountId,
            NEAR_RPC_URL: 'http://127.0.0.1:9',
          },
          timeout: 20_000,
        },
        (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
        },
      );
    });
    expect(run.stderr).toContain(`relayed:  gasless — ${GATEWAY_ACCOUNT} relayed the signed pay_from_escrow and paid the gas`);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ attribution: 'static-fixture' });
  });
});
