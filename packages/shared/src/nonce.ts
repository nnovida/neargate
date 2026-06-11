/**
 * Random payment nonce: a 63-bit unsigned integer as a decimal string.
 * 63 bits keeps it safely inside the valid u64 `transfer_id` range on Casper
 * while avoiding any sign-bit ambiguity in downstream tooling.
 * Sourced from the WebCrypto CSPRNG (global in Node >= 19).
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  // Clear the top bit → value < 2^63.
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value.toString();
}
