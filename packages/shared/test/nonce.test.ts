import { describe, expect, it } from 'vitest';
import { isValidNonce, randomNonce } from '../src/index';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1

describe('randomNonce', () => {
  it('returns a plain decimal string', () => {
    const n = randomNonce();
    expect(n).toMatch(/^\d+$/);
    expect(n.startsWith('0')).toBe(false);
  });

  it('is a positive safe integer that survives a JSON float64 round-trip exactly', () => {
    // A nonce above Number.MAX_SAFE_INTEGER would lose its low digits in any
    // consumer that parses it as a JS number. Every nonce must round-trip
    // through float64 and satisfy the registry's `^[0-9]{1,20}$` rule.
    for (let i = 0; i < 2000; i++) {
      const n = randomNonce();
      expect(n).toMatch(/^[0-9]{1,20}$/);
      const v = BigInt(n);
      expect(v >= 1n).toBe(true);
      expect(v <= MAX_SAFE).toBe(true);
      expect(String(Number(n))).toBe(n);
    }
  });

  it('produces effectively unique values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomNonce());
    expect(seen.size).toBe(1000);
  });
});

describe('isValidNonce (the registry contract rule)', () => {
  it('accepts 1–20 decimal digits', () => {
    for (const n of ['0', '1', '42', '007', '9'.repeat(20), '18446744073709551615']) {
      expect(isValidNonce(n), n).toBe(true);
    }
  });

  it('rejects empty, too long, signed, fractional, spaced or non-decimal input', () => {
    for (const n of ['', '1'.repeat(21), '-1', '+1', '1.5', ' 1', '1 ', '1e3', '0x10', '12a', '١٢']) {
      expect(isValidNonce(n), JSON.stringify(n)).toBe(false);
    }
  });

  it('accepts every randomNonce()', () => {
    for (let i = 0; i < 100; i++) expect(isValidNonce(randomNonce())).toBe(true);
  });
});
