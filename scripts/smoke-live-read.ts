/**
 * F3 — live read-path smoke test. Run this AGAINST THE DEPLOYED CONTRACT before
 * trusting live reads (and before any mainnet move). Live-mode reads exercise
 * the byte-level Odra dictionary decode + CSPR.cloud REST shapes that the
 * mock/OdraVM test suite does NOT cover, so this is the gate that catches a
 * silent decode/index bug (e.g. scores[id] colliding with services[id]) which
 * would otherwise return plausible-but-wrong bytes rather than error.
 *
 * It reads getService / getScore / listServices from the deployed
 * AgentGateRegistry and compares them against the known on-chain truth from the
 * README "Deployed addresses" block, failing loudly (exit 1) on any decode
 * error or mismatch.
 *
 *   AGENTGATE_MODE=live REGISTRY_CONTRACT_PACKAGE_HASH=hash-… \
 *   [CSPR_CLOUD_API_KEY=…] npx tsx scripts/smoke-live-read.ts
 */
import { loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';

/** Known on-chain truth (README → "Deployed addresses (Casper Testnet)"). */
const EXPECTED = {
  serviceId: 1,
  // Service #1's score reads (1,1) after the recorded attestation and only grows.
  minTotalCalls: 1,
  minSuccessCalls: 1,
};

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.mode !== 'live') {
    throw new Error('smoke-live-read must run with AGENTGATE_MODE=live');
  }
  const chain = createChainClient(config);
  const problems: string[] = [];

  // 1) getService(1) must decode cleanly with sane fields.
  const service = await chain.getService(EXPECTED.serviceId);
  if (!service) {
    problems.push(`getService(${EXPECTED.serviceId}) returned null — expected the seeded service`);
  } else {
    console.log(`service #${service.id}: ${service.name}`);
    console.log(`  endpoint:       ${service.endpointUrl}`);
    console.log(`  price (motes):  ${service.priceMotes}`);
    console.log(`  payment target: ${service.paymentTarget}`);
    console.log(`  owner:          ${service.owner}`);
    console.log(`  attestor:       ${service.attestor}`);
    if (service.id !== EXPECTED.serviceId) problems.push(`service.id ${service.id} != ${EXPECTED.serviceId}`);
    if (!service.name || service.name.trim() === '') {
      problems.push('service.name is empty — possible dictionary-index collision (F3)');
    }
    if (!/^\d+$/.test(String(service.priceMotes))) {
      problems.push(`priceMotes is not a decimal string: ${service.priceMotes}`);
    }
    if (!service.paymentTarget.startsWith('account-hash-')) {
      problems.push(`paymentTarget is not an account-hash: ${service.paymentTarget}`);
    }
  }

  // 2) getScore(1) must be a sane (total, success) pair with success <= total.
  const score = await chain.getScore(EXPECTED.serviceId);
  console.log(`score: ${score.successCalls}/${score.totalCalls}`);
  if (!Number.isSafeInteger(score.totalCalls) || !Number.isSafeInteger(score.successCalls)) {
    problems.push(`score is not an integer pair: ${JSON.stringify(score)}`);
  }
  if (score.successCalls > score.totalCalls) {
    problems.push('successCalls > totalCalls — impossible; likely a decode/index bug');
  }
  if (score.totalCalls < EXPECTED.minTotalCalls) {
    problems.push(`totalCalls ${score.totalCalls} < expected ${EXPECTED.minTotalCalls}`);
  }
  if (score.successCalls < EXPECTED.minSuccessCalls) {
    problems.push(`successCalls ${score.successCalls} < expected ${EXPECTED.minSuccessCalls}`);
  }

  // 3) listServices() (the list decode path) must include the seeded service.
  const list = await chain.listServices();
  console.log(`listServices(): ${list.length} service(s)`);
  if (!list.some((s) => s.id === EXPECTED.serviceId)) {
    problems.push(`listServices() did not include service #${EXPECTED.serviceId}`);
  }

  if (problems.length > 0) {
    console.error('\nREAD-PATH SMOKE FAILED:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\n✓ read-path smoke passed — live decode matches on-chain truth');
}

main().catch((err: unknown) => {
  console.error('read-path smoke ERRORED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
