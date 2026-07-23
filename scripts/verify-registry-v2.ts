/**
 * Phase 2 · Task 2 — verify the v2 registry install: print the full stored
 * ContractPackage (lock_status + versions) reached via the gate account's
 * named key, and resolve the package HASH via state_get_entity.
 *
 * Run: npx tsx --env-file=.env scripts/verify-registry-v2.ts
 */
export {};
const NODE = process.env.CASPER_NODE_URL;
if (!NODE) throw new Error('missing CASPER_NODE_URL — run with --env-file=.env');

const GATE_ACCT = 'account-hash-19ffec2c950f361d7e4d66bb1b088d953278b21dfebcb3123f7cd401fb81b5f0';
const GATE_PUB = '0203df32380ac693d292a9a14cbda623e94eb93d743b5fcb6592b25fc74cd17c0018';
const PKG_KEY_NAME = 'agentgate_registry_package_hash';

async function call(method: string, params: unknown): Promise<any> {
  const r = await fetch(NODE!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return await r.json();
}

// 1) Dereference the named key → the ContractPackage itself (has lock_status).
console.log('=== query_global_state (named key → ContractPackage) ===');
const q = await call('query_global_state', { key: GATE_ACCT, path: [PKG_KEY_NAME] });
const cp = q.result?.stored_value?.ContractPackage ?? q.result?.stored_value?.Package;
if (cp) {
  console.log('lock_status:', cp.lock_status, cp.lock_status === 'Unlocked' ? '✅ UNLOCKED' : '❌');
  console.log('versions:', JSON.stringify(cp.versions ?? cp.versions_data ?? []));
  console.log('access_key:', cp.access_key);
} else {
  console.log('no ContractPackage; raw:', JSON.stringify(q.result ?? q.error).slice(0, 400));
}

// 2) Resolve the package HASH. The gate entity's named_keys came back empty
// (Casper 2.0 stores them apart), so derive it from the version's contract
// hash via CSPR.cloud /contracts/{hash} -> contract_package_hash.
console.log('\n=== resolve package hash (CSPR.cloud /contracts/{hash}) ===');
const contractHash = (cp?.versions ?? cp?.versions_data ?? [])
  .at(-1)
  ?.contract_hash?.replace(/^(entity-contract-|contract-)/, '');
const CLOUD = process.env.CSPR_CLOUD_API_URL;
const CKEY = process.env.CSPR_CLOUD_API_KEY;
let pkgHash = '';
if (contractHash && CLOUD && CKEY) {
  const r = await fetch(`${CLOUD}/contracts/${contractHash}`, { headers: { authorization: CKEY } });
  const j: any = await r.json();
  pkgHash = (j?.data?.contract_package_hash ?? '').replace(/^(hash-|package-)/, '');
  console.log(`contract ${contractHash.slice(0, 12)}… -> package:`, pkgHash || JSON.stringify(j).slice(0, 300));
} else {
  console.log('need CSPR_CLOUD_API_URL + CSPR_CLOUD_API_KEY (run with --env-file=.env)');
}

if (pkgHash && /^[0-9a-f]{64}$/.test(pkgHash)) {
  console.log(`\n✅ REGISTRY v2 package hash: hash-${pkgHash}`);
  console.log('   (Phase-2 Task-4 will set REGISTRY_CONTRACT_PACKAGE_HASH to this — AFTER Phase 3.)');
} else {
  console.log('\n(could not resolve a clean package hash; see raw above)');
}

