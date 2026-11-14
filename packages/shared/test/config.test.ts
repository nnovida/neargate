import { describe, expect, it } from 'vitest';
import {
  AgentGateError,
  DEFAULT_ADMIN_TOKEN,
  DEFAULT_REGISTRY_CONTRACT_ID,
  isNearNetwork,
  loadConfig,
} from '../src/index';

describe('isNearNetwork', () => {
  it('accepts testnet and mainnet only', () => {
    expect(isNearNetwork('testnet')).toBe(true);
    expect(isNearNetwork('mainnet')).toBe(true);
    for (const value of ['near-testnet', 'Testnet', 'localnet', '', undefined, null, 1]) {
      expect(isNearNetwork(value), String(value)).toBe(false);
    }
  });
});

describe('loadConfig — mock mode defaults', () => {
  it('loads all defaults from an empty env', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('mock');
    expect(cfg.devnetPort).toBe(4030);
    expect(cfg.oraclePort).toBe(4010);
    expect(cfg.middlewarePort).toBe(4021);
    expect(cfg.dashboardPort).toBe(3000);
    expect(cfg.devnetUrl).toBe('http://localhost:4030');
    expect(cfg.adminToken).toBe(DEFAULT_ADMIN_TOKEN);
    expect(cfg.invoiceTtlMs).toBe(300000);
    expect(cfg.upstreamTimeoutMs).toBe(30000);
    expect(cfg.nearNetwork).toBe('testnet');
    expect(cfg.nearRpcUrl).toBe('https://test.rpc.fastnear.com');
    expect(cfg.nearExplorerUrl).toBe('https://testnet.nearblocks.io');
    expect(cfg.registryContractId).toBe(DEFAULT_REGISTRY_CONTRACT_ID);
    expect(cfg.registryContractId).toBe('neargate-app-registry.testnet');
    expect(cfg.llmModel).toBe('claude-sonnet-4-6');
    expect(cfg.oracleStatic).toBe(false);
    expect(cfg.buyerBudgetNear).toBe('1');
    expect(cfg.relayerEnabled).toBe(false);
    expect(cfg.mockBuyerAccount).toBe('buyer.mock');
    expect(cfg.mockSellerAccount).toBe('seller.mock');
    expect([cfg.gatewayAccountId, cfg.gatewayPrivateKey, cfg.gatewayKeyPath]).toEqual(['', '', '']);
    expect([cfg.buyerAccountId, cfg.buyerPrivateKey, cfg.buyerKeyPath]).toEqual(['', '', '']);
    expect([cfg.sellerAccountId, cfg.sellerPrivateKey, cfg.sellerKeyPath]).toEqual(['', '', '']);
  });

  it('mock mode tolerates the default admin token', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'mock' })).not.toThrow();
  });

  it('treats empty-string env values as unset (matches .env.example blanks)', () => {
    const cfg = loadConfig({ REGISTRY_CONTRACT_ID: '', NEAR_RPC_URL: '  ', MOCK_BUYER_ACCOUNT: '' });
    expect(cfg.registryContractId).toBe(DEFAULT_REGISTRY_CONTRACT_ID);
    expect(cfg.nearRpcUrl).toBe('https://test.rpc.fastnear.com');
    expect(cfg.mockBuyerAccount).toBe('buyer.mock');
  });

  it('derives DEVNET_URL default from DEVNET_PORT', () => {
    const cfg = loadConfig({ DEVNET_PORT: '5555' });
    expect(cfg.devnetUrl).toBe('http://localhost:5555');
  });

  it('parses overrides', () => {
    const cfg = loadConfig({
      ORACLE_STATIC: '1',
      BUYER_BUDGET_NEAR: '2.5',
      INVOICE_TTL_MS: '1000',
      LOG_LEVEL: 'debug',
      RELAYER_ENABLED: 'true',
      NEAR_RPC_URL: 'https://rpc.example.org',
      NEAR_EXPLORER_URL: 'https://explorer.example.org',
      REGISTRY_CONTRACT_ID: 'registry.neargate.testnet',
      MOCK_SELLER_ACCOUNT: 'alice.mock',
    });
    expect(cfg.oracleStatic).toBe(true);
    expect(cfg.buyerBudgetNear).toBe('2.5');
    expect(cfg.invoiceTtlMs).toBe(1000);
    expect(cfg.relayerEnabled).toBe(true);
    expect(cfg.nearRpcUrl).toBe('https://rpc.example.org');
    expect(cfg.nearExplorerUrl).toBe('https://explorer.example.org');
    expect(cfg.registryContractId).toBe('registry.neargate.testnet');
    expect(cfg.mockSellerAccount).toBe('alice.mock');
  });

  it('reads the gateway, buyer and seller accounts and keys', () => {
    const cfg = loadConfig({
      GATEWAY_ACCOUNT_ID: 'gateway.testnet',
      GATEWAY_PRIVATE_KEY: 'ed25519:gatewaysecret',
      GATEWAY_KEY_PATH: '/keys/gateway.json',
      BUYER_ACCOUNT_ID: 'buyer.testnet',
      BUYER_PRIVATE_KEY: 'ed25519:buyersecret',
      BUYER_KEY_PATH: '/keys/buyer.json',
      SELLER_ACCOUNT_ID: 'seller.testnet',
      SELLER_PRIVATE_KEY: 'ed25519:sellersecret',
      SELLER_KEY_PATH: '/keys/seller.json',
    });
    expect([cfg.gatewayAccountId, cfg.gatewayPrivateKey, cfg.gatewayKeyPath]).toEqual([
      'gateway.testnet',
      'ed25519:gatewaysecret',
      '/keys/gateway.json',
    ]);
    expect([cfg.buyerAccountId, cfg.buyerPrivateKey, cfg.buyerKeyPath]).toEqual([
      'buyer.testnet',
      'ed25519:buyersecret',
      '/keys/buyer.json',
    ]);
    expect([cfg.sellerAccountId, cfg.sellerPrivateKey, cfg.sellerKeyPath]).toEqual([
      'seller.testnet',
      'ed25519:sellersecret',
      '/keys/seller.json',
    ]);
  });

  it('mainnet switches the RPC and explorer defaults', () => {
    const cfg = loadConfig({ NEAR_NETWORK: 'mainnet' });
    expect(cfg.nearNetwork).toBe('mainnet');
    expect(cfg.nearRpcUrl).toBe('https://rpc.mainnet.near.org');
    expect(cfg.nearExplorerUrl).toBe('https://nearblocks.io');
  });
});

