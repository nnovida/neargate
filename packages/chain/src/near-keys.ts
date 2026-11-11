import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { KeyPair } from 'near-api-js';
import { AgentGateError, isEd25519PublicKey, isNearAccountId } from '@agentgate/shared';
import type { NearKeySigner } from '@agentgate/shared';

/** The NEAR networks a key can be looked up for (`~/.near-credentials/<network>/`). */
export type NearKeyNetwork = 'testnet' | 'mainnet';

export interface LoadNearSignerOpts {
  accountId: string;
  /** A near-cli credentials JSON file: `{account_id, public_key, private_key}`. */
  keyPath?: string;
  /** An `ed25519:<base58>` secret key. */
  secretKey?: string;
  /** Picks the default key file `~/.near-credentials/<network>/<accountId>.json`. */
  network: NearKeyNetwork;
}

export interface LoadedNearSigner {
  /**
   * The account plus the one key source that resolved (the secret key, or the key file's
   * absolute path), so resolving it again yields the same key. Never carries a key read from
   * a file.
   */
  signer: NearKeySigner;
  /** The resolved key's public half, `ed25519:<base58>`. */
  publicKey: string;
  /** Base64 of the 64-byte ed25519 signature of `message`. */
  sign(message: Uint8Array): string;
}

const ED25519_PREFIX = 'ed25519:';

/** Key files this process already warned about, so one loose file is reported once. */
const warnedKeyFiles = new Set<string>();

function keyError(code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, 400);
}

function isSet(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where `near login` stores an account's key: `~/.near-credentials/<network>/<accountId>.json`. */
export function defaultCredentialsPath(network: NearKeyNetwork, accountId: string): string {
  return join(homedir(), '.near-credentials', network, `${accountId}.json`);
}

/**
 * Parses an `ed25519:` secret key. Error messages name the source only: never the key, and
 * never the parser's own text (it can describe the key material).
 */
function parseSecretKey(secret: string, source: string): KeyPair {
  const trimmed = secret.trim();
  if (!trimmed.startsWith(ED25519_PREFIX)) {
    throw keyError('SIGNER_KEY_INVALID', `${source} is not an ed25519 NEAR secret key (expected "ed25519:<base58>")`);
  }
  let keyPair: KeyPair;
  try {
    keyPair = KeyPair.fromString(trimmed as `ed25519:${string}`);
  } catch {
    throw keyError('SIGNER_KEY_INVALID', `${source} is not a valid ed25519 NEAR secret key`);
  }
  if (!isEd25519PublicKey(keyPair.getPublicKey().toString())) {
    throw keyError('SIGNER_KEY_INVALID', `${source} is not a valid ed25519 NEAR secret key`);
  }
  return keyPair;
}

/** Warns once per path when a key file is group/other-accessible (POSIX only); never blocks. */
async function warnIfExposed(path: string): Promise<void> {
  if (process.platform === 'win32' || warnedKeyFiles.has(path)) return;
  try {
    const { mode } = await stat(path);
    if ((mode & 0o077) !== 0) {
      warnedKeyFiles.add(path);
      const octal = (mode & 0o777).toString(8).padStart(3, '0');
      process.stderr.write(
        `warning: key file ${path} is group/other-accessible (mode ${octal}). ` +
          `Anyone who can read it can sign as this account — run \`chmod 600 ${path}\`.\n`,
      );
    }
  } catch {
    /* never block on the permission check itself */
  }
}

/** Reads a near-cli credentials JSON and returns its key pair, checked against the account. */
async function readKeyFile(path: string, accountId: string): Promise<KeyPair> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw keyError('SIGNER_KEY_UNREADABLE', `cannot read key file ${path}${code !== undefined ? ` (${code})` : ''}`);
  }
  await warnIfExposed(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    throw keyError(
      'SIGNER_KEY_INVALID',
      `key file ${path} is not a near-cli credentials JSON ({account_id, public_key, private_key})`,
    );
  }
  const fileAccount = parsed['account_id'];
  if (fileAccount !== undefined) {
    if (typeof fileAccount !== 'string') {
      throw keyError('SIGNER_KEY_INVALID', `key file ${path} has a non-string account_id`);
    }
    if (fileAccount !== accountId) {
      throw keyError(
        'SIGNER_KEY_MISMATCH',
        `key file ${path} is for ${JSON.stringify(fileAccount.slice(0, 64))}, not ${accountId}`,
      );
    }
  }
  // near-cli writes `private_key`; nearcore key files name the same field `secret_key`.
  const secret = typeof parsed['private_key'] === 'string' ? parsed['private_key'] : parsed['secret_key'];
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw keyError('SIGNER_KEY_INVALID', `key file ${path} has no private_key`);
  }
  const keyPair = parseSecretKey(secret, `the private_key in ${path}`);
  // A 64-byte secret carries its public half and near-api-js takes it as given: a file whose
  // public_key differs from the key its private_key derives would sign as some other key.
  const filePublic = parsed['public_key'];
  if (filePublic !== undefined && filePublic !== keyPair.getPublicKey().toString()) {
    throw keyError('SIGNER_KEY_INVALID', `key file ${path}: public_key does not match its private_key`);
  }
  return keyPair;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    // Anything but "not there" (e.g. EACCES) is a key file the read will report on.
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Resolves the NEAR key `accountId` signs with, in this order (the first source that is set
 * wins; a set source that fails is an error, never a fall-through):
 *
 * 1. `secretKey` (`ed25519:<base58>`)
 * 2. `keyPath` (near-cli credentials JSON)
 * 3. `~/.near-credentials/<network>/<accountId>.json`
 *
 * Warns on stderr (once per path) when a key file is group/other-accessible. Errors:
 * INVALID_ACCOUNT_ID, CONFIG_INVALID (network), SIGNER_MISSING (no source at all),
 * SIGNER_KEY_UNREADABLE, SIGNER_KEY_INVALID and SIGNER_KEY_MISMATCH (key file of another
 * account). No error message or returned field carries secret key material.
 */
