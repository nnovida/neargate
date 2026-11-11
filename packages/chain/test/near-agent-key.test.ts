import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentGateError, nearToYocto } from '@agentgate/shared';
import type { AnySigner } from '@agentgate/shared';
import { agentKeyAction, agentKeyPath, loadNearSigner, provisionAgentKey } from '../src/index';

// The agent key helper: the AddKey action it builds, the key file it writes, and the order it
// does them in. No RPC here (the LiveNearClient side is in near-live.test.ts); the secret key is
// random per test, never committed.

const REGISTRY = 'neargate-registry.testnet';
const ACCOUNT = 'buyer.testnet';
const ALLOWANCE = nearToYocto('0.25');
const posixOnly = process.platform === 'win32' ? it.skip : it;

/** A signer for the account's full-access key; the fake client never reads it. */
const SIGNER: AnySigner = { kind: 'near', accountId: ACCOUNT, secretKey: 'ed25519:never-used-by-the-fake' };

interface AddCall {
  input: { publicKey: string; allowanceYocto: string };
  signer: AnySigner;
}

/** A client whose addAgentKey records its call and answers (or fails) as told. */
function fakeClient(outcome: 'ok' | Error = 'ok'): { client: { addAgentKey: typeof add }; calls: AddCall[] } {
  const calls: AddCall[] = [];
  const add = async (input: AddCall['input'], signer: AnySigner): Promise<{ txHash: string }> => {
    calls.push({ input, signer });
    if (outcome !== 'ok') throw outcome;
    return { txHash: 'Akiy3SNDadKPsZw3dFkzzYAYyudnMqyhTkL5rUwCYZ6F' };
  };
  return { client: { addAgentKey: add }, calls };
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'neargate-agent-key-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('agentKeyAction', () => {
  it('is an AddKey with a FunctionCall permission: receiver = the registry, methods ["pay_from_escrow"], the allowance', () => {
    const publicKey = KeyPair.fromRandom('ed25519').getPublicKey();
    const action = agentKeyAction(REGISTRY, publicKey.toString(), ALLOWANCE);

    const add = action.addKey;
    if (add === undefined) throw new Error('expected an AddKey action');
    expect(add.publicKey.toString()).toBe(publicKey.toString());
    expect(add.accessKey.nonce).toBe(0n);
    const permission = add.accessKey.permission;
    expect(permission.fullAccess).toBeUndefined(); // never a full-access key
    expect(permission.functionCall).toEqual({
      receiverId: REGISTRY,
      methodNames: ['pay_from_escrow'], // not withdraw_escrow, not deposit_escrow, not pay
      allowance: BigInt(ALLOWANCE),
    });
    // and nothing but the AddKey in it
    expect(action.enum).toBe('addKey');
    expect(Object.entries(action).filter(([k, v]) => k !== 'enum' && v !== undefined).map(([k]) => k)).toEqual(['addKey']);
  });

  it('refuses a zero, unlimited or malformed allowance and a malformed key (a zero allowance cannot pay gas)', () => {
    const key = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    for (const allowance of ['0', '', '-1', '0.5', '1e24', 'abc']) {
      expect(() => agentKeyAction(REGISTRY, key, allowance), allowance).toThrow(AgentGateError);
    }
    expect(() => agentKeyAction(REGISTRY, key, '0')).toThrow(
      expect.objectContaining({ code: 'INVALID_AMOUNT', message: expect.stringMatching(/allowance must be greater than zero/) }),
    );
    for (const publicKey of ['', 'not-a-key', 'ed25519:short', 'secp256k1:abc']) {
      expect(() => agentKeyAction(REGISTRY, publicKey, ALLOWANCE), publicKey).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    }
  });
});

