import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY_PACKAGE_HASH } from '@agentgate/shared';
import { resolveCliEnv } from '../src/cli-env';

describe('resolveCliEnv', () => {
  it('defaults an empty env to live mode + the deployed registry hash', () => {
    const out = resolveCliEnv({}, {});
    expect(out.AGENTGATE_MODE).toBe('live');
    expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe(DEFAULT_REGISTRY_PACKAGE_HASH);
  });

  it('lets process.env override the built-in defaults', () => {
    const out = resolveCliEnv(
      {},
      { AGENTGATE_MODE: 'mock', REGISTRY_CONTRACT_PACKAGE_HASH: 'hash-env' },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe('hash-env');
  });

  it('lets a flag override both env and default (flag > env > default)', () => {
    const out = resolveCliEnv(
      {
        mode: 'mock',
        registry: 'hash-flag',
        pem: '/k.pem',
        apiKey: 'K',
        adminToken: 'T',
        nodeUrl: 'http://n',
      },
      { AGENTGATE_MODE: 'live', REGISTRY_CONTRACT_PACKAGE_HASH: 'hash-env' },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe('hash-flag');
    expect(out.SELLER_SIGNER_PEM_PATH).toBe('/k.pem');
    expect(out.CSPR_CLOUD_API_KEY).toBe('K');
    expect(out.AGENTGATE_ADMIN_TOKEN).toBe('T');
    expect(out.CASPER_NODE_URL).toBe('http://n');
  });

  it('treats empty-string flags/env as unset', () => {
    const out = resolveCliEnv({ mode: '  ' }, { AGENTGATE_MODE: '' });
    expect(out.AGENTGATE_MODE).toBe('live');
  });

  it('does not inject CASPER_NODE_URL/SELLER_SIGNER_PEM_PATH when neither flag nor env is set', () => {
    const out = resolveCliEnv({}, {});
    expect(out.CASPER_NODE_URL).toBeUndefined();
    expect(out.SELLER_SIGNER_PEM_PATH).toBeUndefined();
  });
});
