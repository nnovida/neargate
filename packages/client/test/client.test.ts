import { describe, expect, it, vi } from 'vitest';
import type { ChainClient } from '@agentgate/shared';
import {
  isAgentGateError,
  encodeXPayment,
  encodeXPaymentResponse,
  decodeXPayment,
  type PaymentRequiredResponse,
} from '@agentgate/shared';
import {
  createAgentGateClient,
  parsePaymentRequired,
} from '@agentgate/client';
import type { ClientCasperSigner } from '@make-software/casper-x402';

const DEPLOY_HASH = 'd'.repeat(64);
const TARGET = `account-hash-${'a'.repeat(64)}`;

function requirements(nonce: string, network: string): PaymentRequiredResponse {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme: 'exact', network, maxAmountRequired: '500000000', asset: 'CSPR',
      payTo: TARGET,
      resource: 'http://svc.test/svc/1',
      description: 'Test', maxTimeoutSeconds: 300,
      extra: {
        nonce,
        serviceId: 1,
        expiresAtMs: Date.now() + 300_000,
        settlement: 'casper-native-transfer',
        transferIdEncoding: 'u64-decimal',
      },
    }],
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

/** A 402 response with a Retry-After header (seconds), used to simulate a pending settlement. */
function pending402(nonce: string, retryAfterSec = 0): Response {
  return new Response(JSON.stringify(requirements(nonce, 'mock')), {
    status: 402,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSec) },
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
  it('402 → pay → retry happy path returns paid result with X-PAYMENT and settlement', async () => {
    const req = requirements('42', 'mock');
    const settlementHeader = encodeXPaymentResponse({ success: true, transaction: DEPLOY_HASH, network: 'mock' });
    const { impl, calls } = queuedFetch([
      json(req, 402),
      new Response(JSON.stringify({ gold: 3310.25 }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-payment-response': settlementHeader },
      }),
    ]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const r = await client.fetchPaid('http://svc.test/svc/1');

    expect(r.paid).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ gold: 3310.25 });
    expect(r.requirements?.maxAmountRequired).toBe('500000000');
    expect(r.settlement?.success).toBe(true);
    expect(r.deployHash).toBe(DEPLOY_HASH);
    expect(r.priceMotes).toBe('500000000');

    // exactly one on-chain transfer, with transferId = nonce
    expect(chain.transfer).toHaveBeenCalledTimes(1);
    expect(chain.transfer).toHaveBeenCalledWith(
      { to: TARGET, amountMotes: '500000000', transferId: '42' },
      SIGNER,
    );

    // exactly 2 fetches: initial + proof
    expect(calls).toHaveLength(2);

    // proof request carried X-PAYMENT header
    const retryHeaders = new Headers(calls[1]?.init?.headers);
    const xPayment = retryHeaders.get('X-PAYMENT');
    expect(xPayment).not.toBeNull();
    const decoded = decodeXPayment(xPayment!);
    expect(decoded.payload.transferId).toBe('42');
    expect(decoded.payload.transaction).toBe(DEPLOY_HASH);

    // first request had no X-PAYMENT
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    expect(firstHeaders.get('X-PAYMENT')).toBeNull();
  });

  it('preserves caller-provided headers on the proof retry', async () => {
    const req = requirements('42', 'mock');
    const { impl, calls } = queuedFetch([json(req, 402), json({ ok: true }, 200)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    await client.fetchPaid('http://svc.test/svc/1', { headers: { 'X-Custom': 'yes' } });

    const retryHeaders = new Headers(calls[1]?.init?.headers);
    expect(retryHeaders.get('X-Custom')).toBe('yes');
    expect(retryHeaders.get('X-PAYMENT')).not.toBeNull();
  });

  it('settlement is undefined when x-payment-response header is absent', async () => {
    const req = requirements('42', 'mock');
    const { impl } = queuedFetch([json(req, 402), json({ ok: true }, 200)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const r = await client.fetchPaid('http://svc.test/svc/1');
    expect(r.paid).toBe(true);
    expect(r.settlement).toBeUndefined();
  });

  it('settlement is undefined when x-payment-response header is malformed (no throw)', async () => {
    const req = requirements('42', 'mock');
    const { impl } = queuedFetch([
      json(req, 402),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-payment-response': 'not-valid-base64-json!!!' },
      }),
    ]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const r = await client.fetchPaid('http://svc.test/svc/1');
    expect(r.paid).toBe(true);
    expect(r.status).toBe(200);
    expect(r.settlement).toBeUndefined(); // decode failure → silently undefined
  });

  it('refuses to pay when invoice price exceeds maxPriceMotes (PRICE_EXCEEDED)', async () => {
    const req = requirements('42', 'mock'); // maxAmountRequired = '500000000'
    const { impl, calls } = queuedFetch([json(req, 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({
      chain,
      signer: SIGNER,
      maxPriceMotes: '100000000',
      fetchImpl: impl,
    });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) {
      expect(err.code).toBe('PRICE_EXCEEDED');
      expect(err.httpStatus).toBe(402);
    }
    expect(chain.transfer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // never retried
  });

  it('pays when invoice price equals maxPriceMotes exactly', async () => {
    const req = requirements('42', 'mock'); // maxAmountRequired = '500000000'
    const { impl } = queuedFetch([json(req, 402), json({ ok: 1 }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({
      chain,
      signer: SIGNER,
      maxPriceMotes: '500000000',
      fetchImpl: impl,
    });
    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.paid).toBe(true);
    expect(chain.transfer).toHaveBeenCalledTimes(1);
  });

  // helpers for bad-fixture tests (captured at describe-parse time; 300s window is plenty)
  const validReq = requirements('42', 'mock');
  const validAccept = validReq.accepts[0]!;
  const validExtra = validAccept.extra;

  it.each([
    ['wrong x402Version',     { ...validReq, x402Version: 3 }],
    ['empty accepts',         { ...validReq, accepts: [] }],
    ['missing nonce',         { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, nonce: undefined } }] }],
    ['non-numeric nonce',     { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, nonce: 'abc' } }] }],
    ['nonce above u64',       { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, nonce: '99999999999999999999' } }] }],
    ['bad maxAmountRequired', { ...validReq, accepts: [{ ...validAccept, maxAmountRequired: '0.5' }] }],
    ['bad payTo',             { ...validReq, accepts: [{ ...validAccept, payTo: 'account-hash-xyz' }] }],
    ['expired expiresAtMs',   { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, expiresAtMs: Date.now() - 1000 } }] }],
  ] as [string, unknown][])('rejects invalid invoice (%s) with BAD_INVOICE and never pays', async (_name, bad) => {
    const { impl } = queuedFetch([json(bad, 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
    expect(chain.transfer).not.toHaveBeenCalled();
  });

  it('rejects a 402 with a non-JSON body with BAD_INVOICE', async () => {
    const { impl } = queuedFetch([new Response('Payment Required', { status: 402 })]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
  });

  it('retries on 402 Retry-After (pending) and then succeeds', async () => {
    const req = requirements('42', 'mock');
    const { impl, calls } = queuedFetch([
      json(req, 402),          // initial → pay
      pending402('42', 0),     // proof attempt 1 → pending (retry-after: 0s)
      pending402('42', 0),     // proof attempt 2 → pending (retry-after: 0s)
      json({ usd_idr: 16250.5 }, 200),
    ]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ usd_idr: 16250.5 });
    expect(chain.transfer).toHaveBeenCalledTimes(1); // paid once, never twice
    expect(calls).toHaveLength(4); // 1 initial + 3 with X-PAYMENT (1 first + 2 retries)
  });

  it('gives up after 5 pending retries and returns the final 402 (still marked paid)', async () => {
    const { impl, calls } = queuedFetch([
      json(requirements('42', 'mock'), 402),
      ...Array.from({ length: 6 }, () => pending402('42', 0)),
    ]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.status).toBe(402);
    expect(result.paid).toBe(true);
    expect(result.deployHash).toBe(DEPLOY_HASH);
    // 1 invoice fetch + 1 first proof attempt + 5 pending retries = 7
    expect(calls).toHaveLength(7);
  });

  it('returns a non-pending 402 proof rejection without retrying (no Retry-After header)', async () => {
    const req = requirements('42', 'mock');
    // 2nd 402 has no retry-after header → stop immediately
    const { impl, calls } = queuedFetch([json(req, 402), json(req, 402)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.status).toBe(402);
    expect(result.paid).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('passes non-402 first responses straight through without paying', async () => {
    const { impl, calls } = queuedFetch([json({ free: true }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result).toEqual({ status: 200, body: { free: true }, paid: false });
    expect(chain.transfer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('passes a 500 first response through unpaid', async () => {
    const { impl } = queuedFetch([json({ error: 'boom' }, 500)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
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

  it('refuses to pay when no accepts entry matches chain network (NETWORK_MISMATCH)', async () => {
    // accepts[0].network = 'casper-test' but chain.network = 'mock' → network mismatch
    const req = requirements('42', 'casper-test');
    const { impl } = queuedFetch([json(req, 402)]);
    const chain = makeChain({ network: 'mock' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) {
      expect(err.code).toBe('NETWORK_MISMATCH');
      expect(err.httpStatus).toBe(502);
    }
    expect(chain.transfer).not.toHaveBeenCalled();
  });

  it('refuses to pay when accepts entry has wrong scheme (BAD_INVOICE)', async () => {
    // scheme is not X402_SCHEME → structural bad invoice
    const req = requirements('42', 'mock');
    const badReq = { ...req, accepts: [{ ...req.accepts[0]!, scheme: 'upto' }] };
    const { impl } = queuedFetch([json(badReq, 402)]);
    const chain = makeChain({ network: 'mock' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
    expect(chain.transfer).not.toHaveBeenCalled();
  });
});

describe('parsePaymentRequired', () => {
  it('returns the matching PaymentRequirements entry', () => {
    const r = requirements('42', 'mock');
    const result = parsePaymentRequired(r, 'mock');
    expect(result).toEqual(r.accepts[0]);
    expect(result.maxAmountRequired).toBe('500000000');
    expect(result.extra.nonce).toBe('42');
  });

  it('rejects non-object bodies', () => {
    for (const bad of [null, 'str', 42, [1, 2]]) {
      expect(() => parsePaymentRequired(bad, 'mock')).toThrowError(/invalid 402 invoice/);
    }
  });

  it('rejects wrong x402Version', () => {
    expect(() =>
      parsePaymentRequired({ ...requirements('42', 'mock'), x402Version: 2 }, 'mock'),
    ).toThrowError(/invalid 402 invoice/);
  });

  it('rejects when no accepts entry matches chain network (NETWORK_MISMATCH)', () => {
    let thrown: unknown;
    try { parsePaymentRequired(requirements('42', 'casper-test'), 'mock'); }
    catch (e) { thrown = e; }
    expect(isAgentGateError(thrown)).toBe(true);
    if (isAgentGateError(thrown)) expect(thrown.code).toBe('NETWORK_MISMATCH');
  });

  it('rejects when no accepts entry matches scheme (BAD_INVOICE)', () => {
    const req = requirements('42', 'mock');
    const badReq = { ...req, accepts: [{ ...req.accepts[0]!, scheme: 'upto' }] };
    expect(() => parsePaymentRequired(badReq, 'mock')).toThrowError(/invalid 402 invoice/);
  });

  it('rejects expiresAtMs: NaN (BAD_INVOICE)', () => {
    const req = requirements('42', 'mock');
    const badReq = {
      ...req,
      accepts: [{ ...req.accepts[0]!, extra: { ...req.accepts[0]!.extra, expiresAtMs: NaN } }],
    };
    expect(() => parsePaymentRequired(badReq, 'mock')).toThrowError(/invalid 402 invoice/);
  });
});

describe('createAgentGateClient · fetchPaid · facilitator (x402 v2) rail', () => {
  // chain.network is 'mock' → CAIP-2 'casper:mock'.
  function v2Requirements(network = 'casper:mock') {
    return {
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      accepts: [{
        scheme: 'exact', network,
        asset: 'f'.repeat(64),
        amount: '100000000',
        payTo: '00' + 'b'.repeat(64),
        maxTimeoutSeconds: 300,
        extra: { name: 'Test USD', version: '1', decimals: 9, symbol: 'TUSD' },
      }],
    };
  }
  // A fake EIP-712 signer so no real key/network is touched; ExactCasperScheme
  // still runs the real typed-data hashing over it.
  const fakeSigner: ClientCasperSigner = {
    accountAddress: () => '00' + 'c'.repeat(64),
    publicKey: () => '02' + 'e'.repeat(66),
    signEIP712: async () => new Uint8Array(65),
  };
  const PEM_SIGNER = { kind: 'pem', pemPath: '/tmp/buyer.pem' } as const;

  it('v2 402 → EIP-712 sign → PAYMENT-SIGNATURE retry returns the settlement, no native transfer', async () => {
    const settlementHeader = encodeXPaymentResponse({
      success: true, transaction: DEPLOY_HASH, network: 'casper:mock', payer: '00' + 'c'.repeat(64),
    });
    const { impl, calls } = queuedFetch([
      json(v2Requirements(), 402),
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-payment-response': settlementHeader },
      }),
    ]);
    const chain = makeChain();
    const client = createAgentGateClient({
      chain,
      signer: PEM_SIGNER,
      fetchImpl: impl,
      facilitatorSignerFactory: async () => fakeSigner,
    });
    const res = await client.fetchPaid('http://svc.test/svc/1');

    expect(res.paid).toBe(true);
    expect(res.status).toBe(200);
    expect(res.deployHash).toBe(DEPLOY_HASH);
    expect(res.settlement?.transaction).toBe(DEPLOY_HASH);
    // the paid retry carried PAYMENT-SIGNATURE, never the native X-PAYMENT
    const retryHeaders = new Headers(calls[1]?.init?.headers);
    expect(retryHeaders.get('payment-signature')).toBeTruthy();
    expect(retryHeaders.get('x-payment')).toBeNull();
    // never touched the native rail
    expect(chain.transfer).not.toHaveBeenCalled();
  });

  it('rejects a mock signer on the facilitator rail with SIGNER_MISSING and never pays', async () => {
    const { impl } = queuedFetch([json(v2Requirements(), 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    await expect(client.fetchPaid('http://svc.test/svc/1')).rejects.toThrow(/facilitator rail requires a live pem key/);
    expect(chain.transfer).not.toHaveBeenCalled();
  });
});
