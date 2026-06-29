/**
 * Boots the AgentGate gateway (402 paywall middleware) in LIVE mode against the
 * deployed Casper Testnet registry. The mock dev stack is `npm run dev`; this is
 * its live counterpart for testing against the real on-chain contract.
 *
 * Reads config from the root `.env` (the repo has no dotenv dependency, so this
 * loads it explicitly). Requires AGENTGATE_MODE=live + REGISTRY_CONTRACT_PACKAGE_HASH
 * + CSPR_CLOUD_API_KEY + GATE_SIGNER_PEM_PATH (for attestations) + a non-default
 * AGENTGATE_ADMIN_TOKEN.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';
import { startServer as startMiddleware } from '@agentgate/middleware';

/** Minimal `.env` loader (KEY=VALUE lines; existing env vars win). */
function loadDotenv(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no .env — rely on the ambient environment
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  if (config.mode !== 'live') {
    console.error(
      'AGENTGATE_MODE is not "live" — set it in .env. (Use `npm run dev` for the mock stack.)',
    );
    process.exit(1);
  }
  const chain = createChainClient(config);
  const mw = await startMiddleware({ config, chain });
  console.log(`\nAgentGate gateway LIVE on http://localhost:${mw.port}  (network ${config.casperNetwork})`);
  console.log(`registry package: ${config.registryContractPackageHash}`);
  console.log('\nNext steps:');
  console.log('  # 1. Map a service to a PUBLIC upstream (live-mode SSRF blocks localhost):');
  console.log(`  curl -X POST http://localhost:${mw.port}/admin/services \\`);
  console.log('    -H "authorization: Bearer $AGENTGATE_ADMIN_TOKEN" -H "content-type: application/json" \\');
  console.log('    -d \'{"serviceId":1,"upstreamUrl":"https://open.er-api.com/v6/latest/USD"}\'');
  console.log(`  # 2. Hit the x402 paywall:`);
  console.log(`  curl -i http://localhost:${mw.port}/svc/1`);
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
