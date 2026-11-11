import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode } from '../src/index';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bitcoin Core's base58 test vectors (hex ↔ base58). */
const VECTORS: Array<[string, string]> = [
  ['', ''],
  ['61', '2g'],
  ['626262', 'a3gV'],
  ['636363', 'aPEr'],
  ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
  ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ['516b6fcd0f', 'ABnLTmg'],
  ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
  ['572e4794', '3EFU7m'],
  ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
  ['10c8511e', 'Rt5zm'],
  ['00000000000000000000', '1111111111'],
  [
    '000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5',
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
  ],
];

describe('base58', () => {
  it('encodes and decodes the known vectors', () => {
    for (const [h, b58] of VECTORS) {
      expect(base58Encode(fromHex(h)), h).toBe(b58);
      expect(hex(base58Decode(b58)), b58).toBe(h);
    }
  });

  it('maps the empty input to the empty output', () => {
    expect(base58Encode(new Uint8Array(0))).toBe('');
    expect(base58Decode('')).toEqual(new Uint8Array(0));
  });

  it("maps each leading zero byte to a leading '1' and back", () => {
    expect(base58Encode(Uint8Array.of(0))).toBe('1');
    expect(base58Encode(Uint8Array.of(0, 0, 0, 1))).toBe('1112');
    expect(base58Encode(new Uint8Array(32))).toBe('1'.repeat(32));
    expect(base58Decode('1112')).toEqual(Uint8Array.of(0, 0, 0, 1));
    expect(base58Decode('1'.repeat(32))).toEqual(new Uint8Array(32));
    // A real 42-char NEAR tx hash: one leading zero byte, 32 bytes in all.
    const leadingZero = base58Decode('1tJ93RwaVfE1PEMxd5rpZZuPtLCwbEaDCrNBhAy8Cw');
    expect(leadingZero.length).toBe(32);
    expect(hex(leadingZero)).toBe('0001' + '00'.repeat(30));
  });

  it('round-trips random 32-byte values, with and without leading zero bytes', () => {
    for (let i = 0; i < 256; i++) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      bytes.fill(0, 0, i % 4); // every fourth value has no leading zero; others have 1–3
      const encoded = base58Encode(bytes);
      expect(encoded.length).toBeLessThanOrEqual(44);
      expect(base58Decode(encoded)).toEqual(bytes);
    }
  });

  it('decodes 44 chars of a high digit to 33 bytes (not a 32-byte hash)', () => {
    expect(base58Decode('z'.repeat(44)).length).toBe(33);
  });

  it('throws on a char outside the alphabet', () => {
    for (const s of ['0', 'O', 'I', 'l', 'abc0', 'abcO', 'abcI', 'abcl', ' 2g', '2g ', '+', 'é', '1\u0000']) {
      expect(() => base58Decode(s), JSON.stringify(s)).toThrow(/invalid base58 character/);
    }
  });
});
