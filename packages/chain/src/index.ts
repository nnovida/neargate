import type { AgentGateConfig, ChainClient } from '@agentgate/shared';
import { MockChainHttpClient } from './mock';
import { LiveCasperClient } from './live';

export { MockChainHttpClient, mockAccountHash } from './mock';
export { LiveCasperClient } from './live';
export { verifyOwnerSignature, type OwnerSignatureResult } from './signature';

/**
 * Picks the ChainClient implementation by `config.mode` (SPEC §4):
 * - 'mock' → MockChainHttpClient (REST against the local devnet at config.devnetUrl)
 * - 'live' → LiveCasperClient (casper-js-sdk v5 + CSPR.cloud REST)
 */
export function createChainClient(config: AgentGateConfig): ChainClient {
  return config.mode === 'live'
    ? new LiveCasperClient(config)
    : new MockChainHttpClient(config.devnetUrl);
}
