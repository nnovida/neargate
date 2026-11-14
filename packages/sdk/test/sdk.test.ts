/**
 * packages/sdk/test/sdk.test.ts — the SDK's own surface: the option-based config targets the live
 * deployment by default and never applies the gateway's admin-token rule, and SDK_VERSION is the
 * package's version. The bundled build and its tarball are checked in e2e/npm-pack.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY_CONTRACT_ID, isAgentGateError } from '@agentgate/shared';
import {
  createAgentGateClient,
  createChainClient,
  createNearGateChain,
  LiveNearClient,
  MockChainHttpClient,
  nearGateConfig,
  SDK_VERSION,
} from '../src/index';

describe('@neargate/sdk', () => {
  it('targets the live testnet deployment by default, with no admin token needed', () => {
    const config = nearGateConfig();
    expect(config.mode).toBe('live');
    expect(config.nearNetwork).toBe('testnet');
    expect(config.registryContractId).toBe(DEFAULT_REGISTRY_CONTRACT_ID);
    expect(config.nearRpcUrl).toBe('https://test.rpc.fastnear.com');
    expect(createNearGateChain()).toBeInstanceOf(LiveNearClient);
  });

  it('takes the network, RPC, registry and devnet from options', () => {
    const live = nearGateConfig({ rpcUrl: 'https://rpc.example.org', registryId: 'other-registry.testnet' });
    expect(live.nearRpcUrl).toBe('https://rpc.example.org');
    expect(live.registryContractId).toBe('other-registry.testnet');
    const mock = nearGateConfig({ mode: 'mock', devnetUrl: 'http://localhost:5030' });
    expect(mock.devnetUrl).toBe('http://localhost:5030');
    expect(createNearGateChain({ mode: 'mock' })).toBeInstanceOf(MockChainHttpClient);
  });

  it('refuses a malformed option with CONFIG_INVALID', () => {
    let caught: unknown;
    try {
      nearGateConfig({ registryId: 'Not An Account' });
    } catch (err) {
      caught = err;
    }
    expect(isAgentGateError(caught) && caught.code).toBe('CONFIG_INVALID');
  });

  it('exports the paying client and the chain factory', () => {
    expect(typeof createAgentGateClient).toBe('function');
    expect(typeof createChainClient).toBe('function');
  });

  it('SDK_VERSION is the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
