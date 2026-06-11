#!/usr/bin/env -S npx tsx
/**
 * scripts/demo.ts — one-shot scripted demo of the full PRD §2 loop (SPEC §12).
 *
 * Offline, mock mode, in-process:
 *   devnet → oracle (static fixture) → middleware → demo accounts (faucet)
 *   → wrap the oracle behind the 402 paywall (0.5 CSPR, via the CLI's wrapService)
 *   → buyer agent (MockLlm): discover → 402 → pay → consume → summarize
 *   → attestation lands on-chain → score updates.
 *
 * Prints both tx hashes (payment deploy + attestation) and exits 0.
 */
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChainClient } from '@agentgate/chain';
import { createDemoAccounts, wrapService } from '@agentgate/cli';
import { MockLlm, runBuyerAgent } from '@agentgate/buyer-agent';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import { formatCspr, loadConfig, type AnySigner } from '@agentgate/shared';

// The demo is self-contained and must work offline: mock chain + fixture oracle.
process.env.AGENTGATE_MODE = 'mock';
process.env.ORACLE_STATIC = '1';

const TASK = 'Get today\'s USD/IDR rate and gold price, summarize for a treasury report';
const PRICE_CSPR = '0.5';
const LINE = '═'.repeat(72);

interface Closeable {
  name: string;
  close(): Promise<void>;
}

const running: Closeable[] = [];
// Fresh per-run upstream map: demo state must never leak across runs.
const upstreamsFile = path.join(os.tmpdir(), `agentgate-demo-upstreams-${process.pid}-${Date.now()}.json`);

async function cleanup(): Promise<void> {
  for (const s of [...running].reverse()) {
    await s.close().catch(() => undefined);
  }
  await rm(upstreamsFile, { force: true }).catch(() => undefined);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log(`${LINE}\n  AGENTGATE DEMO — register → 402 → pay → serve → attest → score\n${LINE}`);

  const config = loadConfig();

  // 1. Boot the stack in-process (ports from env, SPEC §12).
  const devnet = await startDevnet({ config });
  running.push({ name: 'devnet', close: devnet.close });
  const devnetUrl = `http://127.0.0.1:${devnet.port}`;
  const cfg = { ...config, devnetUrl };

  const oracle = await startOracle({ config: cfg });
  running.push({ name: 'oracle', close: oracle.close });

  const chain = createChainClient(cfg);
  const middleware = await startMiddleware({ config: cfg, chain, upstreamsFile });
  running.push({ name: 'middleware', close: middleware.close });

  console.log(
    `\nstack up: devnet :${devnet.port} · oracle :${oracle.port} (static fixture) · middleware :${middleware.port}\n`,
  );

  // 2. Demo accounts: buyer + seller, faucet-funded 1000 CSPR each.
  const accounts = await createDemoAccounts({ devnetUrl });
  const sellerSigner: AnySigner = { kind: 'mock', publicKey: accounts.seller.publicKey };
  const buyerSigner: AnySigner = { kind: 'mock', publicKey: accounts.buyer.publicKey };
  console.log(`seller: ${accounts.seller.publicKey.slice(0, 18)}… (${formatCspr(accounts.seller.balanceMotes)})`);
  console.log(`buyer:  ${accounts.buyer.publicKey.slice(0, 18)}… (${formatCspr(accounts.buyer.balanceMotes)})\n`);

  // 3. Seller wraps the oracle behind the paywall (on-chain registration +
  //    gateway upstream mapping) via the CLI's programmatic API.
  const wrapped = await wrapService({
    upstreamUrl: `http://127.0.0.1:${oracle.port}/feed`,
    priceCspr: PRICE_CSPR,
    name: 'RWA FX & Gold Oracle',
    description: 'USD/IDR exchange rate and gold (XAU/USD) spot price feed with confidence scoring',
    gateway: `http://127.0.0.1:${middleware.port}`,
    dashboardBaseUrl: `http://localhost:${cfg.dashboardPort}`,
    chain,
    signer: sellerSigner,
    adminToken: cfg.adminToken,
  });
  if (!wrapped.adminOk) {
    throw new Error(`gateway upstream mapping failed: ${wrapped.adminWarning ?? 'unknown error'}`);
  }
  console.log(`wrapped service #${wrapped.serviceId} at ${wrapped.publicUrl} (register tx ${wrapped.txHash.slice(0, 16)}…)\n`);

  // 4. Buyer agent: discover → choose (MockLlm, no API key needed) → budget check
  //    → 402 → pay on-chain → retry with proof → summarize → attestation receipt.
  const report = await runBuyerAgent({
    task: TASK,
    budgetCspr: cfg.buyerBudgetCspr,
    chain,
    signer: buyerSigner,
    llm: new MockLlm(),
    config: cfg,
  });

  if (!report.paid || report.deployHash === null) {
    throw new Error(`buyer agent did not complete the paid loop: ${report.summary}`);
  }
  if (report.attestationTxHash === null) {
    throw new Error('attestation was not observed on-chain within the polling window');
  }

  // 5. Final proof block.
  const score = await chain.getScore(report.chosenServiceId);
  console.log(`\n${LINE}\n  DEMO COMPLETE in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — full loop verified on the mock chain\n${LINE}`);
  console.log(`  payment deploy hash : ${report.deployHash}`);
  console.log(`  attestation tx hash : ${report.attestationTxHash}`);
  console.log(`  amount paid         : ${formatCspr(report.spentMotes)}`);
  console.log(`  final score         : ${score.successCalls}/${score.totalCalls} (success/total)`);
  console.log(`  service public URL  : ${wrapped.publicUrl}`);
  console.log(`  dashboard           : ${wrapped.dashboardUrl}  (start it with \`npm run dev:dashboard\`)`);
  console.log(LINE);
}

main()
  .then(async () => {
    await cleanup();
    process.exitCode = 0;
    // Everything left running is unref'd; force-exit only if something leaks.
    setTimeout(() => process.exit(0), 2000).unref();
  })
  .catch(async (err) => {
    console.error('\ndemo failed:', err instanceof Error ? err.message : err);
    await cleanup();
    process.exit(1);
  });
