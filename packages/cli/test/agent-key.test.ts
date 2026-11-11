import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentGateError, nearToYocto, type AnySigner } from '@agentgate/shared';
import { addAgentKey, assertAgentKeysAvailable, formatAgentKeyAdded } from '../src/agent-key';

const ACCOUNT = 'buyer.testnet';
const SIGNER: AnySigner = { kind: 'near', accountId: ACCOUNT, secretKey: 'ed25519:never-used-by-the-fake' };
const TX = 'Akiy3SNDadKPsZw3dFkzzYAYyudnMqyhTkL5rUwCYZ6F';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'neargate-cli-agent-key-'));
  vi.stubEnv('HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

function fakeClient(): { addAgentKey: ReturnType<typeof vi.fn> } {
  return { addAgentKey: vi.fn(async () => ({ txHash: TX })) };
}

describe('assertAgentKeysAvailable', () => {
  it('mock mode answers LIVE_ONLY: agent keys are NEAR access keys, which the devnet does not model', () => {
    const err = (() => {
      try {
        assertAgentKeysAvailable('mock');
      } catch (e) {
        return e as AgentGateError;
      }
      throw new Error('expected a throw');
    })();
    expect(err).toBeInstanceOf(AgentGateError);
    expect(err).toMatchObject({ code: 'LIVE_ONLY', httpStatus: 400 });
    expect(err.message).toContain('agent keys need live mode');
    expect(() => assertAgentKeysAvailable('live')).not.toThrow();
  });
});

describe('addAgentKey', () => {
  it('parses --allowance in NEAR, provisions the key and reports it with its allowance', async () => {
    const client = fakeClient();
    const added = await addAgentKey({ client, signer: SIGNER, allowanceNear: '0.25', network: 'testnet' });
    expect(client.addAgentKey).toHaveBeenCalledWith({ publicKey: added.publicKey, allowanceYocto: nearToYocto('0.25') }, SIGNER);
    expect(added).toMatchObject({
      accountId: ACCOUNT,
      txHash: TX,
      allowanceYocto: nearToYocto('0.25'),
      keyPath: join(home, '.near-credentials', 'testnet', 'buyer.testnet.neargate-agent.json'),
    });
    expect(added.publicKey).toMatch(/^ed25519:/);
  });

  it('refuses a zero or malformed allowance (INVALID_AMOUNT) before generating or writing anything', async () => {
    const client = fakeClient();
    for (const bad of ['0', '-1', 'abc', '', '0.0000000000000000000000001']) {
      await expect(addAgentKey({ client, signer: SIGNER, allowanceNear: bad, network: 'testnet' }), bad).rejects.toMatchObject({
        code: 'INVALID_AMOUNT',
      });
    }
    expect(client.addAgentKey).not.toHaveBeenCalled();
    await expect(stat(join(home, '.near-credentials'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints only the public key, the path and the next command: never the secret, not even when it fails', async () => {
    const client = fakeClient();
    const added = await addAgentKey({ client, signer: SIGNER, allowanceNear: '0.25', network: 'testnet' });
    const file = JSON.parse(await readFile(added.keyPath, 'utf8')) as Record<string, string>;
    const secret = file['private_key']!.slice('ed25519:'.length);

    const lines = formatAgentKeyAdded(added, { explorerUrl: 'https://testnet.nearblocks.io' });
    const text = lines.join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('private_key');
    expect(lines).toEqual([
      `account:     ${ACCOUNT}`,
      `public key:  ${added.publicKey}`,
      `key file:    ${added.keyPath}`,
      'allowance:   0.25 NEAR (the key\'s gas; it can call pay_from_escrow on the registry and nothing else)',
      `add_key tx:  ${TX}`,
      `explorer:    https://testnet.nearblocks.io/txns/${TX}`,
      '',
      'the agent spends the escrow with:',
      `  neargate buy <id> --from-escrow --account ${ACCOUNT} --key-file ${added.keyPath}`,
    ]);

    // a refused overwrite: the error names the path, not the secret
    const again = await addAgentKey({ client, signer: SIGNER, allowanceNear: '0.25', network: 'testnet' }).catch((e: unknown) => e);
    expect(again).toMatchObject({ code: 'AGENT_KEY_EXISTS' });
    expect((again as Error).message).toContain(added.keyPath);
    expect((again as Error).message).not.toContain(secret);
    expect(client.addAgentKey).toHaveBeenCalledTimes(1);
  });
});
