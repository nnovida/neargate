import { describe, expect, it, vi } from 'vitest';
import type { AnySigner, ChainClient, RegisterServiceInput } from '@agentgate/shared';
import { signMessage, wrapService } from '../src/index';

// TODO(Task 5): NEAR-key self-map — sign `buildSelfMapMessage` with the seller's
// full-access key and assert the base64 signature verifies under the transmitted
// publicKey; the POST body is {upstreamUrl, accountId, publicKey, signature, timestamp}.

const NEAR_SIGNER: AnySigner = {
  kind: 'near',
  accountId: 'seller.testnet',
  keyPath: '/nonexistent/seller.testnet.json',
};

/** Minimal ChainClient: wrapService only calls registerService in these tests. */
function fakeChain(): ChainClient {
  return {
    network: 'near-testnet',
    registryId: 'registry.testnet',
    registerService: async (_input: RegisterServiceInput, _signer: AnySigner) => ({
      serviceId: 1,
      txHash: 'F'.repeat(44),
    }),
  } as unknown as ChainClient;
}

describe('signMessage', () => {
  it('rejects a mock signer (self-map needs a real key)', async () => {
    await expect(
      signMessage({ kind: 'mock', accountId: 'seller.mock' }, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'SIGNER_UNSUPPORTED' });
  });

  it('does not sign with a NEAR key yet (lands in Task 5)', async () => {
    await expect(signMessage(NEAR_SIGNER, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      httpStatus: 501,
    });
  });
});

describe('wrapService self-map path (NEAR key signer)', () => {
  it('never falls back to the admin-token POST and keeps the registration', async () => {
    const calls: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await wrapService({
        upstreamUrl: 'https://api.example.com/gold',
        priceNear: '0.5',
        name: 'Gold',
        gateway: 'https://gw.example',
        chain: fakeChain(),
        signer: NEAR_SIGNER,
        adminToken: 'dev-admin-token',
        mode: 'live',
        network: 'near-testnet',
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(null, { status: 204 });
        },
      });
      expect(result.serviceId).toBe(1);
      expect(result.adminOk).toBe(false);
      expect(result.adminWarning).toContain('self-map signing');
      expect(calls).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });
});
