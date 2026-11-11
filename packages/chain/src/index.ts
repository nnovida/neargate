import { AgentGateError } from '@agentgate/shared';
import type { AgentGateConfig, ChainClient } from '@agentgate/shared';
import { MockChainHttpClient } from './mock';

export { MockChainHttpClient } from './mock';
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
 * - 'live' → the NEAR live client (TODO(Task 6): LiveNearClient on near-api-js)
 */
export function createChainClient(config: AgentGateConfig): ChainClient {
  if (config.mode === 'live') {
    throw new AgentGateError('CONFIG_INVALID', 'live mode lands in Task 6', 500);
  }
  return new MockChainHttpClient(config.devnetUrl);
}
