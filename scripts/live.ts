/**
 * Boots the gateway (402 paywall middleware) in LIVE mode against the deployed
 * NEAR testnet registry. The mock dev stack is `npm run dev`; this is its live
 * counterpart for testing against the real on-chain contract.
 *
 * Reads config from the root `.env` (the repo has no dotenv dependency, so this
 * loads it explicitly; see .env.example). Requires AGENTGATE_MODE=live +
 * REGISTRY_CONTRACT_ID + GATEWAY_ACCOUNT_ID with GATEWAY_KEY_PATH,
 * GATEWAY_PRIVATE_KEY or ~/.near-credentials (for attestations) + a non-default
 * AGENTGATE_ADMIN_TOKEN.
 */
import { loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { loadDotenv } from './near/dotenv';

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
  const base = `http://localhost:${mw.port}`;
  console.log(`\nNearGate gateway LIVE on ${base}  (network ${chain.network})`);
  console.log(`registry contract: ${chain.registryId}`);
  console.log(`attests as:        ${config.gatewayAccountId}`);
  console.log('\nNext steps:');
  console.log('  # 1. Seed one real register -> pay -> attest triple. The registry stores the gateway URL');
  console.log('  #    for good, so GATEWAY_PUBLIC_URL must be the URL this gateway is reached at:');
  console.log('  npm run near:seed');
  console.log('  # 2. Or wrap a PUBLIC API yourself (live-mode SSRF blocks localhost upstreams):');
  console.log('  npm run neargate -- wrap https://open.er-api.com/v6/latest/USD --price 0.01 \\');
  console.log(`    --name "USD rates" --gateway <public gateway URL>`);
  console.log('  # 3. Hit the x402 paywall, then read the attestation receipt by invoice nonce:');
  console.log(`  curl -i ${base}/svc/<id>`);
  console.log(`  curl ${base}/receipts/<nonce>`);
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
