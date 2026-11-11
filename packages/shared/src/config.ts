import { AgentGateError } from './errors';
import { nearToYocto } from './money';
import { isNearAccountId } from './x402';

export type AgentGateMode = 'mock' | 'live';

/** The shipped default admin token. loadConfig() refuses it in live mode. */
export const DEFAULT_ADMIN_TOKEN = 'dev-admin-token';

export type NearNetwork = 'testnet' | 'mainnet';

/**
 * The deployed `neargate-registry` contract id on NEAR testnet.
 * TODO(Task 7): set to the deployed contract id; empty until then.
 */
export const DEFAULT_REGISTRY_CONTRACT_ID = '';

/**
 * Default hosted gateway the CLI targets in live mode when `--gateway` is unset.
 * The owner-signature self-map endpoint lives here; override with `--gateway`
 * for a local/self-hosted gateway.
 * TODO(Task 9): point at the NearGate hosted gateway.
 */
export const DEFAULT_GATEWAY_URL = 'https://gateway.example.org';

/**
 * Default hosted dashboard the CLI links to in live mode when printing the
 * service detail URL; mock mode links to http://localhost:<DASHBOARD_PORT>.
 * TODO(Task 9): point at the NearGate hosted dashboard.
 */
export const DEFAULT_DASHBOARD_URL = 'https://agentgate.example.org';

/** Per-network RPC and explorer defaults (overridable via NEAR_RPC_URL / NEAR_EXPLORER_URL). */
const NEAR_DEFAULTS: Record<NearNetwork, { rpcUrl: string; explorerUrl: string }> = {
  testnet: { rpcUrl: 'https://rpc.testnet.near.org', explorerUrl: 'https://testnet.nearblocks.io' },
  mainnet: { rpcUrl: 'https://rpc.mainnet.near.org', explorerUrl: 'https://nearblocks.io' },
};

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
  // live mode (NEAR)
  nearNetwork: NearNetwork;
  nearRpcUrl: string;
  nearExplorerUrl: string;
  registryContractId: string;
  /** Gateway account: signs attestations (and relays delegate actions when enabled). */
  gatewayAccountId: string;
  gatewayPrivateKey: string;
  gatewayKeyPath: string;
  buyerAccountId: string;
  buyerPrivateKey: string;
  buyerKeyPath: string;
  sellerAccountId: string;
  sellerPrivateKey: string;
  sellerKeyPath: string;
  // LLM
  anthropicApiKey: string;
  llmModel: string;
  // oracle
  oracleStatic: boolean;
  // buyer agent
  buyerBudgetNear: string;
  /** Gasless rail: the gateway relays NEP-366 signed delegate actions. */
  relayerEnabled: boolean;
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

/** Read an optional NEAR account id; empty means unset, anything else must be valid. */
function readAccountId(env: Env, key: string, fallback: string): string {
  const raw = readStr(env, key, fallback);
  if (raw !== '' && !isNearAccountId(raw)) {
    throw configError(`${key} must be a NEAR account id, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Reads and validates the AgentGate environment contract once.
 * Throws AgentGateError('CONFIG_INVALID') on invalid values or combos:
 * - unknown AGENTGATE_MODE or NEAR_NETWORK
 * - malformed URLs, ports, amounts or NEAR account ids
 * - live mode with the default admin token (unless `requireStrongAdminToken: false`)
 */
export function loadConfig(
  env: Env = process.env,
  opts: { requireStrongAdminToken?: boolean } = {},
): AgentGateConfig {
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

  const nearNetworkRaw = readStr(env, 'NEAR_NETWORK', 'testnet');
  if (nearNetworkRaw !== 'testnet' && nearNetworkRaw !== 'mainnet') {
    throw configError(`NEAR_NETWORK must be "testnet" or "mainnet", got ${JSON.stringify(nearNetworkRaw)}`);
  }
  const nearNetwork: NearNetwork = nearNetworkRaw;
  const nearRpcUrl = readUrl(env, 'NEAR_RPC_URL', NEAR_DEFAULTS[nearNetwork].rpcUrl, ['http:', 'https:']);
  const nearExplorerUrl = readUrl(env, 'NEAR_EXPLORER_URL', NEAR_DEFAULTS[nearNetwork].explorerUrl, [
    'http:',
    'https:',
  ]);
  const registryContractId = readAccountId(env, 'REGISTRY_CONTRACT_ID', DEFAULT_REGISTRY_CONTRACT_ID);
  const gatewayAccountId = readAccountId(env, 'GATEWAY_ACCOUNT_ID', '');
  const gatewayPrivateKey = readStr(env, 'GATEWAY_PRIVATE_KEY', '');
  const gatewayKeyPath = readStr(env, 'GATEWAY_KEY_PATH', '');
  const buyerAccountId = readAccountId(env, 'BUYER_ACCOUNT_ID', '');
  const buyerPrivateKey = readStr(env, 'BUYER_PRIVATE_KEY', '');
  const buyerKeyPath = readStr(env, 'BUYER_KEY_PATH', '');
  const sellerAccountId = readAccountId(env, 'SELLER_ACCOUNT_ID', '');
  const sellerPrivateKey = readStr(env, 'SELLER_PRIVATE_KEY', '');
  const sellerKeyPath = readStr(env, 'SELLER_KEY_PATH', '');

  const anthropicApiKey = readStr(env, 'ANTHROPIC_API_KEY', '');
  const llmModel = readStr(env, 'LLM_MODEL', 'claude-sonnet-4-6');

  const oracleStatic = readBool01(env, 'ORACLE_STATIC', false);

  const buyerBudgetNear = readStr(env, 'BUYER_BUDGET_NEAR', '1');
  try {
    nearToYocto(buyerBudgetNear);
  } catch {
    throw configError(
      `BUYER_BUDGET_NEAR must be a non-negative NEAR decimal string (max 24 dp), got ${JSON.stringify(buyerBudgetNear)}`,
    );
  }
  const relayerEnabled = readBool01(env, 'RELAYER_ENABLED', false);

  const mockBuyerAccount = readAccountId(env, 'MOCK_BUYER_ACCOUNT', 'buyer.mock');
  const mockSellerAccount = readAccountId(env, 'MOCK_SELLER_ACCOUNT', 'seller.mock');

  if (mode === 'live' && requireStrongAdminToken && adminToken === DEFAULT_ADMIN_TOKEN) {
    throw configError('live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique token');
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
    nearNetwork,
    nearRpcUrl,
    nearExplorerUrl,
    registryContractId,
    gatewayAccountId,
    gatewayPrivateKey,
    gatewayKeyPath,
    buyerAccountId,
    buyerPrivateKey,
    buyerKeyPath,
    sellerAccountId,
    sellerPrivateKey,
    sellerKeyPath,
    anthropicApiKey,
    llmModel,
    oracleStatic,
    buyerBudgetNear,
    relayerEnabled,
  };
}
