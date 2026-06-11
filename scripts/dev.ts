#!/usr/bin/env -S npx tsx
/**
 * scripts/dev.ts — local dev stack (SPEC §12).
 *
 * Boots, in order: devnet (mock chain) → seeds two faucet-funded demo accounts →
 * oracle → middleware (402 paywall gateway), all in-process, mock mode.
 * Prints the export lines + next steps, then stays up until SIGINT/SIGTERM.
 */
import { createChainClient } from '@agentgate/chain';
import { createDemoAccounts, wrapService } from '@agentgate/cli';
import { MockLlm, runBuyerAgent } from '@agentgate/buyer-agent';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import { formatCspr, loadConfig, type AnySigner } from '@agentgate/shared';

// The dev stack is the mock loop by definition (SPEC §0: "mock mode").
process.env.AGENTGATE_MODE = 'mock';

// `--seed` (or `npm run dev:seed`) pre-populates the running devnet with one
// wrapped service + a real paid call, so the dashboard shows live data the
// moment you open it — no manual wrap/agent steps needed.
const SEED = process.argv.includes('--seed');
const SEED_TASK = "Get today's USD/IDR rate and gold price, summarize for a treasury report";

interface Closeable {
  name: string;
  close(): Promise<void>;
}

const running: Closeable[] = [];

async function shutdown(code: number): Promise<never> {
  console.log('\nshutting down…');
  for (const s of [...running].reverse()) {
    try {
      await s.close();
      console.log(`  ${s.name} stopped`);
    } catch (err) {
      console.error(`  ${s.name} failed to stop cleanly:`, err instanceof Error ? err.message : err);
    }
  }
  process.exit(code);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // 1. Devnet (mock chain).
  const devnet = await startDevnet({ config });
  running.push({ name: 'devnet', close: devnet.close });
  const devnetUrl = `http://localhost:${devnet.port}`;
  console.log(`devnet      → ${devnetUrl}`);

  // Everything downstream must talk to the devnet we just booted.
  const cfg = { ...config, devnetUrl };

  // 2. Demo accounts (buyer + seller, 1000 CSPR each).
  const accounts = await createDemoAccounts({ devnetUrl });

  // 3. Oracle (RWA feed).
  const oracle = await startOracle({ config: cfg });
  running.push({ name: 'oracle', close: oracle.close });
  console.log(`oracle      → http://localhost:${oracle.port}/feed${cfg.oracleStatic ? '  (static fixture mode)' : ''}`);

  // 4. Middleware (402 paywall gateway).
  const chain = createChainClient(cfg);
  const middleware = await startMiddleware({ config: cfg, chain });
  running.push({ name: 'middleware', close: middleware.close });
  console.log(`middleware  → http://localhost:${middleware.port}`);

  const line = '─'.repeat(72);

  // 5. Optional seed: wrap the oracle + run one paid call so the dashboard has
  //    live data immediately (mirrors `npm run demo`, but the stack STAYS UP).
  if (SEED) {
    console.log('\nseeding the dashboard (wrap → 402 → pay → serve → attest)…');
    const sellerSigner: AnySigner = { kind: 'mock', publicKey: accounts.seller.publicKey };
    const buyerSigner: AnySigner = { kind: 'mock', publicKey: accounts.buyer.publicKey };

    const wrapped = await wrapService({
      upstreamUrl: `http://localhost:${oracle.port}/feed`,
      priceCspr: '0.5',
      name: 'RWA FX & Gold Oracle',
      description: 'USD/IDR exchange rate and gold (XAU/USD) spot price feed with confidence scoring',
      gateway: `http://localhost:${middleware.port}`,
      dashboardBaseUrl: `http://localhost:${cfg.dashboardPort}`,
      chain,
      signer: sellerSigner,
      adminToken: cfg.adminToken,
    });
    if (!wrapped.adminOk) {
      console.warn(`  ⚠ upstream mapping failed: ${wrapped.adminWarning ?? 'unknown'} (service still registered)`);
    }

    const report = await runBuyerAgent({
      task: SEED_TASK,
      budgetCspr: cfg.buyerBudgetCspr,
      chain,
      signer: buyerSigner,
      llm: new MockLlm(),
      config: cfg,
    });
    const score = await chain.getScore(wrapped.serviceId);

    console.log(`
${line}
AgentGate dev stack is up (mock mode) — SEEDED and ready to view.

  service #${wrapped.serviceId}   ${wrapped.publicUrl}
  paid call    ${report.paid ? formatCspr(report.spentMotes) + ' · deploy ' + String(report.deployHash).slice(0, 16) + '…' : 'FAILED'}
  attestation  ${report.attestationTxHash ? String(report.attestationTxHash).slice(0, 16) + '…' : 'pending'}
  score        ${score.successCalls}/${score.totalCalls} (success/total)

▶ Open the dashboard:  npm run dev:dashboard   →  http://localhost:${cfg.dashboardPort}
  (the stack stays up; the dashboard polls it live every 5s)

Re-run the buyer agent any time to watch the score climb:
  ${accounts.exportLines[0]}
  ${accounts.exportLines[1]}
  npm run agent -- --task "${SEED_TASK}"

Ctrl+C stops everything.
${line}`);
    return;
  }

  console.log(`
${line}
AgentGate dev stack is up (mock mode).

Tip: run \`npm run dev:seed\` instead to auto-populate the dashboard in one step.

1. Export the demo accounts (paste into the shell you run commands from):

   ${accounts.exportLines[0]}
   ${accounts.exportLines[1]}

2. Wrap the oracle behind the 402 paywall:

   npm run agentgate -- wrap http://localhost:${oracle.port}/feed \\
     --price 0.5 --name "RWA FX & Gold Oracle" \\
     --description "USD/IDR exchange rate and gold (XAU/USD) spot price feed"

3. Let the buyer agent discover + pay for it:

   npm run agent -- --task "${SEED_TASK}"

4. Watch it live on the dashboard:

   npm run dev:dashboard   →  http://localhost:${cfg.dashboardPort}

Ctrl+C stops everything.
${line}`);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main().catch(async (err) => {
  console.error('dev stack failed to start:', err instanceof Error ? err.message : err);
  if (err instanceof Error && /EADDRINUSE/.test(err.message)) {
    console.error('a port is already in use — stop the other process or change *_PORT in .env');
  }
  await shutdown(1);
});
