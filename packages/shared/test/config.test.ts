import { describe, expect, it } from 'vitest';
import { AgentGateError, DEFAULT_ADMIN_TOKEN, loadConfig } from '../src/index';

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
    expect(cfg.casperNetwork).toBe('casper-test');
    expect(cfg.csprCloudApiKey).toBe('');
    expect(cfg.llmModel).toBe('claude-sonnet-4-6');
    expect(cfg.oracleStatic).toBe(false);
    expect(cfg.buyerBudgetCspr).toBe('5');
  });

  it('mock mode tolerates the default admin token and no CSPR.cloud key', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'mock' })).not.toThrow();
  });

  it('treats empty-string env values as unset (matches .env.example blanks)', () => {
    const cfg = loadConfig({ CSPR_CLOUD_API_KEY: '', REGISTRY_CONTRACT_PACKAGE_HASH: '' });
    expect(cfg.csprCloudApiKey).toBe('');
    expect(cfg.registryContractPackageHash).toBe('');
  });

  it('derives DEVNET_URL default from DEVNET_PORT', () => {
    const cfg = loadConfig({ DEVNET_PORT: '5555' });
    expect(cfg.devnetUrl).toBe('http://localhost:5555');
  });

  it('parses overrides', () => {
    const cfg = loadConfig({
      ORACLE_STATIC: '1',
      BUYER_BUDGET_CSPR: '2.5',
      INVOICE_TTL_MS: '1000',
      LOG_LEVEL: 'debug',
    });
    expect(cfg.oracleStatic).toBe(true);
    expect(cfg.buyerBudgetCspr).toBe('2.5');
    expect(cfg.invoiceTtlMs).toBe(1000);
  });
});

describe('loadConfig — validation failures', () => {
  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'prod' })).toThrow(AgentGateError);
  });

  it('rejects malformed ports and integers', () => {
    expect(() => loadConfig({ DEVNET_PORT: 'abc' })).toThrow(AgentGateError);
    expect(() => loadConfig({ MIDDLEWARE_PORT: '70000' })).toThrow(AgentGateError);
    expect(() => loadConfig({ INVOICE_TTL_MS: '-5' })).toThrow(AgentGateError);
    expect(() => loadConfig({ UPSTREAM_TIMEOUT_MS: '0' })).toThrow(AgentGateError);
  });

  it('rejects malformed URLs', () => {
    expect(() => loadConfig({ DEVNET_URL: 'not-a-url' })).toThrow(AgentGateError);
    expect(() => loadConfig({ CSPR_CLOUD_STREAMING_URL: 'http://not-ws.example' })).toThrow(
      AgentGateError,
    );
  });

  it('rejects a malformed buyer budget', () => {
    expect(() => loadConfig({ BUYER_BUDGET_CSPR: '-1' })).toThrow(AgentGateError);
    expect(() => loadConfig({ BUYER_BUDGET_CSPR: '1.0000000001' })).toThrow(AgentGateError);
  });
});

describe('loadConfig — live mode combos', () => {
  it('throws in live mode without CSPR_CLOUD_API_KEY', () => {
    expect(() =>
      loadConfig({ AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'a-strong-unique-token' }),
    ).toThrow(/CSPR_CLOUD_API_KEY/);
  });

  it('throws in live mode with the default admin token (explicit)', () => {
    expect(() =>
      loadConfig({
        AGENTGATE_MODE: 'live',
        CSPR_CLOUD_API_KEY: 'some-key',
        AGENTGATE_ADMIN_TOKEN: DEFAULT_ADMIN_TOKEN,
      }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it('throws in live mode with the default admin token (implicit via default)', () => {
    expect(() =>
      loadConfig({ AGENTGATE_MODE: 'live', CSPR_CLOUD_API_KEY: 'some-key' }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it('accepts live mode with a key and a non-default admin token', () => {
    const cfg = loadConfig({
      AGENTGATE_MODE: 'live',
      CSPR_CLOUD_API_KEY: 'some-key',
      AGENTGATE_ADMIN_TOKEN: 'a-strong-unique-token',
    });
    expect(cfg.mode).toBe('live');
    expect(cfg.csprCloudApiKey).toBe('some-key');
    expect(cfg.adminToken).toBe('a-strong-unique-token');
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
});
