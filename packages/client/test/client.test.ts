import { describe, expect, it, vi } from 'vitest';
import type { ChainClient, Invoice402 } from '@agentgate/shared';
import { isAgentGateError } from '@agentgate/shared';
import {
  HEADER_DEPLOY_HASH,
  HEADER_NONCE,
  createAgentGateClient,
  parseInvoice402,
} from '@agentgate/client';

const DEPLOY_HASH = 'd'.repeat(64);
const TARGET = `account-hash-${'a'.repeat(64)}`;

function makeInvoice(overrides: Partial<Invoice402> = {}): Invoice402 {
  return {
    version: 'agentgate-402/1',
    network: 'mock',
    serviceId: 1,
    serviceName: 'RWA Oracle Feed',
    priceMotes: '500000000',
    paymentTarget: TARGET,
    nonce: '123456789',
    expiresAt: Date.now() + 300_000,
    instructions: 'transfer priceMotes to paymentTarget with transfer_id = nonce',
    ...overrides,
  };
}

function makeChain(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    network: 'mock',
    getService: vi.fn(async () => null),
    listServices: vi.fn(async () => []),
    getScore: vi.fn(async () => ({ totalCalls: 0, successCalls: 0 })),
    listAttestations: vi.fn(async () => []),
    listRecentActivity: vi.fn(async () => []),
    getBalance: vi.fn(async () => '0'),
    verifyTransfer: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
    registerService: vi.fn(async () => ({ serviceId: 1, txHash: 'tx' })),
    recordAttestation: vi.fn(async () => ({ txHash: 'tx' })),
    setActive: vi.fn(async () => ({ txHash: 'tx' })),
    transfer: vi.fn(async () => ({ deployHash: DEPLOY_HASH })),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** fetchImpl returning queued responses in order; records every (url, init) call. */
function queuedFetch(responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error('queuedFetch: no more responses queued');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const SIGNER = { kind: 'mock', publicKey: '01ab' } as const;

describe('createAgentGateClient · fetchPaid', () => {
  it('402 → pay → retry happy path returns paid result with proof headers', async () => {
    const invoice = makeInvoice();
    const { impl, calls } = queuedFetch([json(invoice, 402), json({ gold: 3310.25 }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://gateway/svc/1');

    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ gold: 3310.25 });
    expect(result.deployHash).toBe(DEPLOY_HASH);
    expect(result.priceMotes).toBe('500000000');
    expect(result.invoice?.serviceId).toBe(1);
    expect(result.invoice?.nonce).toBe('123456789');

    // exactly one on-chain transfer, with transferId = invoice nonce
    expect(chain.transfer).toHaveBeenCalledTimes(1);
    expect(chain.transfer).toHaveBeenCalledWith(
      { to: TARGET, amountMotes: '500000000', transferId: '123456789' },
      SIGNER,
    );

    // retry carried both proof headers
    expect(calls).toHaveLength(2);
    const retryHeaders = new Headers(calls[1]?.init?.headers);
    expect(retryHeaders.get(HEADER_DEPLOY_HASH)).toBe(DEPLOY_HASH);
    expect(retryHeaders.get(HEADER_NONCE)).toBe('123456789');
    // first request had no proof headers
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    expect(firstHeaders.get(HEADER_DEPLOY_HASH)).toBeNull();
  });

  it('preserves caller-provided headers on the proof retry', async () => {
    const { impl, calls } = queuedFetch([json(makeInvoice(), 402), json({ ok: true }, 200)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    await client.fetchPaid('http://gateway/svc/1', { headers: { 'X-Custom': 'yes' } });

    const retryHeaders = new Headers(calls[1]?.init?.headers);
    expect(retryHeaders.get('X-Custom')).toBe('yes');
    expect(retryHeaders.get(HEADER_DEPLOY_HASH)).toBe(DEPLOY_HASH);
  });

  it('refuses to pay when invoice price exceeds maxPriceMotes (PRICE_EXCEEDED)', async () => {
    const invoice = makeInvoice({ priceMotes: '500000000' });
    const { impl, calls } = queuedFetch([json(invoice, 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({
      chain,
      signer: SIGNER,
      maxPriceMotes: '100000000',
      fetchImpl: impl,
    });

    const err = await client.fetchPaid('http://gateway/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) {
      expect(err.code).toBe('PRICE_EXCEEDED');
      expect(err.httpStatus).toBe(402);
    }
    expect(chain.transfer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // never retried
  });

  it('pays when invoice price equals maxPriceMotes exactly', async () => {
    const { impl } = queuedFetch([json(makeInvoice(), 402), json({ ok: 1 }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({
      chain,
      signer: SIGNER,
      maxPriceMotes: '500000000',
      fetchImpl: impl,
    });
    const result = await client.fetchPaid('http://gateway/svc/1');
    expect(result.paid).toBe(true);
    expect(chain.transfer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong version', makeInvoice({ version: 'agentgate-402/2' as Invoice402['version'] })],
    ['missing nonce', { ...makeInvoice(), nonce: undefined }],
    ['non-numeric nonce', makeInvoice({ nonce: 'abc' })],
    ['nonce above u64', makeInvoice({ nonce: '99999999999999999999' })],
    ['negative serviceId', makeInvoice({ serviceId: -1 })],
    ['float serviceId', makeInvoice({ serviceId: 1.5 })],
    ['empty serviceName', makeInvoice({ serviceName: '   ' })],
    ['bad priceMotes', makeInvoice({ priceMotes: '0.5' })],
    ['bad paymentTarget', makeInvoice({ paymentTarget: 'account-hash-xyz' })],
    ['expired invoice', makeInvoice({ expiresAt: Date.now() - 1000 })],
    ['missing instructions', { ...makeInvoice(), instructions: 42 }],
  ])('rejects invalid invoice (%s) with BAD_INVOICE and never pays', async (_name, bad) => {
    const { impl } = queuedFetch([json(bad, 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const err = await client.fetchPaid('http://gateway/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
    expect(chain.transfer).not.toHaveBeenCalled();
  });

  it('rejects a 402 with a non-JSON body with BAD_INVOICE', async () => {
    const { impl } = queuedFetch([new Response('Payment Required', { status: 402 })]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://gateway/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
  });

  it('retries 402-with-retry_after_ms (pending) and then succeeds', async () => {
    const invoice = makeInvoice();
    const pending = { ...invoice, error: 'pending', retry_after_ms: 5 };
    const { impl, calls } = queuedFetch([
      json(invoice, 402),
      json(pending, 402),
      json(pending, 402),
      json({ usd_idr: 16250.5 }, 200),
    ]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://gateway/svc/1');
    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ usd_idr: 16250.5 });
    expect(chain.transfer).toHaveBeenCalledTimes(1); // paid once, never twice
    expect(calls).toHaveLength(4); // 402 + proof + 2 pending retries... (1 initial, 3 with proof)
  });

  it('gives up after 5 pending retries and returns the final 402 (still marked paid)', async () => {
    const invoice = makeInvoice();
    const pending = { ...invoice, error: 'pending', retry_after_ms: 1 };
    const { impl, calls } = queuedFetch([
      json(invoice, 402),
      ...Array.from({ length: 6 }, () => json(pending, 402)),
    ]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://gateway/svc/1');
    expect(result.status).toBe(402);
    expect(result.paid).toBe(true);
    expect(result.deployHash).toBe(DEPLOY_HASH);
    // 1 invoice fetch + 1 first proof attempt + 5 pending retries = 7
    expect(calls).toHaveLength(7);
  });

  it('returns a non-pending 402 proof rejection without retrying', async () => {
    const invoice = makeInvoice();
    const rejected = { ...invoice, error: 'invoice_used' };
    const { impl, calls } = queuedFetch([json(invoice, 402), json(rejected, 402)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://gateway/svc/1');
    expect(result.status).toBe(402);
    expect(result.paid).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('passes non-402 first responses straight through without paying', async () => {
    const { impl, calls } = queuedFetch([json({ free: true }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://gateway/svc/1');
    expect(result).toEqual({ status: 200, body: { free: true }, paid: false });
    expect(chain.transfer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('passes a 500 first response through unpaid', async () => {
    const { impl } = queuedFetch([json({ error: 'boom' }, 500)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://gateway/svc/1');
    expect(result.status).toBe(500);
    expect(result.paid).toBe(false);
    expect(chain.transfer).not.toHaveBeenCalled();
  });

  it('rejects an empty url', async () => {
    const client = createAgentGateClient({
      chain: makeChain(),
      signer: SIGNER,
      fetchImpl: queuedFetch([]).impl,
    });
    const err = await client.fetchPaid('  ').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_URL');
  });

  it('rejects garbage maxPriceMotes at construction time', () => {
    expect(() =>
      createAgentGateClient({
        chain: makeChain(),
        signer: SIGNER,
        maxPriceMotes: '0.5',
        fetchImpl: queuedFetch([]).impl,
      }),
    ).toThrowError(/invalid amount/);
  });

  it('refuses a private/loopback host in live mode (SSRF guard)', async () => {
    const { impl } = queuedFetch([json({ unreachable: true }, 200)]);
    const chain = makeChain({ network: 'casper-test' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://127.0.0.1:8080/x').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('FORBIDDEN_HOST');
    expect(chain.transfer).not.toHaveBeenCalled();
  });

  it('refuses to pay when the invoice network != chain network', async () => {
    const invoice = makeInvoice({ network: 'casper-test' });
    const { impl } = queuedFetch([json(invoice, 402)]);
    const chain = makeChain({ network: 'mock' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://gateway/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('NETWORK_MISMATCH');
    expect(chain.transfer).not.toHaveBeenCalled();
  });
});

describe('parseInvoice402', () => {
  it('round-trips a valid invoice', () => {
    const invoice = makeInvoice();
    expect(parseInvoice402(invoice)).toEqual(invoice);
  });

  it('rejects non-object bodies', () => {
    for (const bad of [null, 'str', 42, [1, 2]]) {
      expect(() => parseInvoice402(bad)).toThrowError(/invalid 402 invoice/);
    }
  });
});
