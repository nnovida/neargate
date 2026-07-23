/**
 * Phase 3 · diagnosis — ground truth from the chain for the multi-asset blocker.
 *
 * For the three register_service txs on the v2 registry, fetch from node RPC:
 *   1. the REAL execution result (were the 1-option registers actually a success?
 *      the earlier CSPR.cloud /transactions curl showed None/None which may have
 *      been an empty envelope, not a success), and
 *   2. the EXACT `accepts` arg bytes as the node stored them — compared against
 *      the bytes we believe the SDK sent. If they differ, the casper-js-sdk
 *      TransactionV1 args path re-serializes lists wrongly; if identical, the
 *      problem is contract/Odra-side and we reproduce it in a local Rust test.
 *
 * No gas, no key needed. Run:
 *   npx tsx --env-file=.env scripts/inspect-v2-txs.ts
 */
export {};
const NODE = process.env.CASPER_NODE_URL ?? 'https://node.testnet.casper.network/rpc';

const TXS: Array<{ label: string; hash: string; expect: string }> = [
  {
    label: '2-opt native+WCSPR (explorer says 64649 LeftOverBytes)',
    hash: 'b8861abff89cc63d2478d2bcc5f623605a8a0c14c39526f051ea0f164291fa7f',
    expect:
      '02000000060000006e61746976650400f9029509040000004353505204000000435350520000000045000000686173682d336438306466323162613465653464363661326131663630633332353730646435363835653462323739663635333831363261356664313331343834376331650400e1f505090500000057435350520c0000005772617070656420435350520100000031',
  },
  {
    label: '1-opt native (claimed success — UNVERIFIED)',
    hash: 'a6bec5c750e9061ded02e0e6d4a8842c92052ad86f745512cbddf7e31c49b67a',
    expect:
      '01000000060000006e61746976650400f90295090400000043535052040000004353505200000000',
  },
  {
    label: '1-opt WCSPR (claimed success — UNVERIFIED)',
    hash: 'e6fb323e05dc2a9949157d763032843aff7a3e70341b4b3f7e2225d2aae177a3',
    expect:
      '0100000045000000686173682d336438306466323162613465653464363661326131663630633332353730646435363835653462323739663635333831363261356664313331343834376331650400e1f505090500000057435350520c0000005772617070656420435350520100000031',
  },
];

async function rpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(NODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return await r.json();
}

/** Depth-first hunt for the named arg entry ["accepts", {..bytes..}] anywhere in the tx JSON. */
function findAcceptsBytes(node: unknown): string | null {
  if (Array.isArray(node)) {
    if (node.length === 2 && node[0] === 'accepts' && node[1] && typeof node[1] === 'object') {
      const b = (node[1] as Record<string, unknown>)['bytes'];
      if (typeof b === 'string') return b;
    }
    for (const item of node) {
      const hit = findAcceptsBytes(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      const hit = findAcceptsBytes(v);
      if (hit) return hit;
    }
  }
  return null;
}

/** Hunt for an error_message string anywhere in execution_info. */
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

for (const { label, hash, expect } of TXS) {
  console.log(`\n===== ${label} =====`);
  console.log(`tx ${hash}`);
  const r = await rpc('info_get_transaction', {
    transaction_hash: { Version1: hash },
    finalized_approvals: false,
  });
  if (r.error) {
    console.log('RPC error:', r.error.message);
    continue;
  }
  const err = findError(r.result?.execution_info ?? null);
  console.log('execution error_message:', err ?? 'None (SUCCESS)');
  const got = findAcceptsBytes(r.result?.transaction ?? null);
  if (!got) {
    console.log('accepts arg: NOT FOUND in tx JSON (shape mismatch — dumping keys)');
    console.log(JSON.stringify(r.result?.transaction ?? {}).slice(0, 400));
    continue;
  }
  const match = got.toLowerCase() === expect.toLowerCase();
  console.log(`accepts bytes on-chain (${got.length / 2}B): ${got.slice(0, 64)}…`);
  console.log(`expected            (${expect.length / 2}B): ${expect.slice(0, 64)}…`);
  console.log(match ? '→ BYTES MATCH ✅ (client sent exactly what we built)' : '→ BYTES DIFFER ❌ (SDK re-serialized the list — this is the bug)');
  if (!match) {
    // Show where they diverge to pinpoint the SDK bug.
    let i = 0;
    while (i < Math.min(got.length, expect.length) && got[i]?.toLowerCase() === expect[i]?.toLowerCase()) i++;
    console.log(`   first divergence at hex offset ${i} (byte ${Math.floor(i / 2)})`);
    console.log(`   on-chain  …${got.slice(Math.max(0, i - 8), i + 24)}`);
    console.log(`   expected  …${expect.slice(Math.max(0, i - 8), i + 24)}`);
  }
}
