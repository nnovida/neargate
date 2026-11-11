#!/usr/bin/env -S npx tsx
/**
 * scripts/demo.ts — the register → 402 → pay → serve → attest → score loop, scripted.
 *
 * Offline, mock mode, in-process, ephemeral ports:
 *   devnet (mock chain) → oracle (static fixture) → gateway
 *   → faucet-funded seller + buyer (`neargate demo-accounts`)
 *   → the seller wraps the oracle at 0.5 NEAR (on-chain registration + admin-token mapping)
 *   → the buyer buys one call exactly like `neargate buy`: 402 invoice → registry `pay`
 *     with price + the 0.002 NEAR storage fee attached → retry with the tx as proof
 *   → the gateway attests the served call on chain → the score updates.
 *
 * stdout carries exactly six lines:
 *   registered service #1
 *   402 invoice: 0.5 NEAR + 0.002 NEAR storage
 *   paid: tx <hash>
 *   served: 200
 *   attested: tx <hash>
 *   score: 1/1 (new)
 * Server warnings go to stderr; a failure prints `demo failed: …` to stderr and exits 1.
 */
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChainClient } from '@agentgate/chain';
import { buyService, createDemoAccounts, wrapService } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  formatPriceWithStorage,
  isAgentGateError,
  loadConfig,
  trustTier,
  type ActivityEvent,
  type AnySigner,
  type ChainClient,
  type Logger,
} from '@agentgate/shared';

// The demo is self-contained and must work offline: mock chain + fixture oracle.
process.env.AGENTGATE_MODE = 'mock';
process.env.ORACLE_STATIC = '1';

const PRICE_NEAR = '0.5';
/** How long the gateway gets to land the attestation on the devnet (ms). */
const ATTESTATION_TIMEOUT_MS = 10_000;
const ATTESTATION_POLL_MS = 100;

interface Closeable {
  close(): Promise<void>;
}

const running: Closeable[] = [];
// Fresh per-run upstream map: demo state must never leak across runs.
const upstreamsFile = path.join(os.tmpdir(), `neargate-demo-upstreams-${process.pid}-${Date.now()}.json`);

/**
 * Server logger for the demo. stdout is the six-line transcript, so debug/info are dropped;
 * warnings and errors go to stderr as `[name] level: msg` (structured fields are left out —
 * they carry request details that do not belong in a demo transcript).
 */
function demoLogger(name: string): Logger {
  const toStderr =
    (level: 'warn' | 'error') =>
    (msg: string): void => {
      process.stderr.write(`[${name}] ${level}: ${msg}\n`);
    };
  return {
    name,
    level: 'warn',
    debug: () => undefined,
    info: () => undefined,
    warn: toStderr('warn'),
    error: toStderr('error'),
    child: (child: string) => demoLogger(`${name}.${child}`),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the gateway's attestation of `paymentTxHash` to show up in the chain's activity feed. */
async function waitForAttestation(chain: ChainClient, paymentTxHash: string): Promise<ActivityEvent> {
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS;
  for (;;) {
    const activity = await chain.listRecentActivity(50);
    const event = activity.find(
      (e) => e.kind === 'attestation' && e.paymentTxHash === paymentTxHash && e.txHash !== null,
    );
    if (event !== undefined) return event;
    if (Date.now() >= deadline) {
      throw new Error(`no attestation of payment ${paymentTxHash} within ${ATTESTATION_TIMEOUT_MS} ms`);
    }
    await sleep(ATTESTATION_POLL_MS);
  }
}

async function cleanup(): Promise<void> {
  for (const s of [...running].reverse()) {
    await s.close().catch(() => undefined);
  }
  await rm(upstreamsFile, { force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. The stack, in-process on ephemeral ports (a running `npm run dev` never collides).
  const devnet = await startDevnet({ config, port: 0, logger: demoLogger('devnet') });
  running.push(devnet);
  const devnetUrl = `http://127.0.0.1:${devnet.port}`;
  const cfg = { ...config, devnetUrl, oracleStatic: true };

  const oracle = await startOracle({ config: cfg, port: 0, logger: demoLogger('oracle') });
  running.push(oracle);

  const chain = createChainClient(cfg);
  const gateway = await startMiddleware({
    config: cfg,
    chain,
    port: 0,
    logger: demoLogger('gateway'),
    upstreamsFile,
    // in-memory invoices and attestation queue: the demo never touches persisted gateway state
    invoiceStorePath: '',
    attestationQueuePath: '',
  });
  running.push(gateway);

  // 2. Faucet-funded seller + buyer (the seller pays the registration deposit).
  const accounts = await createDemoAccounts({ devnetUrl });
  const seller: AnySigner = { kind: 'mock', accountId: accounts.seller.accountId };
  const buyer: AnySigner = { kind: 'mock', accountId: accounts.buyer.accountId };

  // 3. The seller wraps the oracle: on-chain registration + the gateway upstream mapping.
  const wrapped = await wrapService({
    upstreamUrl: `http://127.0.0.1:${oracle.port}/feed`,
    priceNear: PRICE_NEAR,
    name: 'RWA FX & Gold Oracle',
    description: 'USD/IDR exchange rate and gold (XAU/USD) spot price feed with confidence scoring',
    gateway: `http://127.0.0.1:${gateway.port}`,
    chain,
    signer: seller,
    adminToken: cfg.adminToken,
  });
  if (!wrapped.adminOk) {
    throw new Error(`gateway upstream mapping failed: ${wrapped.adminWarning ?? 'unknown error'}`);
  }
  console.log(`registered service #${wrapped.serviceId}`);

  // 4. The buyer buys one call: 402 invoice → registry `pay` → retry with the tx as proof.
  const { result } = await buyService({ chain, signer: buyer, id: wrapped.serviceId });
  if (!result.paid || result.requirements === undefined || result.txHash === undefined) {
    throw new Error(`the gateway answered ${result.status} without asking for payment`);
  }
  const invoice = result.requirements.extra;
  console.log(`402 invoice: ${formatPriceWithStorage(invoice.priceYocto, invoice.storageFeeYocto)}`);
  console.log(`paid: tx ${result.txHash}`);
  if (result.status !== 200) {
    throw new Error(`paid, but the gateway answered ${result.status}: ${JSON.stringify(result.body)}`);
  }
  console.log(`served: ${result.status}`);

  // 5. The gateway attests the served call on chain; the score follows.
  const attestation = await waitForAttestation(chain, result.txHash);
  if (attestation.success !== true) {
    throw new Error(`the gateway attested the paid call as failed (tx ${String(attestation.txHash)})`);
  }
  console.log(`attested: tx ${String(attestation.txHash)}`);

  const score = await chain.getScore(wrapped.serviceId);
  console.log(`score: ${score.successCalls}/${score.totalCalls} (${trustTier(score)})`);
}

main()
  .then(async () => {
    await cleanup();
    process.exitCode = 0;
    // Everything left running is unref'd; force-exit only if something leaks.
    setTimeout(() => process.exit(0), 2000).unref();
  })
  .catch(async (err: unknown) => {
    const message = isAgentGateError(err)
      ? err.message.startsWith(err.code)
        ? err.message
        : `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    console.error(`demo failed: ${message}`);
    await cleanup();
    process.exit(1);
  });
