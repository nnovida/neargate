import { describe, expect, it } from 'vitest';
import { odraDictionaryItemKey } from '../src/live';

/** Little-endian u64 bytes — Casper `ToBytes` for a u64 Mapping key. */
function u64le(value: number | bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(value), true);
  return new Uint8Array(buf);
}

// Field indices MUST match STATE_INDEX in src/live.ts. Odra 2.x numbers module
// fields 1-based in declaration order (odra-macros `idx as u8 + 1`); the registry
// declares services_count(1), services(2), scores(3), ...
const IDX = { servicesCount: 1, services: 2, scores: 3 } as const;

// Golden Odra (2.7.2/2.8.1, identical codec) dictionary item keys. Derived from
// the contract's pinned odra-core source: ContractEnv::index_bytes() packs a
// top-level field's 1-based index as a 4-byte BIG-ENDIAN u32 (e.g. field 1 ->
// [0,0,0,1]); current_key() = lowercase-hex( blake2b-256( index_bytes ++
// mapping_key_bytes ) ), where a u64 mapping key serializes as 8 little-endian
// bytes. These literals were reproduced independently (blake2b over the spec'd
// preimage at indices 1/2/3) and cross-checked against the source audit of
// odra-macros/src/ir/mod.rs and odra-core/src/contract_env.rs.
// ⚠️ confirm once against a real testnet deploy (docs/DEPLOY.md read-path smoke
// test) — the deploy itself is out of scope.
const GOLDEN = {
  servicesCount: '270c07945707b0a86fdbd6930e7bb3cae8978a3bcfb6659e8062ef39ec58c32a',
  services_1: '7c9f83438e00d21d2b7077bec35918c7cd331ea9d3c47d7523bd56ab3e417d1c',
  services_2: '8201b3ea3161edca697d62fc678e5e5e6fec7bcc8ee051d659a98c89e6f414c4',
  scores_1: 'e064b7dc87f03112310d65def6ed7cdc09273d595fef9e48798fc8701f57b009',
} as const;

// --- regression guards for two historical bugs in this derivation -------------
// (1) Single-byte index prefix instead of a 4-byte big-endian u32.
const ONE_BYTE_PREFIX_BUG_SERVICES_COUNT =
  'ee155ace9c40292074cb6aff8c9ccdd273c81648ff1149ef36bcea6ebb8a3e25';
// (2) 0-based field indices instead of Odra's 1-based numbering. This is the key
// the WRONG code produced for services_count (field index 0); it must never be
// what we derive for the real (1-based) services_count field again.
const ZERO_BASED_INDEX_BUG_SERVICES_COUNT =
  '11da6d1f761ddf9bdb4c9d6e5303ebd41f61858d0a5647a1a7bfe089bf921be9';

describe('odraDictionaryItemKey — Odra 2.x module-state key derivation', () => {
  it('derives the services_count Var key (1-based field index 1, no mapping key)', () => {
    expect(odraDictionaryItemKey(IDX.servicesCount)).toBe(GOLDEN.servicesCount);
  });

  it('derives services[id] Mapping keys (field index 2 ++ u64-LE id)', () => {
    expect(odraDictionaryItemKey(IDX.services, u64le(1))).toBe(GOLDEN.services_1);
    expect(odraDictionaryItemKey(IDX.services, u64le(2))).toBe(GOLDEN.services_2);
  });

  it('derives scores[id] Mapping keys (field index 3 ++ u64-LE id)', () => {
    expect(odraDictionaryItemKey(IDX.scores, u64le(1))).toBe(GOLDEN.scores_1);
  });

  it('does not regress to the 1-byte-index-prefix derivation', () => {
    expect(odraDictionaryItemKey(IDX.servicesCount)).not.toBe(
      ONE_BYTE_PREFIX_BUG_SERVICES_COUNT,
    );
  });

  it('does not regress to 0-based field indices', () => {
    // Field index 0 is the old, wrong servicesCount key — the real field is 1.
    expect(odraDictionaryItemKey(0)).toBe(ZERO_BASED_INDEX_BUG_SERVICES_COUNT);
    expect(odraDictionaryItemKey(IDX.servicesCount)).not.toBe(
      ZERO_BASED_INDEX_BUG_SERVICES_COUNT,
    );
  });

  it('keeps services[id] and scores[id] in distinct dictionary slots (no collision)', () => {
    // The 0-based bug made scores use index 2 — colliding byte-for-byte with the
    // real services index 2. With 1-based indices they must differ.
    expect(odraDictionaryItemKey(IDX.services, u64le(1))).not.toBe(
      odraDictionaryItemKey(IDX.scores, u64le(1)),
    );
  });
});
