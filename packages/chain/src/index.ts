import type { AgentGateConfig, ChainClient } from '@agentgate/shared';
import { MockChainHttpClient } from './mock';
import { LiveNearClient } from './near-live';

export { MockChainHttpClient } from './mock';
export { LiveNearClient } from './near-live';
export { TxTimeoutError, mapContractPanic } from './near-errors';
export { verifyNearSignature } from './near-signature';
export { KeySigner } from './near-signer';
export { deriveDevnetKey, type DevnetKey } from './devnet-key';
export {
  PAY_DELEGATE_GAS,
  PAY_DELEGATE_METHOD,
  PAY_DELEGATE_TTL_BLOCKS,
  RELAY_MIN_TTL_BLOCKS,
  buildEscrowPayDelegate,
  decodeSignedDelegate,
  inspectPayDelegate,
  isRelayablePay,
  judgeRelayOutcome,
  payDelegateArgs,
  payDelegateTiming,
  relayablePayDelegate,
  verifyDelegateSignature,
  type DecodedDelegate,
  type DelegateCall,
  type PayDelegateExpectation,
  type PayDelegateRefusal,
  type PayDelegateVerdict,
  type RelayVerdict,
} from './near-delegate';
export {
  agentKeyAction,
  agentKeyPath,
  provisionAgentKey,
  type ProvisionAgentKeyOpts,
  type ProvisionedAgentKey,
} from './near-agent-key';
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
