import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY_CONTRACT_ID } from '@agentgate/shared';
import { resolveCliEnv } from '../src/cli-env';

describe('resolveCliEnv', () => {
  it('defaults an empty env to live mode + the deployed registry contract id', () => {
    const out = resolveCliEnv({}, {});
    expect(out.AGENTGATE_MODE).toBe('live');
    expect(out.REGISTRY_CONTRACT_ID).toBe(DEFAULT_REGISTRY_CONTRACT_ID);
  });

  it('lets process.env override the built-in defaults', () => {
    const out = resolveCliEnv(
      {},
      { AGENTGATE_MODE: 'mock', REGISTRY_CONTRACT_ID: 'env-registry.testnet' },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_ID).toBe('env-registry.testnet');
  });

  it('lets a flag override both env and default (flag > env > default)', () => {
    const out = resolveCliEnv(
      {
        mode: 'mock',
        registry: 'flag-registry.testnet',
        keyFile: '/k.json',
        adminToken: 'T',
        rpc: 'http://n',
      },
      { AGENTGATE_MODE: 'live', REGISTRY_CONTRACT_ID: 'env-registry.testnet' },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_ID).toBe('flag-registry.testnet');
    expect(out.SELLER_KEY_PATH).toBe('/k.json');
    expect(out.AGENTGATE_ADMIN_TOKEN).toBe('T');
    expect(out.NEAR_RPC_URL).toBe('http://n');
  });

  it('treats empty-string flags/env as unset', () => {
    const out = resolveCliEnv({ mode: '  ' }, { AGENTGATE_MODE: '' });
    expect(out.AGENTGATE_MODE).toBe('live');
  });

  it('does not inject NEAR_RPC_URL/SELLER_KEY_PATH when neither flag nor env is set', () => {
    const out = resolveCliEnv({}, {});
    expect(out.NEAR_RPC_URL).toBeUndefined();
    expect(out.SELLER_KEY_PATH).toBeUndefined();
  });
});
