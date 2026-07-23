/**
 * Phase 2 · binaryen gate — prove the v2 wasm EXECUTES on-chain (stored call).
 *
 * Calls record_attestation(999, ...) on the v2 package. Service 999 does not
 * exist, so the contract reverts ServiceNotFound (Odra user error 2) — but that
 * revert means the wasm LOADED AND RAN. If instead the tx fails with a wasm /
 * "sections out of order" error, the binaryen section-order bug is present and
 * we must rebuild the wasm before re-registering anything.
 *
 * Run: npx tsx --env-file=.env scripts/gate-storedcall-test.ts
 * Costs ~3 CSPR (a reverting stored call still pays gas).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const req = createRequire(import.meta.url);
const { Args, CLValue, KeyAlgorithm, PrivateKey, RpcClient, HttpHandler, ContractCallBuilder } =
  req('casper-js-sdk');

const NODE = process.env.CASPER_NODE_URL;
const NETWORK = process.env.CASPER_NETWORK ?? 'casper-test';
const PEM = process.env.GATE_SIGNER_PEM_PATH;
const PKG = 'e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df'; // v2 package
if (!NODE || !PEM) throw new Error('run with --env-file=.env');

const key = PrivateKey.fromPem(readFileSync(PEM, 'utf8'), KeyAlgorithm.SECP256K1);
const rpc = new RpcClient(new HttpHandler(NODE));

const args = Args.fromMap({
  service_id: CLValue.newCLUint64(999),
  payment_deploy_hash: CLValue.newCLString('binaryen-gate-test'),
  success: CLValue.newCLValueBool(true),
});

const tx = new ContractCallBuilder()
  .from(key.publicKey)
  .byPackageHash(PKG)
  .entryPoint('record_attestation')
  .runtimeArgs(args)
  .chainName(NETWORK)
  .payment(3_000_000_000)
  .build();
tx.sign(key);

console.log('calling record_attestation(999) on v2 (expect a ServiceNotFound revert)…');
const res = await rpc.putTransaction(tx);
const hash = res?.transactionHash ?? res?.rawJSON?.transaction_hash?.Version1 ?? '(see below)';
console.log('tx hash:', hash);
console.log(JSON.stringify(res, null, 2));
console.log(`\n→ check https://testnet.cspr.live/transaction/${hash}`);
console.log('   PASS if it FAILED with "User error: 2" / ServiceNotFound (wasm executed).');
console.log('   FAIL (binaryen bug) if the error mentions wasm / "sections out of order".');
