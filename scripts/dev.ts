#!/usr/bin/env -S npx tsx
/**
 * scripts/dev.ts — local dev stack (SPEC §12).
 *
 * Boots, in order: devnet (mock chain) → seeds two faucet-funded demo accounts →
 * oracle → middleware (402 paywall gateway), all in-process, mock mode.
 * Prints the export lines + next steps, then stays up until SIGINT/SIGTERM.
 */
import { createChainClient } from '@agentgate/chain';
import { createDemoAccounts } from '@agentgate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import { loadConfig } from '@agentgate/shared';

// The dev stack is the mock loop by definition (SPEC §0: "mock mode").
process.env.AGENTGATE_MODE = 'mock';

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
  console.log(`
${line}
AgentGate dev stack is up (mock mode).

1. Export the demo accounts (paste into the shell you run commands from):

   ${accounts.exportLines[0]}
   ${accounts.exportLines[1]}

2. Wrap the oracle behind the 402 paywall:

   npm run agentgate -- wrap http://localhost:${oracle.port}/feed \\
     --price 0.5 --name "RWA FX & Gold Oracle" \\
     --description "USD/IDR exchange rate and gold (XAU/USD) spot price feed"

3. Let the buyer agent discover + pay for it:

   npm run agent -- --task "Get today's USD/IDR rate and gold price, summarize for a treasury report"

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
