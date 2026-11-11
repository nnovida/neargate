/**
 * e2e/gasless.test.ts — the gasless rail against the mock stack (Task 10c).
 *
 * Boots devnet + oracle (static fixture) + a middleware with the relayer on (RELAYER_ENABLED,
 * GATEWAY_ACCOUNT_ID=gateway.mock) on port 0, wraps the oracle, then:
 *
 *   - in-process: deposit → `buy --gasless` → the buyer signs a NEP-366 `pay_from_escrow`
 *     delegate, the gateway relays it (it is the relay's signer), the escrow pays exactly price +
 *     0.002 NEAR and the buyer's account balance does not move; the call is served and attested;
 *   - the real `neargate` bin as a subprocess: `buy --gasless` prints the body and a receipt
 *     saying the gateway relayed it.
 *
 * The gateway's chain client is its own MockChainHttpClient, so the test sees what it relays.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient, decodeSignedDelegate } from '@agentgate/chain';
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
    expect(await balanceOf(buyer.accountId)).toBe(accountBefore); // not a yocto of gas from the buyer
    expect(escrowBefore - (await escrowOf(buyer.accountId))).toBe(TOTAL); // price + 0.002 NEAR, to the yocto
    expect((await balanceOf(seller.accountId)) - sellerBefore).toBe(PRICE);

    // One relay, signed by the gateway account, of the buyer's own pay_from_escrow delegate.
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