export async function loadNearSigner(opts: LoadNearSignerOpts): Promise<LoadedNearSigner> {
  const { accountId, network } = opts;
  if (!isNearAccountId(accountId)) {
    throw new AgentGateError(
      'INVALID_ACCOUNT_ID',
      `signer account ${JSON.stringify(String(accountId)).slice(0, 80)} is not a NEAR account id`,
      400,
    );
  }
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new AgentGateError(
      'CONFIG_INVALID',
      `NEAR network must be "testnet" or "mainnet", got ${JSON.stringify(String(network)).slice(0, 40)}`,
      500,
    );
  }

  let keyPair: KeyPair;
  let signer: NearKeySigner;
  if (isSet(opts.secretKey)) {
    keyPair = parseSecretKey(opts.secretKey, `the secret key for ${accountId}`);
    signer = { kind: 'near', accountId, secretKey: opts.secretKey.trim() };
  } else {
    const keyPath = isSet(opts.keyPath) ? resolve(opts.keyPath.trim()) : defaultCredentialsPath(network, accountId);
    if (!isSet(opts.keyPath) && !(await fileExists(keyPath))) {
      throw keyError(
        'SIGNER_MISSING',
        `no NEAR key for ${accountId}: set a secret key or a key file, or create ${keyPath} (near-cli login)`,
      );
    }
    keyPair = await readKeyFile(keyPath, accountId);
    signer = { kind: 'near', accountId, keyPath };
  }

  const publicKey = keyPair.getPublicKey().toString();
  return {
    signer,
    publicKey,
    sign(message: Uint8Array): string {
      if (!(message instanceof Uint8Array)) {
        throw new AgentGateError('INVALID_INPUT', 'sign() takes the message bytes (a Uint8Array)', 400);
      }
      return Buffer.from(keyPair.sign(message).signature).toString('base64');
    },
  };
}
