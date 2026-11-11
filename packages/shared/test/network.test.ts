import { describe, expect, it } from 'vitest';
import { MOCK_NETWORK, MOCK_REGISTRY_ID, isMockNetwork } from '../src/index';

describe('isMockNetwork', () => {
  it('is true only for the offline devnet network id', () => {
    expect(MOCK_NETWORK).toBe('near-mock');
    expect(isMockNetwork('near-mock')).toBe(true);
  });

  it('is false for live networks and for anything else, including the retired bare "mock"', () => {
    for (const network of ['near-testnet', 'near-mainnet', 'mock', 'near:mock', 'NEAR-MOCK', '', ' near-mock']) {
      expect(isMockNetwork(network), JSON.stringify(network)).toBe(false);
    }
  });

  it('names the devnet registry account', () => {
    expect(MOCK_REGISTRY_ID).toBe('registry.mock');
  });
});
