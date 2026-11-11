import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { buildSelfMapMessage } from '@agentgate/shared';
import { loadNearSigner, verifyNearSignature } from '../src/index';

const ACCOUNT = 'seller.testnet';
const posixOnly = process.platform === 'win32' ? it.skip : it;

/** A fresh ed25519 key pair in near-cli string form; never a committed key. */
function newKey(): { secretKey: string; publicKey: string } {
  const keyPair = KeyPair.fromRandom('ed25519');
  return { secretKey: keyPair.toString(), publicKey: keyPair.getPublicKey().toString() };
}

let home: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

/** Writes a near-cli credentials JSON (`{account_id, public_key, private_key}`), 0600 unless told otherwise. */
async function writeKeyFile(
  path: string,
  key: { secretKey: string; publicKey: string },
  opts: { accountId?: string | null; mode?: number; field?: 'private_key' | 'secret_key'; publicKey?: string } = {},
): Promise<string> {
  const body: Record<string, string> = {
    public_key: opts.publicKey ?? key.publicKey,
    [opts.field ?? 'private_key']: key.secretKey,
  };
  if (opts.accountId !== null) body['account_id'] = opts.accountId ?? ACCOUNT;
  await writeFile(path, JSON.stringify(body), { mode: 0o600 });
  await chmod(path, opts.mode ?? 0o600);
  return path;
}