describe('loadConfig — validation failures', () => {
  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'prod' })).toThrow(AgentGateError);
  });

  it('rejects an unknown NEAR network', () => {
    expect(() => loadConfig({ NEAR_NETWORK: 'localnet' })).toThrow(/NEAR_NETWORK/);
  });

  it('rejects malformed ports and integers', () => {
    expect(() => loadConfig({ DEVNET_PORT: 'abc' })).toThrow(AgentGateError);
    expect(() => loadConfig({ MIDDLEWARE_PORT: '70000' })).toThrow(AgentGateError);
    expect(() => loadConfig({ INVOICE_TTL_MS: '-5' })).toThrow(AgentGateError);
    expect(() => loadConfig({ UPSTREAM_TIMEOUT_MS: '0' })).toThrow(AgentGateError);
  });

  it('rejects malformed URLs', () => {
    expect(() => loadConfig({ DEVNET_URL: 'not-a-url' })).toThrow(AgentGateError);
    expect(() => loadConfig({ NEAR_RPC_URL: 'not-a-url' })).toThrow(/NEAR_RPC_URL/);
    expect(() => loadConfig({ NEAR_RPC_URL: 'ws://rpc.example.org' })).toThrow(/NEAR_RPC_URL/);
    expect(() => loadConfig({ NEAR_EXPLORER_URL: 'ftp://explorer.example.org' })).toThrow(/NEAR_EXPLORER_URL/);
  });

  it('rejects a malformed buyer budget', () => {
    expect(() => loadConfig({ BUYER_BUDGET_NEAR: '-1' })).toThrow(/BUYER_BUDGET_NEAR/);
    expect(() => loadConfig({ BUYER_BUDGET_NEAR: '1.' + '0'.repeat(24) + '1' })).toThrow(/BUYER_BUDGET_NEAR/);
  });

  it('rejects a malformed RELAYER_ENABLED flag', () => {
    expect(() => loadConfig({ RELAYER_ENABLED: 'maybe' })).toThrow(/RELAYER_ENABLED/);
  });

  it('rejects account ids that are not valid NEAR account ids', () => {
    expect(() => loadConfig({ REGISTRY_CONTRACT_ID: 'Registry.testnet' })).toThrow(/REGISTRY_CONTRACT_ID/);
    expect(() => loadConfig({ GATEWAY_ACCOUNT_ID: 'gateway..testnet' })).toThrow(/GATEWAY_ACCOUNT_ID/);
    expect(() => loadConfig({ BUYER_ACCOUNT_ID: 'b' })).toThrow(/BUYER_ACCOUNT_ID/);
    expect(() => loadConfig({ SELLER_ACCOUNT_ID: 'seller testnet' })).toThrow(/SELLER_ACCOUNT_ID/);
    expect(() => loadConfig({ MOCK_BUYER_ACCOUNT: '-buyer.mock' })).toThrow(/MOCK_BUYER_ACCOUNT/);
    expect(() => loadConfig({ MOCK_SELLER_ACCOUNT: 'Seller.mock' })).toThrow(/MOCK_SELLER_ACCOUNT/);
  });
});

describe('loadConfig — live mode combos', () => {
  it('throws in live mode with the default admin token (explicit)', () => {
    expect(() =>
      loadConfig({ AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: DEFAULT_ADMIN_TOKEN }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it('throws in live mode with the default admin token (implicit via default)', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'live' })).toThrow(/ADMIN_TOKEN/);
  });

  it('accepts live mode with a non-default admin token', () => {
    const cfg = loadConfig({
      AGENTGATE_MODE: 'live',
      AGENTGATE_ADMIN_TOKEN: 'a-strong-unique-token',
      REGISTRY_CONTRACT_ID: 'registry.neargate.testnet',
    });
    expect(cfg.mode).toBe('live');
    expect(cfg.adminToken).toBe('a-strong-unique-token');
    expect(cfg.registryContractId).toBe('registry.neargate.testnet');
  });

  it('config errors carry the CONFIG_INVALID code', () => {
    try {
      loadConfig({ AGENTGATE_MODE: 'live' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentGateError);
      expect((err as AgentGateError).code).toBe('CONFIG_INVALID');
      expect((err as AgentGateError).httpStatus).toBe(500);
    }
  });

  it('allows live mode with the default admin token when the guard is off (CLI reads)', () => {
    const cfg = loadConfig({ AGENTGATE_MODE: 'live' }, { requireStrongAdminToken: false });
    expect(cfg.mode).toBe('live');
    expect(cfg.adminToken).toBe(DEFAULT_ADMIN_TOKEN);
  });
});
