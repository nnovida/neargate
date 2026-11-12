/**
 * @neargate/sdk — the NearGate client SDK for Node: read the on-chain registry, pay a gateway's
 * HTTP 402 invoice in native NEAR (from a deposit, from a prepaid escrow, or gasless through the
 * gateway's relay) and get the response, with the same code the `neargate` CLI runs.
 *
 * It re-exports the three workspace packages it is built from, bundled into one file:
 *   - the paying client: createAgentGateClient, fetchPaid's errors, invoice parsing, receipts;
 *   - the chain clients: createChainClient (live NEAR or the offline devnet);
 *   - the shared vocabulary: loadConfig, the hosted defaults, NEAR amounts, x402 types, errors;
 * plus createNearGateChain / nearGateConfig, which configure a client from options.
 */
export * from '@agentgate/shared';
export * from '@agentgate/chain';
export * from '@agentgate/client';
export { createNearGateChain, nearGateConfig, type NearGateChainOpts } from './chain';
export { SDK_VERSION } from './version';
