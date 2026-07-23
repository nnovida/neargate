import { AgentGateError } from './errors';
import { csprToMotes } from './money';
import type { FacilitatorServiceConfig } from './x402';

export type AgentGateMode = 'mock' | 'live';

/** The shipped default admin token. loadConfig() refuses it in live mode. */
export const DEFAULT_ADMIN_TOKEN = 'dev-admin-token';

/**
 * The deployed AgentGateRegistry package hash on Casper Testnet — registry v2
 * (multi-asset `accepts[]`, unlocked/upgradable). The legacy locked v1 package
 * (`hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9`)
 * stays on-chain as the rollback target; readers still decode its layout.
 */
export const DEFAULT_REGISTRY_PACKAGE_HASH =
  'hash-e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df';

/**
 * Default hosted gateway the CLI targets in live mode when `--gateway` is unset.
 * The owner-signature self-map endpoint lives here; override with `--gateway`
 * for a local/self-hosted gateway.
 */
export const DEFAULT_GATEWAY_URL = 'https://gateway.example.org';

/**
 * Default hosted dashboard the CLI links to in live mode when printing the
 * service detail URL; mock mode links to http://localhost:<DASHBOARD_PORT>.
 */
export const DEFAULT_DASHBOARD_URL = 'https://agentgate.example.org';

export interface AgentGateConfig {
  mode: AgentGateMode;
  // ports
  devnetPort: number;
  oraclePort: number;
  middlewarePort: number;
  dashboardPort: number;
  // mock mode
  devnetUrl: string;
  mockBuyerAccount: string;
  mockSellerAccount: string;
  // middleware
  adminToken: string;
  invoiceTtlMs: number;
  upstreamTimeoutMs: number;
  /**
   * Number of trusted reverse-proxy hops in front of the gateway (Express
   * `trust proxy`). 0 = trust none (req.ip is the direct socket peer). Behind a
   * single platform proxy (Railway/Vercel) set TRUST_PROXY=1 so rate limiting
   * keys off the real client IP. Never set this higher than the real hop count
   * or X-Forwarded-For becomes spoofable.
   */
  trustProxy: number;
  // live mode (Casper Testnet)
  casperNodeUrl: string;
  csprCloudApiUrl: string;
  csprCloudApiKey: string;
  csprCloudStreamingUrl: string;
  casperNetwork: string;
  registryContractPackageHash: string;
  gateSignerPemPath: string;
  buyerSignerPemPath: string;
  sellerSignerPemPath: string;
  // LLM
  anthropicApiKey: string;
  llmModel: string;
  // oracle
  oracleStatic: boolean;
  // buyer agent
  buyerBudgetCspr: string;
  // official x402 facilitator rail (CEP-18 + EIP-712 via CSPR.cloud facilitator)
  facilitatorUrl: string;
  buyerKeyAlgo: 'ed25519' | 'secp256k1';
  /** Per-service facilitator config keyed by service id (from FACILITATOR_SERVICES). */
  facilitatorServices: Record<number, FacilitatorServiceConfig>;
}

type Env = Record<string, string | undefined>;

function configError(message: string): AgentGateError {
  return new AgentGateError('CONFIG_INVALID', message, 500);
}

