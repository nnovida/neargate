import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@agentgate/shared';
import { LiveCasperClient } from '../src/live';

/**
 * When CSPR.cloud has not yet indexed a just-submitted transfer, GET
 * /deploys/<hash>/transfers returns an empty list. verifyTransfer then probes
 * GET /deploys/<hash> to classify the empty result. Anything short of an
 * explicit on-chain failure is settlement lag → `pending` (retryable), so the
 * buyer's client keeps polling instead of giving up on a payment that already
 * settled. Only a deploy that errored on-chain is a hard `not_found`.
 */

const HASH = 'a'.repeat(64);
const QUERY = {
  deployHash: HASH,
  expectedTarget: `account-hash-${'1'.repeat(64)}`,
  minAmountMotes: '2500000000',
  expectedTransferId: '778899',
  maxAgeMs: 300_000,
};

function liveClient(): LiveCasperClient {
  const config = loadConfig(
    {
      AGENTGATE_MODE: 'live',
      CASPER_NODE_URL: 'https://node.example/rpc',
      CSPR_CLOUD_API_URL: 'https://cloud.example',
      CSPR_CLOUD_API_KEY: 'test-key',
      CASPER_NETWORK: 'casper-test',
      REGISTRY_CONTRACT_PACKAGE_HASH: `hash-${'f'.repeat(64)}`,
    },
    { requireCloudKey: false, requireStrongAdminToken: false },
  );
  return new LiveCasperClient(config);
}

/** Stub fetch: /transfers → empty list; /deploys/<hash> → the given deploy (or 404). */
function stubCloud(deploy: Record<string, unknown> | null): void {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/transfers')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (deploy === null) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ data: deploy }), { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('verifyTransfer — empty /transfers classification', () => {
  it('finalized deploy (block_hash, no error) but transfers not indexed yet → pending (retryable)', async () => {
    stubCloud({ block_hash: 'b'.repeat(64), error_message: null });
    const verdict = await liveClient().verifyTransfer(QUERY);
    expect(verdict).toEqual({ ok: false, reason: 'pending' });
  });

  it('deploy not yet in a block (no block_hash, no error) → pending', async () => {
    stubCloud({ block_hash: null, error_message: null });
    const verdict = await liveClient().verifyTransfer(QUERY);
    expect(verdict).toEqual({ ok: false, reason: 'pending' });
  });

  it('deploy not visible in CSPR.cloud yet (404) → pending', async () => {
    stubCloud(null);
    const verdict = await liveClient().verifyTransfer(QUERY);
    expect(verdict).toEqual({ ok: false, reason: 'pending' });
  });

  it('deploy failed on-chain (error_message present) → not_found (hard failure)', async () => {
    stubCloud({ block_hash: 'b'.repeat(64), error_message: 'Out of gas' });
    const verdict = await liveClient().verifyTransfer(QUERY);
    expect(verdict).toEqual({ ok: false, reason: 'not_found' });
  });
});
