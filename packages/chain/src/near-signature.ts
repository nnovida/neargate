import { PublicKey } from 'near-api-js';
import { isBase64, isEd25519PublicKey } from '@agentgate/shared';

const ED25519_SIGNATURE_BYTES = 64;

/**
 * True iff `signatureB64` (base64 of the 64-byte ed25519 signature) is a valid signature of
 * `message` by `publicKey` (`ed25519:<base58>`). It answers only "does this key's signature
 * check out": whether the key belongs to an account, and with which permission, is the caller's
 * chain lookup. Never throws: a malformed key, a non-base64 or wrong-length signature, a
 * non-ed25519 key or non-byte message is simply `false`.
 */
export function verifyNearSignature(publicKey: string, message: Uint8Array, signatureB64: string): boolean {
  try {
    // near-api-js reads an unprefixed key as ed25519; the wire format here always names the curve.
    if (!isEd25519PublicKey(publicKey) || !isBase64(signatureB64)) return false;
    if (!(message instanceof Uint8Array)) return false;
    const signature = new Uint8Array(Buffer.from(signatureB64, 'base64'));
    if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
    return PublicKey.fromString(publicKey).verify(message, signature);
  } catch {
    return false;
  }
}
