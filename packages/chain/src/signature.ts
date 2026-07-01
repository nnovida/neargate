import { PublicKey } from './sdk';

/** Decode a hex string (optionally `0x`-prefixed) to bytes; throws on malformed input. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface OwnerSignatureResult {
  /** account-hash derived from publicKeyHex ("account-hash-<64hex>"); '' if the key is unparseable. */
  accountHash: string;
  /** true only when the signature verifies under publicKeyHex over `message`. */
  valid: boolean;
}

/**
 * Verifies a Casper signature — produced by `PrivateKey.signAndAddAlgorithmBytes`
 * (algorithm-tag byte + raw sig) — over `message` under `publicKeyHex`, and
 * derives that key's account-hash for an owner check.
 *
 * Fully defensive: a malformed public key returns `{ accountHash: '', valid:
 * false }`; a malformed/forged signature returns `valid: false`
 * (casper-js-sdk's `verifySignature` THROWS on a bad sig, so it is wrapped).
 * NEVER throws — safe to call on fully untrusted input.
 */
export function verifyOwnerSignature(
  publicKeyHex: string,
  message: Uint8Array,
  signatureHex: string,
): OwnerSignatureResult {
  let pub: PublicKey;
  try {
    pub = PublicKey.fromHex(publicKeyHex);
  } catch {
    return { accountHash: '', valid: false };
  }
  const accountHash = pub.accountHash().toPrefixedString();
  let valid = false;
  try {
    valid = pub.verifySignature(message, hexToBytes(signatureHex));
  } catch {
    valid = false;
  }
  return { accountHash, valid };
}
