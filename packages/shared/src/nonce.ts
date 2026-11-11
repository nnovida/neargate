/** The registry contract's nonce rule. */
const NONCE_RE = /^[0-9]{1,20}$/;

/** 2^53 − 2 — the modulus cap keeping a nonce ≤ Number.MAX_SAFE_INTEGER − 1. */
const SAFE_NONCE_MODULUS = 9_007_199_254_740_990n;

/** Same rule as the registry contract: 1–20 decimal digits (`^[0-9]{1,20}$`). */
export function isValidNonce(nonce: string): boolean {
  return NONCE_RE.test(nonce);
}

/**
 * Random payment nonce: a positive integer (`1 … 2^53−2`) as a decimal string.
 * The buyer passes it to the registry's `pay(service_id, nonce)`, which binds
 * the payment to its invoice; it satisfies the contract's `^[0-9]{1,20}$` rule.
 * It is capped below 2^53 on purpose so any JSON consumer that reads it as a
 * number (float64) still sees it exactly. 52+ bits of WebCrypto secure-random entropy
 * is ample for a single-use, short-TTL nonce.
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
