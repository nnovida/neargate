/**
 * Phase 2 · Task 1 — install AgentGateRegistry v2 as an UNLOCKED (upgradable)
 * Casper Testnet package.
 *
 * WHY a hand-written casper-js-sdk install (not `cargo run --bin ..._deploy`):
 * the odra-cli `load_or_deploy` path produced a LOCKED package (that is why the
 * live registry hash-10f92725… cannot be upgraded). Passing Odra's control args
 * `odra_cfg_is_upgradable=true` at install yields an UNLOCKED package — the same
 * route the Cep18X402 token was installed with.
 *
 * Run (Bash):
 *   npx tsx --env-file=.env scripts/deploy-registry-v2.ts
 *
 * Needs from .env: CASPER_NODE_URL, CASPER_NETWORK (casper-test),
 *   GATE_SIGNER_PEM_PATH (secp256k1; the package owner/deployer, ~300 CSPR gas).
 *
 * SAFETY: this ONLY installs + prints the new package hash. It does NOT repoint
 * anything. Verify lock_status==Unlocked (Phase-2 Task 2) before any cutover.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const req = createRequire(import.meta.url);
const sdk = req('casper-js-sdk');
const { Args, CLValue, KeyAlgorithm, PrivateKey, RpcClient, HttpHandler, SessionBuilder } = sdk;

const NODE = process.env.CASPER_NODE_URL;
const NETWORK = process.env.CASPER_NETWORK ?? 'casper-test';
const PEM = process.env.GATE_SIGNER_PEM_PATH;
const WASM = 'contracts/agentgate-registry/wasm/AgentGateRegistry.wasm';
const GAS_MOTES = 300_000_000_000; // ~300 CSPR install budget (unspent is refunded)
const PKG_KEY_NAME = 'agentgate_registry_package_hash';

if (!NODE || !PEM) {
  throw new Error('missing CASPER_NODE_URL or GATE_SIGNER_PEM_PATH — run with --env-file=.env');
}

const wasm = readFileSync(WASM);
console.log(`wasm:    ${WASM} (${wasm.length} bytes)`);
console.log(`network: ${NETWORK}`);
console.log(`node:    ${NODE}`);

const key = PrivateKey.fromPem(readFileSync(PEM, 'utf8'), KeyAlgorithm.SECP256K1);
console.log(`deployer:${key.publicKey.toHex()}`);

const rpc = new RpcClient(new HttpHandler(NODE));

// Odra control args — this set produces an UNLOCKED (upgradable) package.
// AgentGateRegistry's constructor is NoArgs, so there are no constructor args.
const args = Args.fromMap({
  odra_cfg_package_hash_key_name: CLValue.newCLString(PKG_KEY_NAME),
  odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
  odra_cfg_is_upgradable: CLValue.newCLValueBool(true),
  odra_cfg_is_upgrade: CLValue.newCLValueBool(false),
});

const tx = new SessionBuilder()
  .from(key.publicKey)
  .chainName(NETWORK)
  .wasm(new Uint8Array(wasm))
  .installOrUpgrade()
  .runtimeArgs(args)
  .payment(GAS_MOTES)
  .build();

tx.sign(key);

console.log('\nsubmitting install…');
const res = await rpc.putTransaction(tx);
// putTransaction result shape varies by SDK minor; log the whole thing so the
// first shakeout run reveals the exact hash field.
console.log('putTransaction result:', JSON.stringify(res, null, 2));

const hash =
  res?.transactionHash?.toHex?.() ??
  res?.transactionHash ??
  res?.transaction_hash ??
  tx.hash?.toHex?.() ??
  '(see result above)';
console.log(`\ntransaction hash: ${hash}`);
console.log('→ wait for finality on https://testnet.cspr.live, then run the Phase-2 Task-2 verify:');
console.log(`   query the account's named key "${PKG_KEY_NAME}" for the new package hash,`);
console.log('   then query_global_state on hash-<pkg> and confirm lock_status == Unlocked.');
