import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadNearSigner as chainLoadNearSigner } from '@agentgate/chain';
import { loadConfig, type AgentGateConfig } from '@agentgate/shared';
import { cliSigner, loadNearSigner } from '../src/identity';

const SELLER = 'seller.testnet';
const BUYER = 'buyer.testnet';

let home: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

function newKey(): { secretKey: string; publicKey: string } {
  const keyPair = KeyPair.fromRandom('ed25519');
  return { secretKey: keyPair.toString(), publicKey: keyPair.getPublicKey().toString() };
}

async function keyFile(path: string, accountId: string, key = newKey()): Promise<{ path: string; publicKey: string }> {
  await writeFile(path, JSON.stringify({ account_id: accountId, public_key: key.publicKey, private_key: key.secretKey }));
  await chmod(path, 0o600);
  return { path, publicKey: key.publicKey };
}

async function defaultKeyFile(accountId: string, network = 'testnet'): Promise<{ path: string; publicKey: string }> {
  const dir = join(home, '.near-credentials', network);
  await mkdir(dir, { recursive: true });
  return keyFile(join(dir, `${accountId}.json`), accountId);
}

function liveConfig(env: Record<string, string> = {}): AgentGateConfig {
  return loadConfig({ AGENTGATE_MODE: 'live', ...env }, { requireStrongAdminToken: false });
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join('');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'neargate-cli-keys-'));
  vi.stubEnv('HOME', home);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('identity re-exports the chain key loader (one signer-from-config path)', () => {
  it('loadNearSigner is @agentgate/chain loadNearSigner', () => {
    expect(loadNearSigner).toBe(chainLoadNearSigner);
  });
});

describe('cliSigner · mock mode', () => {
  it('uses MOCK_SELLER_ACCOUNT / MOCK_BUYER_ACCOUNT per role, --account overrides', async () => {
    const config = loadConfig({ AGENTGATE_MODE: 'mock', MOCK_SELLER_ACCOUNT: 's.mock', MOCK_BUYER_ACCOUNT: 'b.mock' });
    expect(await cliSigner(config, 'seller')).toEqual({ kind: 'mock', accountId: 's.mock' });
    expect(await cliSigner(config, 'buyer')).toEqual({ kind: 'mock', accountId: 'b.mock' });
    expect(await cliSigner(config, 'buyer', { account: 'other.mock' })).toEqual({ kind: 'mock', accountId: 'other.mock' });
  });

  it('rejects a malformed --account', async () => {
    const config = loadConfig({ AGENTGATE_MODE: 'mock' });
    await expect(cliSigner(config, 'seller', { account: 'Not An Account' })).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT_ID',
    });
  });
});

describe('cliSigner · live mode: --key-file resolution order (D4)', () => {
  it('1. the role\'s *_PRIVATE_KEY wins, and says it overrides an explicit --key-file', async () => {
    const secret = newKey();
    const flagFile = await keyFile(join(home, 'flag.json'), SELLER);
    await defaultKeyFile(SELLER);
    const config = liveConfig({ SELLER_ACCOUNT_ID: SELLER, SELLER_PRIVATE_KEY: secret.secretKey });

    const signer = await cliSigner(config, 'seller', { keyFile: flagFile.path });

    expect(signer).toEqual({ kind: 'near', accountId: SELLER, secretKey: secret.secretKey });
    expect(stderrText()).toContain('SELLER_PRIVATE_KEY');
    expect(stderrText()).toContain('--key-file');
    expect(stderrText()).not.toContain(secret.secretKey);
  });

  it('2. then --key-file, over *_KEY_PATH and the default credentials file', async () => {
    const flagFile = await keyFile(join(home, 'flag.json'), SELLER);
    const envFile = await keyFile(join(home, 'env.json'), SELLER);
    await defaultKeyFile(SELLER);
    const config = liveConfig({ SELLER_ACCOUNT_ID: SELLER, SELLER_KEY_PATH: envFile.path });

    expect(await cliSigner(config, 'seller', { keyFile: flagFile.path })).toEqual({
      kind: 'near',
      accountId: SELLER,
      keyPath: flagFile.path,
    });
  });

  it('3. then *_KEY_PATH, over the default credentials file', async () => {
    const envFile = await keyFile(join(home, 'env.json'), SELLER);
    await defaultKeyFile(SELLER);
    const config = liveConfig({ SELLER_ACCOUNT_ID: SELLER, SELLER_KEY_PATH: envFile.path });

    expect(await cliSigner(config, 'seller')).toEqual({ kind: 'near', accountId: SELLER, keyPath: envFile.path });
  });

  it('4. then ~/.near-credentials/<NEAR_NETWORK>/<account>.json', async () => {
    const testnet = await defaultKeyFile(SELLER, 'testnet');
    const mainnet = await defaultKeyFile(SELLER, 'mainnet');
    expect(await cliSigner(liveConfig({ SELLER_ACCOUNT_ID: SELLER }), 'seller')).toEqual({
      kind: 'near',
      accountId: SELLER,
      keyPath: testnet.path,
    });
    expect(await cliSigner(liveConfig({ SELLER_ACCOUNT_ID: SELLER, NEAR_NETWORK: 'mainnet' }), 'seller')).toEqual({
      kind: 'near',
      accountId: SELLER,
      keyPath: mainnet.path,
    });
  });

  it('5. nothing found → SIGNER_MISSING (fails at signer resolution, before any chain call)', async () => {
    await expect(cliSigner(liveConfig({ SELLER_ACCOUNT_ID: SELLER }), 'seller')).rejects.toMatchObject({
      code: 'SIGNER_MISSING',
    });
  });

  it('the buyer role reads BUYER_* and --account overrides the configured account', async () => {
    const buyerFile = await keyFile(join(home, 'buyer.json'), BUYER);
    await keyFile(join(home, 'seller.json'), SELLER);
    const config = liveConfig({
      SELLER_ACCOUNT_ID: SELLER,
      SELLER_KEY_PATH: join(home, 'seller.json'),
      BUYER_ACCOUNT_ID: 'configured-buyer.testnet',
      BUYER_KEY_PATH: buyerFile.path,
    });
    expect(await cliSigner(config, 'buyer', { account: BUYER })).toEqual({
      kind: 'near',
      accountId: BUYER,
      keyPath: buyerFile.path,
    });
  });

  it('a live role without any account → SIGNER_MISSING naming --account', async () => {
    const err = await cliSigner(liveConfig(), 'buyer').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SIGNER_MISSING' });
    expect((err as Error).message).toContain('--account');
    expect((err as Error).message).toContain('BUYER_ACCOUNT_ID');
  });
});
