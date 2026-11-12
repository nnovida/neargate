import { createChainClient } from '@agentgate/chain';
import { loadConfig, type AgentGateConfig, type ChainClient } from '@agentgate/shared';

/** Where an SDK chain client reads and pays. Every field is optional: the defaults are the live deployment. */
export interface NearGateChainOpts {
  /** `'live'` (NEAR, the default) or `'mock'` (the offline devnet of the repository's `npm run dev`). */
  mode?: 'live' | 'mock';
  /** `'testnet'` (default) or `'mainnet'`: picks the default RPC and explorer and the key folder. */
  network?: 'testnet' | 'mainnet';
  /** The NEAR RPC; default: the network's public RPC. */
  rpcUrl?: string;
  /** The registry contract; default: DEFAULT_REGISTRY_CONTRACT_ID, the deployed testnet registry. */
  registryId?: string;
  /** Mock mode: the devnet's URL; default http://localhost:4030. */
  devnetUrl?: string;
}

/**
 * The configuration a client needs, from options rather than the environment. It holds no admin
 * token, so the gateway-only rule that refuses the default token in live mode does not apply.
 * Throws AgentGateError('CONFIG_INVALID') on a malformed value.
 */
export function nearGateConfig(opts: NearGateChainOpts = {}): AgentGateConfig {
  const env: Record<string, string> = { AGENTGATE_MODE: opts.mode ?? 'live' };
  if (opts.network !== undefined) env['NEAR_NETWORK'] = opts.network;
  if (opts.rpcUrl !== undefined) env['NEAR_RPC_URL'] = opts.rpcUrl;
  if (opts.registryId !== undefined) env['REGISTRY_CONTRACT_ID'] = opts.registryId;
  if (opts.devnetUrl !== undefined) env['DEVNET_URL'] = opts.devnetUrl;
  return loadConfig(env, { requireStrongAdminToken: false });
}

/** A chain client for the registry: `createNearGateChain()` reads and pays on the live testnet deployment. */
export function createNearGateChain(opts: NearGateChainOpts = {}): ChainClient {
  return createChainClient(nearGateConfig(opts));
}
