/**
 * Phase 2 · register the first service on the v2 registry with a multi-asset
 * accepts[] (native CSPR + WCSPR). Encoding confirmed against PaymentOption's
 * CLType via scripts/sdk-clvalue-probe.ts:
 *   accepts = List< Tuple2< Tuple3<String,U512,U8>, Tuple3<String,String,String> > >
 * which serializes byte-for-byte as the contract's PaymentOption::from_bytes.
 *
 * A Success tx proves the full on-chain accepts[] path: encode → contract
 * validates (non-empty, each amount >= 1000) → stores the Service.
 *
 * Run: npx tsx --env-file=.env scripts/register-service-v2.ts
 * Costs ~5 CSPR (gate key). Does NOT touch the live gateway.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const req = createRequire(import.meta.url);
const { Args, CLValue, Key, KeyAlgorithm, PrivateKey, RpcClient, HttpHandler, ContractCallBuilder } =
  req('casper-js-sdk');

const NODE = process.env.CASPER_NODE_URL;
const NETWORK = process.env.CASPER_NETWORK ?? 'casper-test';
const PEM = process.env.GATE_SIGNER_PEM_PATH;
if (!NODE || !PEM) throw new Error('run with --env-file=.env');

const V2_PKG = 'e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df';
const GATE_ACCT = 'account-hash-19ffec2c950f361d7e4d66bb1b088d953278b21dfebcb3123f7cd401fb81b5f0';
const WCSPR = 'hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e';

/** One PaymentOption as Tuple2<Tuple3<String,U512,U8>, Tuple3<String,String,String>>. */
function opt(asset: string, amount: number, decimals: number, symbol: string, name: string, version: string) {
  return CLValue.newCLTuple2(
    CLValue.newCLTuple3(asciiString(asset), CLValue.newCLUInt512(amount), CLValue.newCLUint8(decimals)),
    CLValue.newCLTuple3(asciiString(symbol), asciiString(name), asciiString(version)),
  );
}

/**
 * casper-js-sdk 5.0.12 CLString bug: the u32 length prefix is `str.length`
 * (UTF-16 code units) while the payload is UTF-8 — any non-ASCII char makes
 * the declared length shorter than the payload, and the contract reverts
 * ExecutionError::LeftOverBytes (64649). Root cause of the three failed
 * register txs (the em dash in the old description). Guard until the SDK fix.
 */
function asciiString(s: string) {
  if (/[^\x00-\x7F]/.test(s)) throw new Error(`non-ASCII char in on-chain string (sdk CLString length bug): ${s}`);
  return CLValue.newCLString(s);
}

const accepts = [
  opt('native', 2_500_000_000, 9, 'CSPR', 'CSPR', ''),
  opt(WCSPR, 100_000_000, 9, 'WCSPR', 'Wrapped CSPR', '1'),
];
const acceptsList = CLValue.newCLList(accepts[0].type, accepts);
const gateKey = CLValue.newCLKey(Key.newKey(GATE_ACCT));

const args = Args.fromMap({
  name: asciiString('Global Currency Feed (v2)'),
  description: asciiString('Live USD FX; pay in CSPR or WCSPR - on-chain accepts[]'),
  gateway_base_url: asciiString('https://gateway.example.org'),
  accepts: acceptsList,
  payment_target: gateKey,
  attestor: gateKey,
});

const key = PrivateKey.fromPem(readFileSync(PEM, 'utf8'), KeyAlgorithm.SECP256K1);
const rpc = new RpcClient(new HttpHandler(NODE));

const tx = new ContractCallBuilder()
  .from(key.publicKey)
  .byPackageHash(V2_PKG)
  .entryPoint('register_service')
  .runtimeArgs(args)
  .chainName(NETWORK)
  .payment(5_000_000_000)
  .build();
tx.sign(key);

console.log('registering "Global Currency Feed (v2)" with accepts=[2.5 CSPR, 0.1 WCSPR]…');
const res = await rpc.putTransaction(tx);
const hash = res?.rawJSON?.transaction_hash?.Version1 ?? res?.transactionHash ?? '(see below)';
console.log('register_service tx:', hash);
console.log(`\n→ check https://testnet.cspr.live/transaction/${hash}`);
console.log('   Status: Success  = accepts[] accepted + Service stored (on-chain accepts[] proven).');
console.log('   User error: 5    = InvalidPrice (encoding/amount problem).');
