import { mockAccountHash } from '@agentgate/chain';
import type { AnySigner } from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';
import { requirePublicKeyHex } from './validate';

interface PemIdentity {
  publicKeyHex: string;
  accountHash: string; // "account-hash-<64 hex>"
}

/**
 * Loads a Casper key PEM (live mode) and derives the public key hex + account hash.
 * casper-js-sdk is imported lazily so mock-mode commands never load the SDK.
 */
async function pemIdentity(pemPath: string): Promise<PemIdentity> {
  const path = pemPath.trim();
  if (path === '') {
    throw new AgentGateError(
      'SIGNER_MISSING',
      'pem signer has an empty pemPath — set SELLER_SIGNER_PEM_PATH (or pass --payment-target / --attestor explicitly)',
      400,
    );
  }

  const { readFile, stat } = await import('node:fs/promises');

  // POSIX: warn LOUDLY (but don't refuse) when the PEM is group/other-readable —
  // a private key the rest of the box can read is one cp away from compromise.
  if (process.platform !== 'win32') {
    try {
      const { mode } = await stat(path);
      if ((mode & 0o077) !== 0) {
        const octal = (mode & 0o777).toString(8).padStart(3, '0');
        process.stderr.write(
          `warning: signer PEM ${path} is group/other-accessible (mode ${octal}). ` +
            `Anyone who can read it can sign as you — run \`chmod 600 ${path}\`.\n`,
        );
      }
    } catch {
      // stat may fail (race, perms): never block on the permission check itself.
    }
  }

  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch (err) {
    throw new AgentGateError(
      'SIGNER_PEM_UNREADABLE',
      `cannot read signer PEM at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  // casper-js-sdk is a CJS webpack bundle: under node's ESM loader none of its
  // named exports are statically detectable, so the namespace only carries
  // `default` (= module.exports). Bundler loaders (vitest/Next) expose names
  // directly — support both.
  const ns = await import('casper-js-sdk');
  const sdk = (ns as unknown as { default?: typeof ns }).default ?? ns;
  const { KeyAlgorithm, PrivateKey } = sdk;
  const priv = (() => {
    try {
      return PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    } catch {
      // fall through to secp256k1
    }
    try {
      return PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
    } catch {
      throw new AgentGateError(
        'SIGNER_PEM_INVALID',
        `cannot parse ${path} as an ed25519 or secp256k1 Casper private key PEM`,
        400,
      );
    }
  })();

  const pub = priv.publicKey;
  return { publicKeyHex: pub.toHex(), accountHash: pub.accountHash().toPrefixedString() };
}

/** Public key hex of a signer (mock: as given; pem: derived from the PEM file). */
export async function signerPublicKeyHex(signer: AnySigner): Promise<string> {
  if (signer.kind === 'mock') {
    return requirePublicKeyHex(signer.publicKey, 'signer.publicKey');
  }
  return (await pemIdentity(signer.pemPath)).publicKeyHex;
}

/**
 * Default payment target derived from a signer (SPEC §9):
 * mock → `mockAccountHash(publicKey)` (same derivation the devnet uses);
 * pem  → account hash of the PEM key via casper-js-sdk.
 */
export async function signerAccountHash(signer: AnySigner): Promise<string> {
  if (signer.kind === 'mock') {
    return mockAccountHash(requirePublicKeyHex(signer.publicKey, 'signer.publicKey'));
  }
  return (await pemIdentity(signer.pemPath)).accountHash;
}
