/**
 * Server-only chain access for the dashboard API routes.
 *
 * The dashboard NEVER talks to the devnet / the NEAR RPC directly from the browser —
 * every read goes through /api/* routes which wrap createChainClient(loadConfig()).
 *
 * IMPORTANT: nothing here runs at module load. `getChain()` is called inside
 * request handlers only, so importing a route file can never hit the chain
 * (next build stays side-effect free, with no registry configured and no devnet running).
 */
import {
  createLogger,
  isAgentGateError,
  loadConfig,
  type AgentGateConfig,
  type ChainClient,
} from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';

const log = createLogger('dashboard.api');

export interface ChainHandle {
  config: AgentGateConfig;
  chain: ChainClient;
}

let cached: ChainHandle | null = null;

/**
 * Lazily build (and memoize) the ChainClient. Failures are NOT cached so a
 * transient config/chain error never wedges the process.
 */
export function getChain(): ChainHandle {
  if (cached) return cached;
  // The dashboard only reads the chain: it never serves /admin, so it must not need the gateway's
  // admin token to start (a public dashboard process should not hold that secret at all).
  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  const chain = createChainClient(config);
  cached = { config, chain };
  return cached;
}

/**
 * How the live client words an HTTP 429 from the NEAR RPC (near-errors.ts: "the NEAR RPC
 * rate-limited <what>"); the chain package gives it the generic RPC_ERROR code.
 */
const RPC_RATE_LIMITED = /^the NEAR RPC rate-limited /;

export interface ApiFailure {
  status: number;
  body: { error: string };
}

/**
 * Maps any error thrown while talking to the chain layer to a stable JSON
 * error shape. Devnet down, an unreachable or erroring NEAR RPC and an undeployed
 * registry all surface as 503 {error:"chain_unreachable"} so the UI can show one
 * clear banner; a rate-limited RPC is its own 429 so the feed can serve its cache.
 */
export function toApiFailure(err: unknown, route: string): ApiFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (isAgentGateError(err) && err.code === 'CONFIG_INVALID') {
    log.error('config invalid', { route, message });
    return { status: 500, body: { error: 'config_invalid' } };
  }
  if (isAgentGateError(err) && err.code === 'RPC_ERROR' && RPC_RATE_LIMITED.test(err.message)) {
    log.warn('NEAR RPC rate limited', { route, message });
    return { status: 429, body: { error: 'rate_limited' } };
  }
  log.warn('chain unreachable', { route, message });
  return { status: 503, body: { error: 'chain_unreachable' } };
}

/** Strict numeric id parser for /api/services/[id] (and the page shell). */
export function parseServiceId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** Clamp an optional ?limit= query param to a sane window. */
export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,4}$/.test(raw)) return fallback;
  const n = Number(raw);
  if (n < 1) return fallback;
  return Math.min(n, max);
}