/** The default key file location for `network` under the stubbed home directory. */
async function defaultKeyFile(
  network: 'testnet' | 'mainnet',
  key: { secretKey: string; publicKey: string },
  accountId = ACCOUNT,
): Promise<string> {
  const dir = join(home, '.near-credentials', network);
  await mkdir(dir, { recursive: true });
  return writeKeyFile(join(dir, `${accountId}.json`), key, { accountId });
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string; message: string; json: string }> {
  try {
    await promise;
  } catch (error) {
    const err = error as { code?: string; message: string };
    return { code: err.code, message: err.message, json: JSON.stringify(err) };
  }
  throw new Error('expected a rejection');
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join('');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'neargate-keys-'));
  vi.stubEnv('HOME', home);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('loadNearSigner: D4 key resolution order', () => {
  it('1. an explicit secretKey wins over keyPath and the default credentials file', async () => {
    const fromSecret = newKey();
    const keyPath = await writeKeyFile(join(home, 'flag.json'), newKey());
    await defaultKeyFile('testnet', newKey());

    const loaded = await loadNearSigner({ accountId: ACCOUNT, secretKey: fromSecret.secretKey, keyPath, network: 'testnet' });

    expect(loaded.publicKey).toBe(fromSecret.publicKey);
    expect(loaded.signer).toEqual({ kind: 'near', accountId: ACCOUNT, secretKey: fromSecret.secretKey });
  });

  it('2. then keyPath (near-cli JSON) wins over the default credentials file', async () => {
    const fromFile = newKey();
    const keyPath = await writeKeyFile(join(home, 'flag.json'), fromFile);
    await defaultKeyFile('testnet', newKey());

    const loaded = await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' });

    expect(loaded.publicKey).toBe(fromFile.publicKey);
    expect(loaded.signer).toEqual({ kind: 'near', accountId: ACCOUNT, keyPath });
  });

  it('3. then ~/.near-credentials/<network>/<accountId>.json, per network', async () => {
    const testnet = newKey();
    const mainnet = newKey();
    const testnetPath = await defaultKeyFile('testnet', testnet);
    const mainnetPath = await defaultKeyFile('mainnet', mainnet);

    const onTestnet = await loadNearSigner({ accountId: ACCOUNT, network: 'testnet' });
    expect(onTestnet.publicKey).toBe(testnet.publicKey);
    expect(onTestnet.signer).toEqual({ kind: 'near', accountId: ACCOUNT, keyPath: testnetPath });

    const onMainnet = await loadNearSigner({ accountId: ACCOUNT, network: 'mainnet' });
    expect(onMainnet.publicKey).toBe(mainnet.publicKey);
    expect(onMainnet.signer).toEqual({ kind: 'near', accountId: ACCOUNT, keyPath: mainnetPath });
  });

  it('treats blank secretKey / keyPath (unset env vars) as absent', async () => {
    const fallback = newKey();
    await defaultKeyFile('testnet', fallback);
    const loaded = await loadNearSigner({ accountId: ACCOUNT, secretKey: '  ', keyPath: '', network: 'testnet' });
    expect(loaded.publicKey).toBe(fallback.publicKey);
  });

  it('an explicit keyPath that cannot be read fails; it never falls through to the default file', async () => {
    await defaultKeyFile('testnet', newKey());
    const err = await rejection(
      loadNearSigner({ accountId: ACCOUNT, keyPath: join(home, 'missing.json'), network: 'testnet' }),
    );
    expect(err.code).toBe('SIGNER_KEY_UNREADABLE');
    expect(err.message).toContain('missing.json');
  });

  it('no key anywhere → SIGNER_MISSING naming the default path it looked at', async () => {
    const err = await rejection(loadNearSigner({ accountId: ACCOUNT, network: 'testnet' }));
    expect(err.code).toBe('SIGNER_MISSING');
    expect(err.message).toContain(join('.near-credentials', 'testnet', `${ACCOUNT}.json`));
  });

  it('accepts the `secret_key` field name as well as near-cli `private_key`', async () => {
    const key = newKey();
    const keyPath = await writeKeyFile(join(home, 'alias.json'), key, { field: 'secret_key' });
    expect((await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' })).publicKey).toBe(key.publicKey);
  });

  it('accepts a key file without account_id (the caller named the account)', async () => {
    const key = newKey();
    const keyPath = await writeKeyFile(join(home, 'no-account.json'), key, { accountId: null });
    expect((await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' })).publicKey).toBe(key.publicKey);
  });
});

describe('loadNearSigner: refuses bad key material without echoing it', () => {
  it('a key file for another account → SIGNER_KEY_MISMATCH', async () => {
    const keyPath = await writeKeyFile(join(home, 'other.json'), newKey(), { accountId: 'someone-else.testnet' });
    const err = await rejection(loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' }));
    expect(err.code).toBe('SIGNER_KEY_MISMATCH');
    expect(err.message).toContain('someone-else.testnet');
  });

  it('a key file whose public_key does not match its private key → SIGNER_KEY_INVALID', async () => {
    const key = newKey();
    const keyPath = await writeKeyFile(join(home, 'mismatch.json'), key, { publicKey: newKey().publicKey });
    const err = await rejection(loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' }));
    expect(err.code).toBe('SIGNER_KEY_INVALID');
    expect(err.json).not.toContain(key.secretKey);
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['no private key', JSON.stringify({ account_id: ACCOUNT, public_key: 'ed25519:abc' })],
    ['a non-string private key', JSON.stringify({ account_id: ACCOUNT, private_key: 42 })],
  ])('a key file that is %s → SIGNER_KEY_INVALID', async (_name, content) => {
    const keyPath = join(home, 'bad.json');
    await writeFile(keyPath, content, { mode: 0o600 });
    const err = await rejection(loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' }));
    expect(err.code).toBe('SIGNER_KEY_INVALID');
  });

  it.each([
    ['garbage', 'not-a-key'],
    ['a non-ed25519 curve', 'secp256k1:3b5Yk8Ew7cmPGTW1KX1Dm9Hnh5sEe3zW'],
    ['a truncated ed25519 key', 'ed25519:3b5Yk8Ew7cmPGTW1KX1Dm9Hnh5sEe3zW'],
  ])('a secretKey that is %s → SIGNER_KEY_INVALID, never echoed', async (_name, secretKey) => {
    const err = await rejection(loadNearSigner({ accountId: ACCOUNT, secretKey, network: 'testnet' }));
    expect(err.code).toBe('SIGNER_KEY_INVALID');
    expect(err.json).not.toContain(secretKey);
    expect(err.message).not.toContain(secretKey);
  });

  it('rejects an invalid account id and an unknown network', async () => {
    expect((await rejection(loadNearSigner({ accountId: 'Not An Account', network: 'testnet' }))).code).toBe(
      'INVALID_ACCOUNT_ID',
    );
    expect(
      (await rejection(loadNearSigner({ accountId: ACCOUNT, network: 'devnet' as unknown as 'testnet' }))).code,
    ).toBe('CONFIG_INVALID');
  });

  it('the loaded signer never carries a key read from a file', async () => {
    const key = newKey();
    const keyPath = await writeKeyFile(join(home, 'flag.json'), key);
    const loaded = await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' });
    expect(JSON.stringify(loaded)).not.toContain(key.secretKey);
    expect(stderrText()).not.toContain(key.secretKey);
  });
});

describe('loadNearSigner: signing', () => {
  it('sign() returns a base64 ed25519 signature that verifies under publicKey', async () => {
    const key = newKey();
    const loaded = await loadNearSigner({ accountId: ACCOUNT, secretKey: key.secretKey, network: 'testnet' });
    const message = buildSelfMapMessage({
      network: 'near-testnet',
      serviceId: 3,
      upstreamUrl: 'https://api.example.com/x',
      timestamp: 1_700_000_000_000,
    });
    const signature = loaded.sign(message);
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(signature, 'base64')).toHaveLength(64);
    expect(verifyNearSignature(loaded.publicKey, message, signature)).toBe(true);
    expect(verifyNearSignature(loaded.publicKey, new TextEncoder().encode('other'), signature)).toBe(false);
  });
});

describe('loadNearSigner: key file permissions', () => {
  posixOnly('warns once per path when the key file is group/other-accessible, naming chmod 600', async () => {
    const keyPath = await writeKeyFile(join(home, 'loose.json'), newKey(), { mode: 0o644 });

    await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' });
    await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' });

    const text = stderrText();
    expect(text).toContain(keyPath);
    expect(text).toContain('mode 644');
    expect(text).toContain(`chmod 600 ${keyPath}`);
    expect(text.split('group/other-accessible').length - 1).toBe(1);
  });

  posixOnly('stays quiet for a 0600 key file', async () => {
    const keyPath = await writeKeyFile(join(home, 'tight.json'), newKey(), { mode: 0o600 });
    await loadNearSigner({ accountId: ACCOUNT, keyPath, network: 'testnet' });
    expect(stderrText()).toBe('');
  });
});
