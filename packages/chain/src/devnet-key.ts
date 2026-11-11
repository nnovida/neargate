import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { base58Encode } from '@agentgate/shared';

// The devnet's key derivation, shared by the devnet (which checks signatures against it) and the
// mock client (which signs gasless delegates with it). Mock-chain keys only: every one of them is
// public knowledge by construction, so they protect nothing and never leave mock mode.

/** The devnet's one full-access key for an account, as near-cli strings. */
export interface DevnetKey {
  /** `ed25519:<base58 of the 32-byte public key>` */
  publicKey: string;
  /** `ed25519:<base58 of seed || public key>` (64 bytes, the near-cli format) */
  secretKey: string;
}

/** PKCS#8 DER header for an ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The key pair every devnet account owns: an ed25519 key whose 32-byte seed is
 * `sha256('neargate-devnet-key/v1:' + accountId)`. Computed on demand, never stored, so the
 * repo holds no key material.
 */
export function deriveDevnetKey(accountId: string): DevnetKey {
  const seed = createHash('sha256').update(`neargate-devnet-key/v1:${accountId}`).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('node:crypto exported an ed25519 public key without its x coordinate');
  const publicBytes = Buffer.from(x, 'base64url');
  return {
    publicKey: `ed25519:${base58Encode(publicBytes)}`,
    secretKey: `ed25519:${base58Encode(Buffer.concat([seed, publicBytes]))}`,
  };
}
