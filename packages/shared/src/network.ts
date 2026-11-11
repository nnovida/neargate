/**
 * Chain network ids as `ChainClient.network` reports them, and the account the offline
 * devnet uses for the registry contract. Live clients report `near-testnet` or
 * `near-mainnet`.
 */

/** `ChainClient.network` of the offline devnet (the mock chain). */
export const MOCK_NETWORK = 'near-mock';

/** `ChainClient.registryId` of the offline devnet: the account that plays the registry contract. */
export const MOCK_REGISTRY_ID = 'registry.mock';

/** True only for the offline devnet network, where settlement is instant and local hosts are fine. */
export function isMockNetwork(network: string): boolean {
  return network === MOCK_NETWORK;
}
