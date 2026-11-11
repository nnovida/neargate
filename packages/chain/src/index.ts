import type { AgentGateConfig, ChainClient } from '@agentgate/shared';
import { MockChainHttpClient } from './mock';
import { LiveNearClient } from './near-live';

export { MockChainHttpClient } from './mock';
export { LiveNearClient } from './near-live';
export { mapContractPanic } from './near-errors';
export { verifyNearSignature } from './near-signature';
export {
  defaultCredentialsPath,
  loadNearSigner,
  type LoadNearSignerOpts,
  type LoadedNearSigner,
} from './near-keys';

/**
 * Picks the ChainClient implementation by `config.mode`:
 * - 'mock' → MockChainHttpClient (REST against the local devnet at config.devnetUrl)
 * - 'live' → LiveNearClient (the neargate-registry contract over the NEAR RPC at
 *   config.nearRpcUrl); throws CONFIG_INVALID while REGISTRY_CONTRACT_ID is unset
 */
export function createChainClient(config: AgentGateConfig): ChainClient {
  if (config.mode === 'live') return new LiveNearClient(config);
  return new MockChainHttpClient(config.devnetUrl);
}
