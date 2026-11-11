import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a public dashboard process needs in its environment. It only reads the chain, so it must
 * come up without the gateway's secrets: no admin token, no account ids, no keys.
 */
const READ_ONLY_ENV = {
  AGENTGATE_MODE: 'live',
  NEAR_NETWORK: 'testnet',
  REGISTRY_CONTRACT_ID: 'registry.example.testnet',
};
const NEVER_SET = [
  'AGENTGATE_ADMIN_TOKEN',
  'GATEWAY_ACCOUNT_ID',
  'GATEWAY_PRIVATE_KEY',
  'GATEWAY_KEY_PATH',
  'NEAR_RPC_URL',
  'NEAR_EXPLORER_URL',
];

describe('getChain (the dashboard server, live mode)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of [...Object.keys(READ_ONLY_ENV), ...NEVER_SET]) saved[key] = process.env[key];
    for (const key of NEVER_SET) delete process.env[key];
    Object.assign(process.env, READ_ONLY_ENV);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds the read-only NEAR client from the network and registry env alone', async () => {
    const { getChain } = await import('@/lib/server/chain');

    const { chain, config } = getChain();

    expect(config.mode).toBe('live');
    expect(chain.network).toBe('near-testnet');
    expect(config.nearExplorerUrl).toBe('https://testnet.nearblocks.io');
  });

  it('still fails closed on a missing registry id', async () => {
    delete process.env['REGISTRY_CONTRACT_ID'];
    const { getChain } = await import('@/lib/server/chain');

    expect(() => getChain()).toThrow(/REGISTRY_CONTRACT_ID/);
  });
});