describe('agentKeyPath', () => {
  it('is ~/.near-credentials/<network>/<account>.neargate-agent.json, apart from the account\'s own key file', () => {
    expect(agentKeyPath('testnet', ACCOUNT)).toBe(
      join(homedir(), '.near-credentials', 'testnet', 'buyer.testnet.neargate-agent.json'),
    );
    expect(agentKeyPath('mainnet', 'agent.near')).toBe(
      join(homedir(), '.near-credentials', 'mainnet', 'agent.near.neargate-agent.json'),
    );
  });

  it('refuses an id that is not a NEAR account id (it names a file)', () => {
    for (const bad of ['../evil', 'a/b.testnet', 'Buyer.testnet', '', 'x']) {
      expect(() => agentKeyPath('testnet', bad), bad).toThrow(expect.objectContaining({ code: 'INVALID_ACCOUNT_ID' }));
    }
  });
});

describe('provisionAgentKey', () => {
  const keyFile = (): string => join(home, '.near-credentials', 'testnet', `${ACCOUNT}.neargate-agent.json`);

  it('writes {account_id, public_key, private_key} to the key file, then adds exactly that public key on chain', async () => {
    vi.stubEnv('HOME', home);
    const { client, calls } = fakeClient();
    const result = await provisionAgentKey({ client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' });

    expect(result.keyPath).toBe(keyFile());
    expect(result.accountId).toBe(ACCOUNT);
    const file = JSON.parse(await readFile(keyFile(), 'utf8')) as Record<string, string>;
    expect(Object.keys(file).sort()).toEqual(['account_id', 'private_key', 'public_key']);
    expect(file['account_id']).toBe(ACCOUNT);
    expect(file['public_key']).toBe(result.publicKey);
    expect(file['private_key']).toMatch(/^ed25519:/);
    // the on-chain key is the file's key, with the asked allowance, added by the account's own signer
    expect(calls).toEqual([{ input: { publicKey: result.publicKey, allowanceYocto: ALLOWANCE }, signer: SIGNER }]);
    expect(result.txHash).toBe('Akiy3SNDadKPsZw3dFkzzYAYyudnMqyhTkL5rUwCYZ6F');
    // the file is a key file `--key-file` takes as is
    const loaded = await loadNearSigner({ accountId: ACCOUNT, keyPath: keyFile(), network: 'testnet' });
    expect(loaded.publicKey).toBe(result.publicKey);
  });

  posixOnly('creates the key file with mode 0600 and its folder private (0700 when it creates it)', async () => {
    vi.stubEnv('HOME', home);
    const { client } = fakeClient();
    await provisionAgentKey({ client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' });
    expect((await stat(keyFile())).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.near-credentials', 'testnet'))).mode & 0o777).toBe(0o700);
  });

  posixOnly('is 0600 whatever the umask', async () => {
    vi.stubEnv('HOME', home);
    const previous = process.umask(0o000);
    try {
      await provisionAgentKey({ client: fakeClient().client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' });
    } finally {
      process.umask(previous);
    }
    expect((await stat(keyFile())).mode & 0o777).toBe(0o600);
  });

  it('never returns the secret key; a failing AddKey reaches the caller untouched and takes the key file with it', async () => {
    vi.stubEnv('HOME', home);
    const ok = await provisionAgentKey({ client: fakeClient().client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' });
    const secret = (JSON.parse(await readFile(keyFile(), 'utf8')) as Record<string, string>)['private_key']!.slice('ed25519:'.length);
    expect(JSON.stringify(ok)).not.toContain(secret);

    const boom = new AgentGateError('TX_FAILED', 'NEAR rejected the add_agent_key call: something', 502);
    const failing = fakeClient(boom);
    const other = { ...SIGNER, accountId: 'other.testnet' };
    const thrown = await provisionAgentKey({ client: failing.client, signer: other, allowanceYocto: ALLOWANCE, network: 'testnet' }).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBe(boom); // the very error the client threw, nothing wrapped around it
    // only the public half was ever handed to the client
    expect(failing.calls[0]!.input.publicKey).toMatch(/^ed25519:/);
    await expect(stat(join(home, '.near-credentials', 'testnet', 'other.testnet.neargate-agent.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to overwrite an existing agent key file: nothing is generated, sent or changed', async () => {
    vi.stubEnv('HOME', home);
    const first = fakeClient();
    await provisionAgentKey({ client: first.client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' });
    const before = await readFile(keyFile(), 'utf8');

    const second = fakeClient();
    const err = await provisionAgentKey({ client: second.client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' }).catch(
      (e: unknown) => e as AgentGateError,
    );
    expect(err).toBeInstanceOf(AgentGateError);
    expect(err).toMatchObject({ code: 'AGENT_KEY_EXISTS', httpStatus: 400 });
    expect((err as AgentGateError).message).toContain(keyFile());
    expect((err as AgentGateError).message).not.toContain(JSON.parse(before).private_key.slice('ed25519:'.length));
    expect(second.calls).toEqual([]); // no tx for a key whose secret has nowhere to go
    expect(await readFile(keyFile(), 'utf8')).toBe(before);
  });

  it('refuses to overwrite even a file somebody else put there', async () => {
    vi.stubEnv('HOME', home);
    await mkdir(join(home, '.near-credentials', 'testnet'), { recursive: true });
    await writeFile(keyFile(), 'precious', { mode: 0o600 });
    const { client, calls } = fakeClient();
    await expect(provisionAgentKey({ client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' })).rejects.toMatchObject({
      code: 'AGENT_KEY_EXISTS',
    });
    expect(await readFile(keyFile(), 'utf8')).toBe('precious');
    expect(calls).toEqual([]);
  });

  posixOnly('does not follow a symlink planted at the key file path: the target stays untouched', async () => {
    vi.stubEnv('HOME', home);
    const dir = join(home, '.near-credentials', 'testnet');
    await mkdir(dir, { recursive: true });
    const target = join(home, 'victim.txt');
    await writeFile(target, 'precious', { mode: 0o600 });
    await symlink(target, keyFile());
    const { client, calls } = fakeClient();
    await expect(provisionAgentKey({ client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' })).rejects.toMatchObject({
      code: 'AGENT_KEY_EXISTS',
    });
    expect(await readFile(target, 'utf8')).toBe('precious');
    expect(calls).toEqual([]);
  });

  it('removes the key file when the AddKey fails, so the failed key can never be mistaken for a live one', async () => {
    vi.stubEnv('HOME', home);
    const boom = new AgentGateError('SIGNER_KEY_NOT_FOUND', 'the key is not an access key of buyer.testnet', 400);
    const { client, calls } = fakeClient(boom);
    await expect(provisionAgentKey({ client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' })).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
    await expect(stat(keyFile())).rejects.toMatchObject({ code: 'ENOENT' });
    // so a retry is not blocked by "already exists"
    await provisionAgentKey({ client: fakeClient().client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet' });
    expect((await stat(keyFile())).isFile()).toBe(true);
  });

  it('refuses a bad allowance and a non-NEAR signer before writing any file', async () => {
    vi.stubEnv('HOME', home);
    const { client, calls } = fakeClient();
    await expect(provisionAgentKey({ client, signer: SIGNER, allowanceYocto: '0', network: 'testnet' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    await expect(
      provisionAgentKey({ client, signer: { kind: 'mock', accountId: 'buyer.mock' }, allowanceYocto: ALLOWANCE, network: 'testnet' }),
    ).rejects.toMatchObject({ code: 'invalid_signer' });
    await expect(stat(join(home, '.near-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toEqual([]);
  });

  it('a keyPath option overrides the default location (tests, scripts)', async () => {
    const keyPath = join(home, 'custom', 'agent.json');
    const { client } = fakeClient();
    const result = await provisionAgentKey({ client, signer: SIGNER, allowanceYocto: ALLOWANCE, network: 'testnet', keyPath });
    expect(result.keyPath).toBe(keyPath);
    expect(JSON.parse(await readFile(keyPath, 'utf8'))).toMatchObject({ account_id: ACCOUNT, public_key: result.publicKey });
  });
});
