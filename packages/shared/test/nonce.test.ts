import { describe, expect, it } from 'vitest';
import { randomNonce } from '../src/index';

const U63_MAX = (1n << 63n) - 1n; // 9223372036854775807
const U64_MAX = (1n << 64n) - 1n;

describe('randomNonce', () => {
  it('returns a plain decimal string', () => {
    const n = randomNonce();
    expect(n).toMatch(/^\d+$/);
    // No leading zeros unless the value itself is 0.
    if (n !== '0') expect(n.startsWith('0')).toBe(false);
  });

  it('stays within the 63-bit range (always a valid u64 transfer_id)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = BigInt(randomNonce());
      expect(v >= 0n).toBe(true);
      expect(v <= U63_MAX).toBe(true);
      expect(v <= U64_MAX).toBe(true);
    }
  });

  it('produces effectively unique values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomNonce());
    expect(seen.size).toBe(1000);
  });
});
