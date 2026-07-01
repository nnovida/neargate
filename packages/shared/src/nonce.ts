/** 2^53 − 2 — the modulus cap keeping a nonce ≤ Number.MAX_SAFE_INTEGER − 1. */
const SAFE_NONCE_MODULUS = 9_007_199_254_740_990n;

/**
 * Random payment nonce: a positive integer (`1 … 2^53−2`) as a decimal string,
 * used as the Casper native-transfer `transfer_id` that binds a payment to its
 * invoice. It is capped below 2^53 on purpose: CSPR.cloud returns a transfer's
 * `id` as a JSON **float64**, so a nonce above `Number.MAX_SAFE_INTEGER` loses
 * its low digits and could never be matched on verification. 52+ bits of
 * WebCrypto CSPRNG entropy is ample for a single-use, short-TTL nonce.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  // 1 … 2^53−2, exactly representable as a JSON float64 (avoids 0 = "no id").
  return ((value % SAFE_NONCE_MODULUS) + 1n).toString();
}
