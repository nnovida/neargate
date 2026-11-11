/**
 * Base58 with the Bitcoin alphabet, the encoding NEAR uses for tx hashes, block
 * hashes and ed25519 keys. Pure TypeScript with no Node-only imports, because the
 * dashboard bundles this package for the browser.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** ASCII char code → digit value, or -1 for a char outside the alphabet. */
const DIGITS: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Encodes bytes as base58. Each leading zero byte becomes a leading '1'. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Base-58 digits of the remaining big-endian number, least significant first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += ALPHABET[digits[k] ?? 0];
  return out;
}

/**
 * Decodes a base58 string. Each leading '1' becomes a leading zero byte.
 * Throws on any char outside the alphabet (`0`, `O`, `I`, `l`, whitespace, …).
 */
export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  // Base-256 digits of the remaining number, least significant first.
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const value = code < 128 ? (DIGITS[code] ?? -1) : -1;
    if (value < 0) {
      throw new Error(`invalid base58 character ${JSON.stringify(s[i])} at index ${i}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[zeros + k] = bytes[bytes.length - 1 - k] ?? 0;
  return out;
}
