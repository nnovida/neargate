/**
 * Phase 2 · Task 3 — register the remaining core services on the v2 registry,
 * sequentially (waiting for each tx) so the assigned ids are deterministic:
 *   #2 RWA FX & Gold Oracle   — native 2.5 CSPR
 *   #3 Live USD FX Rates      — native 2.5 CSPR
 *   #4 CoinGecko BTC/USD      — native 2.5 CSPR
 * (#1 Global Currency Feed (v2), native + WCSPR, was registered by
 * scripts/register-service-v2.ts — tx 38836425….)
 *
 * Run: npx tsx --env-file=.env scripts/register-core-services-v2.ts
 * Costs ~5 CSPR per service (gate key). Does NOT touch the live gateway.
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

/** casper-js-sdk 5.0.12 CLString bug guard: length prefix is UTF-16 units, payload UTF-8. */
function asciiString(s: string) {
  if (/[^\x00-\x7F]/.test(s)) throw new Error(`non-ASCII char in on-chain string (sdk CLString length bug): ${s}`);
  return CLValue.newCLString(s);
}

/** One PaymentOption as Tuple2<Tuple3<String,U512,U8>, Tuple3<String,String,String>>. */
function opt(asset: string, amount: number, decimals: number, symbol: string, name: string, version: string) {
  return CLValue.newCLTuple2(
    CLValue.newCLTuple3(asciiString(asset), CLValue.newCLUInt512(amount), CLValue.newCLUint8(decimals)),
    CLValue.newCLTuple3(asciiString(symbol), asciiString(name), asciiString(version)),
  );
}

const nativeOpt = () => opt('native', 2_500_000_000, 9, 'CSPR', 'CSPR', '');

const SERVICES: Array<{ name: string; description: string }> = [
  {
    name: 'RWA FX & Gold Oracle',
    description:
      'Live USD spot rates for 340+ currencies including IDR and gold (XAU) - pay per call in native CSPR',
  },
  {
    name: 'Live USD FX Rates',
    description: 'Live USD exchange rates for 160+ currencies incl IDR - pay per call in native CSPR',
  },
  { name: 'CoinGecko BTC/USD', description: 'Live BTC spot price in USD (CoinGecko)' },
];

const key = PrivateKey.fromPem(readFileSync(PEM, 'utf8'), KeyAlgorithm.SECP256K1);
const rpc = new RpcClient(new HttpHandler(NODE));

async function rawRpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(NODE!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return await r.json();
}

function findError(node: unknown): string | null {
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec['error_message'] === 'string') return rec['error_message'] as string;
    for (const v of Object.values(rec)) {
      const hit = findError(v);
      if (hit) return hit;
    }
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findError(item);
      if (hit) return hit;
    }
  }
  return null;
}

async function waitExecuted(hash: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const r = await rawRpc('info_get_transaction', {
      transaction_hash: { Version1: hash },
      finalized_approvals: false,
    });
    const info = r.result?.execution_info;
    if (info) {
      const err = findError(info);
      if (err) throw new Error(`tx ${hash} failed: ${err}`);
      return;
    }
    await new Promise((res) => setTimeout(res, 5_000));
  }
  throw new Error(`tx ${hash} not executed after 200s`);
}

async function register(svc: { name: string; description: string }): Promise<string> {
  const gateKey = CLValue.newCLKey(Key.newKey(GATE_ACCT));
  const accepts = [nativeOpt()];
  const args = Args.fromMap({
    name: asciiString(svc.name),
    description: asciiString(svc.description),
    gateway_base_url: asciiString('https://gateway.example.org'),
    accepts: CLValue.newCLList(accepts[0].type, accepts),
    payment_target: gateKey,
    attestor: gateKey,
  });
  const tx = new ContractCallBuilder()
    .from(key.publicKey)
    .byPackageHash(V2_PKG)
    .entryPoint('register_service')
    .runtimeArgs(args)
    .chainName(NETWORK)
    .payment(5_000_000_000)
    .build();
  tx.sign(key);
  const res = await rpc.putTransaction(tx);
  return res?.rawJSON?.transaction_hash?.Version1 ?? String(res?.transactionHash ?? '');
}

for (const svc of SERVICES) {
  console.log(`registering "${svc.name}" (native 2.5 CSPR)…`);
  const hash = await register(svc);
  console.log(`  tx ${hash} — waiting for execution…`);
  await waitExecuted(hash);
  console.log('  ✅ Success');
}
console.log('\nAll core services registered on v2.');