/** Read an env var; empty/whitespace-only values count as unset. */
function readStr(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = readStr(env, key, String(fallback));
  if (!/^\d+$/.test(raw)) {
    throw configError(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configError(`${key} must be an integer between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

function readPort(env: Env, key: string, fallback: number): number {
  return readInt(env, key, fallback, 0, 65535);
}

function readUrl(env: Env, key: string, fallback: string, protocols: readonly string[]): string {
  const raw = readStr(env, key, fallback);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError(`${key} must be a valid URL, got ${JSON.stringify(raw)}`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw configError(`${key} must use one of [${protocols.join(', ')}], got ${parsed.protocol}`);
  }
  return raw;
}

function readBool01(env: Env, key: string, fallback: boolean): boolean {
  const raw = readStr(env, key, fallback ? '1' : '0').toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw configError(`${key} must be 0/1 (or true/false), got ${JSON.stringify(raw)}`);
}

/**
 * Parse the FACILITATOR_SERVICES env map: JSON object keyed by service id, each
 * `{ asset, amount, token: { name, version, decimals, symbol } }`. Empty → {}.
 * Throws CONFIG_INVALID on any malformed entry.
 */
function parseFacilitatorServices(raw: string): Record<number, FacilitatorServiceConfig> {
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError('FACILITATOR_SERVICES must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw configError('FACILITATOR_SERVICES must be a JSON object keyed by service id');
  }
  const out: Record<number, FacilitatorServiceConfig> = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1) {
      throw configError(`FACILITATOR_SERVICES key must be a positive integer service id, got ${JSON.stringify(key)}`);
    }
    if (typeof val !== 'object' || val === null) {
      throw configError(`FACILITATOR_SERVICES[${key}] must be an object`);
    }
    const v = val as Record<string, unknown>;
    const asset = typeof v['asset'] === 'string' ? v['asset'] : '';
    const amount = typeof v['amount'] === 'string' ? v['amount'] : '';
    const token = typeof v['token'] === 'object' && v['token'] !== null ? (v['token'] as Record<string, unknown>) : {};
    if (!/^[0-9a-f]{64}$/i.test(asset)) {
      throw configError(`FACILITATOR_SERVICES[${key}].asset must be a 64-hex CEP-18 package hash`);
    }
    if (!/^\d+$/.test(amount)) {
      throw configError(`FACILITATOR_SERVICES[${key}].amount must be a decimal atomic-unit string`);
    }
    const name = typeof token['name'] === 'string' ? token['name'] : '';
    const version = typeof token['version'] === 'string' ? token['version'] : '';
    const decimals = typeof token['decimals'] === 'number' ? token['decimals'] : NaN;
    const symbol = typeof token['symbol'] === 'string' ? token['symbol'] : '';
    if (name === '' || version === '' || !Number.isInteger(decimals) || symbol === '') {
      throw configError(`FACILITATOR_SERVICES[${key}].token must have { name, version, decimals, symbol }`);
    }
    out[id] = { asset: asset.toLowerCase(), amount, token: { name, version, decimals, symbol } };
  }
  return out;
}

/**
 * Reads and validates the AgentGate environment contract (SPEC §1) once.
 * Throws AgentGateError('CONFIG_INVALID') on invalid values or combos:
 * - unknown AGENTGATE_MODE
 * - live mode without CSPR_CLOUD_API_KEY
 * - live mode with the default admin token
 */
export function loadConfig(
  env: Env = process.env,
  opts: { requireCloudKey?: boolean; requireStrongAdminToken?: boolean } = {},
): AgentGateConfig {
  const requireCloudKey = opts.requireCloudKey ?? true;
  const requireStrongAdminToken = opts.requireStrongAdminToken ?? true;
  const modeRaw = readStr(env, 'AGENTGATE_MODE', 'mock');
  if (modeRaw !== 'mock' && modeRaw !== 'live') {
    throw configError(`AGENTGATE_MODE must be "mock" or "live", got ${JSON.stringify(modeRaw)}`);
  }
  const mode: AgentGateMode = modeRaw;

  const devnetPort = readPort(env, 'DEVNET_PORT', 4030);
  const oraclePort = readPort(env, 'ORACLE_PORT', 4010);
  const middlewarePort = readPort(env, 'MIDDLEWARE_PORT', 4021);
  const dashboardPort = readPort(env, 'DASHBOARD_PORT', 3000);

  const devnetUrl = readUrl(env, 'DEVNET_URL', `http://localhost:${devnetPort}`, ['http:', 'https:']);

  const adminToken = readStr(env, 'AGENTGATE_ADMIN_TOKEN', DEFAULT_ADMIN_TOKEN);
  const invoiceTtlMs = readInt(env, 'INVOICE_TTL_MS', 300_000, 1, Number.MAX_SAFE_INTEGER);
  const upstreamTimeoutMs = readInt(env, 'UPSTREAM_TIMEOUT_MS', 30_000, 1, Number.MAX_SAFE_INTEGER);
  const trustProxy = readInt(env, 'TRUST_PROXY', 0, 0, 10);

  const casperNodeUrl = readUrl(
    env,
    'CASPER_NODE_URL',
    'https://node.testnet.casper.network/rpc',
    ['http:', 'https:'],
  );
  const csprCloudApiUrl = readUrl(env, 'CSPR_CLOUD_API_URL', 'https://api.testnet.cspr.cloud', [
    'http:',
    'https:',
  ]);
  const csprCloudApiKey = readStr(env, 'CSPR_CLOUD_API_KEY', '');
  const csprCloudStreamingUrl = readUrl(
    env,
    'CSPR_CLOUD_STREAMING_URL',
    'wss://streaming.testnet.cspr.cloud',
    ['ws:', 'wss:'],
  );
  const casperNetwork = readStr(env, 'CASPER_NETWORK', 'casper-test');
  const registryContractPackageHash = readStr(env, 'REGISTRY_CONTRACT_PACKAGE_HASH', '');
  const gateSignerPemPath = readStr(env, 'GATE_SIGNER_PEM_PATH', '');
  const buyerSignerPemPath = readStr(env, 'BUYER_SIGNER_PEM_PATH', '');
  const sellerSignerPemPath = readStr(env, 'SELLER_SIGNER_PEM_PATH', '');

  const anthropicApiKey = readStr(env, 'ANTHROPIC_API_KEY', '');
  const llmModel = readStr(env, 'LLM_MODEL', 'claude-sonnet-4-6');

  const oracleStatic = readBool01(env, 'ORACLE_STATIC', false);

  const buyerBudgetCspr = readStr(env, 'BUYER_BUDGET_CSPR', '5');
  try {
    csprToMotes(buyerBudgetCspr);
  } catch {
    throw configError(
      `BUYER_BUDGET_CSPR must be a non-negative CSPR decimal string (max 9 dp), got ${JSON.stringify(buyerBudgetCspr)}`,
    );
  }

  const mockBuyerAccount = readStr(env, 'MOCK_BUYER_ACCOUNT', '');
  const mockSellerAccount = readStr(env, 'MOCK_SELLER_ACCOUNT', '');

  const facilitatorUrl = readUrl(env, 'FACILITATOR_URL', 'https://x402-facilitator.cspr.cloud', [
    'http:',
    'https:',
  ]);
  const buyerKeyAlgoRaw = readStr(env, 'BUYER_KEY_ALGO', 'secp256k1');
  if (buyerKeyAlgoRaw !== 'ed25519' && buyerKeyAlgoRaw !== 'secp256k1') {
    throw configError(`BUYER_KEY_ALGO must be "ed25519" or "secp256k1", got ${JSON.stringify(buyerKeyAlgoRaw)}`);
  }
  const buyerKeyAlgo: 'ed25519' | 'secp256k1' = buyerKeyAlgoRaw;
  const facilitatorServices = parseFacilitatorServices(readStr(env, 'FACILITATOR_SERVICES', ''));

  if (mode === 'live') {
    if (requireCloudKey && csprCloudApiKey === '') {
      throw configError('live mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)');
    }
    if (requireStrongAdminToken && adminToken === DEFAULT_ADMIN_TOKEN) {
      throw configError(
        'live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique token',
      );
    }
  }

  return {
    mode,
    devnetPort,
    oraclePort,
    middlewarePort,
    dashboardPort,
    devnetUrl,
    mockBuyerAccount,
    mockSellerAccount,
    adminToken,
    invoiceTtlMs,
    upstreamTimeoutMs,
    trustProxy,
    casperNodeUrl,
    csprCloudApiUrl,
    csprCloudApiKey,
    csprCloudStreamingUrl,
    casperNetwork,
    registryContractPackageHash,
    gateSignerPemPath,
    buyerSignerPemPath,
    sellerSignerPemPath,
    anthropicApiKey,
    llmModel,
    oracleStatic,
    buyerBudgetCspr,
    facilitatorUrl,
    buyerKeyAlgo,
    facilitatorServices,
  };
}
