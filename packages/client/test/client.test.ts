import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainClient, Logger, ServiceRecord } from '@agentgate/shared';
import {
  AgentGateError,
  isAgentGateError,
  encodeXPayment,
  encodeXPaymentResponse,
  decodeXPayment,
  nativeNearOption,
  type PaymentRequiredResponse,
} from '@agentgate/shared';
import {
  PaidNotServedError,
  assertFetchableUrl,
  createAgentGateClient,
  parsePaymentRequired,
} from '@agentgate/client';

const TX_HASH = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';
const REGISTRY = 'registry.mock';
const PRICE = '500000000000000000000000'; // 0.5 NEAR
const MAX_AMOUNT = '502000000000000000000000'; // price + 0.002 NEAR storage fee

function requirements(nonce: string, network: string): PaymentRequiredResponse {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme: 'exact', network, maxAmountRequired: MAX_AMOUNT, asset: 'NEAR',
      payTo: REGISTRY,
      resource: 'http://svc.test/svc/1',
      description: 'Test', maxTimeoutSeconds: 300,
      extra: {
        nonce,
        serviceId: 1,
        expiresAtMs: Date.now() + 300_000,
        settlement: 'neargate-registry-pay',
        contractId: REGISTRY,
        method: 'pay',
        priceYocto: PRICE,
        storageFeeYocto: '2000000000000000000000',
        seller: 'seller.mock',
        caip2: 'near:mock',
      },
    }],
  };
}

function makeChain(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    network: 'near-mock',
    registryId: REGISTRY,
    getService: vi.fn(async () => null),
    listServices: vi.fn(async () => []),
    getScore: vi.fn(async () => ({ totalCalls: 0, successCalls: 0 })),
    listAttestations: vi.fn(async () => []),
    listRecentActivity: vi.fn(async () => []),
    getBalance: vi.fn(async () => '0'),
    getPayment: vi.fn(async () => null),
    verifyPayment: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
    isFullAccessKey: vi.fn(async () => false),
    accountExists: vi.fn(async () => true),
    registerService: vi.fn(async () => ({ serviceId: 1, txHash: 'tx' })),
    pay: vi.fn(async () => ({ txHash: TX_HASH })),
    recordAttestation: vi.fn(async () => ({ txHash: 'tx' })),
    setActive: vi.fn(async () => ({ txHash: 'tx' })),
    escrowOf: vi.fn(async () => '0'),
    depositEscrow: vi.fn(async () => ({ txHash: 'tx' })),
    withdrawEscrow: vi.fn(async () => ({ txHash: 'tx' })),
    payFromEscrow: vi.fn(async () => ({ txHash: TX_HASH })),
    blockHeight: vi.fn(async () => 1_000),
    accessKey: vi.fn(async () => null),
    signPayDelegate: vi.fn(async () => 'delegate'),
    relayPay: vi.fn(async () => ({ txHash: 'tx' })),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The gateway's "still settling" answer: a 402 whose error is `settlement_pending`, carrying the
 * SAME invoice and a Retry-After header (seconds; omitted when `retryAfterSec` is null).
 */
function pending402(nonce: string, retryAfterSec: number | null = 0): Response {
  return new Response(JSON.stringify({ ...requirements(nonce, 'near-mock'), error: 'settlement_pending' }), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      ...(retryAfterSec === null ? {} : { 'retry-after': String(retryAfterSec) }),
    },
  });
}

/** A rejected proof: a fresh-invoice 402 whose error is the verdict (e.g. `not_found`). */
function rejected402(nonce: string, error: string, retryAfterSec?: number): Response {
  return new Response(JSON.stringify({ ...requirements(nonce, 'near-mock'), error }), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      ...(retryAfterSec === undefined ? {} : { 'retry-after': String(retryAfterSec) }),
    },
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

const SIGNER = { kind: 'mock', accountId: 'buyer.mock' } as const;

/** A logger whose calls can be inspected. */
function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    name: 'test',
    level: 'debug' as const,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): Logger => logger,
  };
  return logger;
}

describe('createAgentGateClient · fetchPaid', () => {
  it('402 → pay → retry happy path returns paid result with X-PAYMENT and settlement', async () => {
    const req = requirements('42', 'near-mock');
    const settlementHeader = encodeXPaymentResponse({ success: true, transaction: TX_HASH, network: 'near-mock' });
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
    expect(r.requirements?.maxAmountRequired).toBe(MAX_AMOUNT);
    expect(r.settlement?.success).toBe(true);
    expect(r.txHash).toBe(TX_HASH);
    // the bare price and the attached total (price + storage fee) are both reported
    expect(r.priceYocto).toBe(PRICE);
    expect(r.depositYocto).toBe(MAX_AMOUNT);

    // exactly one registry pay, carrying the invoice's service id + nonce and maxAmountRequired attached
    expect(chain.pay).toHaveBeenCalledTimes(1);
    expect(chain.pay).toHaveBeenCalledWith(
      { serviceId: 1, nonce: '42', depositYocto: MAX_AMOUNT },
      SIGNER,
    );

    // exactly 2 fetches: initial + proof
    expect(calls).toHaveLength(2);

    // proof request carried X-PAYMENT header
    const retryHeaders = new Headers(calls[1]?.init?.headers);
    const xPayment = retryHeaders.get('X-PAYMENT');
    expect(xPayment).not.toBeNull();
    const decoded = decodeXPayment(xPayment!);
    expect(decoded.payload).toEqual({ kind: 'tx', transaction: TX_HASH, nonce: '42', payer: 'buyer.mock' });

    // first request had no X-PAYMENT
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    expect(firstHeaders.get('X-PAYMENT')).toBeNull();
  });

  it('preserves caller-provided headers on the proof retry', async () => {
    const req = requirements('42', 'near-mock');
    const { impl, calls } = queuedFetch([json(req, 402), json({ ok: true }, 200)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    await client.fetchPaid('http://svc.test/svc/1', { headers: { 'X-Custom': 'yes' } });

    const retryHeaders = new Headers(calls[1]?.init?.headers);
    expect(retryHeaders.get('X-Custom')).toBe('yes');
    expect(retryHeaders.get('X-PAYMENT')).not.toBeNull();
  });

  it('settlement is undefined when x-payment-response header is absent', async () => {
    const req = requirements('42', 'near-mock');
    const { impl } = queuedFetch([json(req, 402), json({ ok: true }, 200)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    const r = await client.fetchPaid('http://svc.test/svc/1');
    expect(r.paid).toBe(true);
    expect(r.settlement).toBeUndefined();
  });

  it('settlement is undefined when x-payment-response header is malformed (no throw)', async () => {
    const req = requirements('42', 'near-mock');
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

  it('refuses above maxYocto with BUDGET_EXCEEDED — the cap is the total attached, not the bare price', async () => {
    const req = requirements('42', 'near-mock'); // price 0.5, maxAmountRequired 0.502
    const { impl, calls } = queuedFetch([json(req, 402)]);
    const chain = makeChain();
    // A cap equal to the bare price is still below price + storage fee.
    const client = createAgentGateClient({ chain, signer: SIGNER, maxYocto: PRICE, fetchImpl: impl });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) {
      expect(err.code).toBe('BUDGET_EXCEEDED');
      expect(err.httpStatus).toBe(402);
      expect(err.message).toContain('0.5 NEAR + 0.002 NEAR storage');
    }
    expect(chain.pay).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // never retried
  });

  it('pays maxAmountRequired when it equals maxYocto exactly', async () => {
    const req = requirements('42', 'near-mock'); // maxAmountRequired = MAX_AMOUNT
    const { impl } = queuedFetch([json(req, 402), json({ ok: 1 }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, maxYocto: MAX_AMOUNT, fetchImpl: impl });
    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.paid).toBe(true);
    expect(chain.pay).toHaveBeenCalledWith({ serviceId: 1, nonce: '42', depositYocto: MAX_AMOUNT }, SIGNER);
  });

  it('with expectedServiceId, refuses an invoice for another service (SERVICE_MISMATCH) and never pays', async () => {
    const { impl } = queuedFetch([json(requirements('42', 'near-mock'), 402)]); // invoice is for service 1
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, expectedServiceId: 2, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/2').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('SERVICE_MISMATCH');
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('refuses an invoice that pays a different registry than the chain client (REGISTRY_MISMATCH)', async () => {
    const req = requirements('42', 'near-mock');
    const other = {
      ...req,
      accepts: [{ ...req.accepts[0]!, payTo: 'other-registry.mock', extra: { ...req.accepts[0]!.extra, contractId: 'other-registry.mock' } }],
    };
    const { impl } = queuedFetch([json(other, 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('REGISTRY_MISMATCH');
    expect(chain.pay).not.toHaveBeenCalled();
  });

  // helpers for bad-fixture tests (captured at describe-parse time; 300s window is plenty)
  const validReq = requirements('42', 'near-mock');
  const validAccept = validReq.accepts[0]!;
  const validExtra = validAccept.extra;

  it.each([
    ['wrong x402Version',     { ...validReq, x402Version: 3 }],
    ['empty accepts',         { ...validReq, accepts: [] }],
    ['missing nonce',         { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, nonce: undefined } }] }],
    ['non-numeric nonce',     { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, nonce: 'abc' } }] }],
    ['nonce above u64',       { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, nonce: '99999999999999999999' } }] }],
    ['missing serviceId',     { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, serviceId: undefined } }] }],
    ['serviceId 0',           { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, serviceId: 0 } }] }],
    ['negative serviceId',    { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, serviceId: -1 } }] }],
    ['fractional serviceId',  { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, serviceId: 1.5 } }] }],
    ['unsafe serviceId',      { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, serviceId: 2 ** 53 } }] }],
    ['string serviceId',      { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, serviceId: '1' } }] }],
    ['bad maxAmountRequired', { ...validReq, accepts: [{ ...validAccept, maxAmountRequired: '0.5' }] }],
    ['bad payTo',             { ...validReq, accepts: [{ ...validAccept, payTo: 'Not A NEAR id' }] }],
    ['expired expiresAtMs',   { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, expiresAtMs: Date.now() - 1000 } }] }],
    ['wrong settlement',      { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, settlement: 'transfer' } }] }],
    ['wrong method',          { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, method: 'ft_transfer' } }] }],
    ['contractId ≠ payTo',    { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, contractId: 'other.mock' } }] }],
    ['bad priceYocto',        { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, priceYocto: '0.5' } }] }],
    ['bad storageFeeYocto',   { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, storageFeeYocto: undefined } }] }],
    ['price + fee ≠ total',   { ...validReq, accepts: [{ ...validAccept, maxAmountRequired: '503000000000000000000000' }] }],
    // same total, different split: the storage fee is the registry's fixed 0.002 NEAR
    ['fee ≠ registry fee',    { ...validReq, accepts: [{ ...validAccept, extra: { ...validExtra, priceYocto: '499000000000000000000000', storageFeeYocto: '3000000000000000000000' } }] }],
    ['no NEAR entry',         { ...validReq, accepts: [{ ...validAccept, asset: 'USDC' }] }],
  ] as [string, unknown][])('rejects invalid invoice (%s) with BAD_INVOICE and never pays', async (_name, bad) => {
    const { impl } = queuedFetch([json(bad, 402)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('rejects a 402 with a non-JSON body with BAD_INVOICE', async () => {
    const { impl } = queuedFetch([new Response('Payment Required', { status: 402 })]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
  });

  it('retries on settlement_pending with the same proof, then succeeds (paid once)', async () => {
    const req = requirements('42', 'near-mock');
    const { impl, calls } = queuedFetch([
      json(req, 402),          // initial → pay
      pending402('42', 0),     // proof attempt 1 → settlement_pending (retry-after: 0s)
      pending402('42', 0),     // proof attempt 2 → settlement_pending
      json({ usd_idr: 16250.5 }, 200),
    ]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.body).toEqual({ usd_idr: 16250.5 });
    expect(chain.pay).toHaveBeenCalledTimes(1); // paid once, never twice
    expect(calls).toHaveLength(4); // 1 initial + 3 with X-PAYMENT (1 first + 2 retries)
    const proofs = calls.slice(1).map((c) => new Headers(c.init?.headers).get('X-PAYMENT'));
    expect(new Set(proofs).size).toBe(1); // the identical proof every time
  });

  it('after 3 pending retries throws PAID_NOT_SERVED (settlement_pending) carrying the proof to re-present', async () => {
    const { impl, calls } = queuedFetch([
      json(requirements('42', 'near-mock'), 402),
      ...Array.from({ length: 5 }, () => pending402('42', 0)),
    ]);
    const logger = spyLogger();
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl, logger });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidNotServedError);
    expect(isAgentGateError(err)).toBe(true);
    expect(err).toMatchObject({
      code: 'PAID_NOT_SERVED',
      reason: 'settlement_pending',
      status: 402,
      txHash: TX_HASH,
      nonce: '42',
      serviceId: 1,
      depositYocto: MAX_AMOUNT,
    });
    expect((err as Error).message).toContain(TX_HASH);
    // 1 invoice fetch + 1 first proof attempt + 3 pending retries = 5
    expect(calls).toHaveLength(5);
    // the log says what happened: settlement still pending, not a rejected proof
    const warnings = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes('still pending'))).toBe(true);
    expect(warnings.some((m) => m.includes('rejected'))).toBe(false);
  });

  it('waits the Retry-After seconds between pending retries', async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = queuedFetch([
        json(requirements('42', 'near-mock'), 402),
        pending402('42', 2),
        json({ ok: true }, 200),
      ]);
      const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });
      const done = client.fetchPaid('http://svc.test/svc/1');
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toHaveLength(2); // still waiting out Retry-After: 2
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).status).toBe(200);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a settlement_pending answer without Retry-After still retries, after a default wait', async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = queuedFetch([
        json(requirements('42', 'near-mock'), 402),
        pending402('42', null),
        json({ ok: true }, 200),
      ]);
      const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });
      const done = client.fetchPaid('http://svc.test/svc/1');
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await done).status).toBe(200);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['without Retry-After', undefined],
    ['even with Retry-After', 0],
  ])('a refused proof (not_found) throws PAID_NOT_SERVED without retrying, %s', async (_name, retryAfter) => {
    const { impl, calls } = queuedFetch([
      json(requirements('42', 'near-mock'), 402),
      rejected402('43', 'not_found', retryAfter),
    ]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidNotServedError);
    expect(err).toMatchObject({
      code: 'PAID_NOT_SERVED',
      reason: 'refused',
      status: 402,
      txHash: TX_HASH,
      nonce: '42',
      serviceId: 1,
      depositYocto: MAX_AMOUNT,
    });
    expect((err as Error).message).toContain('not_found');
    expect(calls).toHaveLength(2);
    // the fresh invoice that comes with the refusal is never paid
    expect(chain.pay).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a timeout', (): never => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }, 'timed out'],
    ['a network failure', (): never => {
      throw new TypeError('fetch failed');
    }, 'fetch failed'],
  ])('%s on the paid retry throws PAID_NOT_SERVED (transport) carrying the proof', async (_name, fail, text) => {
    let n = 0;
    const impl = vi.fn(async (): Promise<Response> => {
      n += 1;
      if (n === 1) return json(requirements('42', 'near-mock'), 402);
      return fail();
    }) as unknown as typeof fetch;
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidNotServedError);
    expect(err).toMatchObject({
      code: 'PAID_NOT_SERVED',
      reason: 'transport',
      txHash: TX_HASH,
      nonce: '42',
      serviceId: 1,
      depositYocto: MAX_AMOUNT,
    });
    expect((err as PaidNotServedError).status).toBeUndefined();
    expect((err as Error).message).toContain(text);
    expect(chain.pay).toHaveBeenCalledTimes(1);
  });

  it('a failing registry pay propagates as-is: nothing was paid, so it is not PAID_NOT_SERVED', async () => {
    const { impl, calls } = queuedFetch([json(requirements('42', 'near-mock'), 402)]);
    const chain = makeChain({
      pay: vi.fn(async () => {
        throw new AgentGateError('ERR_DEPOSIT_TOO_LOW', 'ERR_DEPOSIT_TOO_LOW: attach more', 400);
      }),
    });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PaidNotServedError);
    expect(err).toMatchObject({ code: 'ERR_DEPOSIT_TOO_LOW' });
    expect(calls).toHaveLength(1);
  });

  it('skips an accepts entry in another asset and pays the NEAR one', async () => {
    const req = requirements('42', 'near-mock');
    const nearEntry = req.accepts[0]!;
    const other = {
      ...nearEntry,
      asset: 'USDC',
      maxAmountRequired: '1',
      extra: { ...nearEntry.extra, priceYocto: '1', storageFeeYocto: '0' },
    };
    const { impl } = queuedFetch([json({ ...req, accepts: [other, nearEntry] }, 402), json({ ok: true }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const r = await client.fetchPaid('http://svc.test/svc/1');
    expect(r.status).toBe(200);
    expect(r.depositYocto).toBe(MAX_AMOUNT);
    expect(chain.pay).toHaveBeenCalledWith({ serviceId: 1, nonce: '42', depositYocto: MAX_AMOUNT }, SIGNER);
  });

  it('asks fetch never to follow a redirect, on both legs, even when the caller asked it to', async () => {
    const { impl, calls } = queuedFetch([json(requirements('42', 'near-mock'), 402), json({ ok: true }, 200)]);
    const client = createAgentGateClient({ chain: makeChain(), signer: SIGNER, fetchImpl: impl });

    await client.fetchPaid('http://svc.test/svc/1', { redirect: 'follow' });
    expect(calls.map((c) => c.init?.redirect)).toEqual(['manual', 'manual']);
  });

  it('passes non-402 first responses straight through without paying', async () => {
    const { impl, calls } = queuedFetch([json({ free: true }, 200)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result).toEqual({ status: 200, body: { free: true }, paid: false });
    expect(chain.pay).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('passes a 500 first response through unpaid', async () => {
    const { impl } = queuedFetch([json({ error: 'boom' }, 500)]);
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });

    const result = await client.fetchPaid('http://svc.test/svc/1');
    expect(result.status).toBe(500);
    expect(result.paid).toBe(false);
    expect(chain.pay).not.toHaveBeenCalled();
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

  it('rejects a signer whose accountId is not a NEAR account id at construction time (BAD_OPTS)', () => {
    for (const accountId of ['', 'Buyer.testnet', 'buyer..testnet', 'a', 'x'.repeat(65), undefined, 42]) {
      let thrown: unknown;
      try {
        createAgentGateClient({
          chain: makeChain(),
          signer: { kind: 'mock', accountId } as unknown as typeof SIGNER,
          fetchImpl: queuedFetch([]).impl,
        });
      } catch (e) {
        thrown = e;
      }
      expect(isAgentGateError(thrown), JSON.stringify(accountId)).toBe(true);
      if (isAgentGateError(thrown)) {
        expect(thrown.code).toBe('BAD_OPTS');
        expect(thrown.message).toMatch(/accountId must be a NEAR account id/);
      }
    }
    // A near signer is checked the same way.
    expect(() =>
      createAgentGateClient({
        chain: makeChain(),
        signer: { kind: 'near', accountId: 'Not A NEAR id' },
        fetchImpl: queuedFetch([]).impl,
      }),
    ).toThrowError(/accountId must be a NEAR account id/);
  });

  it('rejects garbage maxYocto at construction time', () => {
    expect(() =>
      createAgentGateClient({
        chain: makeChain(),
        signer: SIGNER,
        maxYocto: '0.5',
        fetchImpl: queuedFetch([]).impl,
      }),
    ).toThrowError(/invalid amount/);
  });

  it.each(['javascript:alert(1)', 'ftp://svc.test/svc/1', 'file:///etc/passwd', 'not a url'])(
    'refuses a non-http(s) endpoint %j before fetching (BAD_URL)',
    async (url) => {
      const { impl, calls } = queuedFetch([json({ never: true }, 200)]);
      const chain = makeChain();
      const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
      const err = await client.fetchPaid(url).catch((e: unknown) => e);
      expect(isAgentGateError(err)).toBe(true);
      if (isAgentGateError(err)) expect(err.code).toBe('BAD_URL');
      expect(calls).toHaveLength(0);
      expect(chain.pay).not.toHaveBeenCalled();
    },
  );

  it('refuses a private/loopback host in live mode (SSRF guard)', async () => {
    const { impl } = queuedFetch([json({ unreachable: true }, 200)]);
    const chain = makeChain({ network: 'near-testnet' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://127.0.0.1:8080/x').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('FORBIDDEN_HOST');
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('refuses to pay when no accepts entry matches chain network (NETWORK_MISMATCH)', async () => {
    // accepts[0].network = 'near-testnet' but chain.network = 'near-mock' → network mismatch
    const req = requirements('42', 'near-testnet');
    const { impl } = queuedFetch([json(req, 402)]);
    const chain = makeChain({ network: 'near-mock' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) {
      expect(err.code).toBe('NETWORK_MISMATCH');
      expect(err.httpStatus).toBe(502);
    }
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('refuses to pay when accepts entry has wrong scheme (BAD_INVOICE)', async () => {
    // scheme is not X402_SCHEME → structural bad invoice
    const req = requirements('42', 'near-mock');
    const badReq = { ...req, accepts: [{ ...req.accepts[0]!, scheme: 'upto' }] };
    const { impl } = queuedFetch([json(badReq, 402)]);
    const chain = makeChain({ network: 'near-mock' });
    const client = createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl });
    const err = await client.fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_INVOICE');
    expect(chain.pay).not.toHaveBeenCalled();
  });
});

describe('createAgentGateClient · fetchPaid with payFrom: "escrow"', () => {
  const ESCROW_ENOUGH = '1000000000000000000000000'; // 1 NEAR, over price + fee

  function onChainService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
    return {
      id,
      name: `svc-${id}`,
      description: '',
      endpointUrl: `http://svc.test/svc/${id}`,
      priceYocto: PRICE,
      paymentTarget: 'seller.mock',
      owner: 'owner.mock',
      attestor: 'owner.mock',
      active: true,
      createdAt: 1_700_000_000_000,
      accepts: [nativeNearOption(PRICE)],
      ...over,
    };
  }

  /** A chain whose registry prices service 1 at 0.5 NEAR (what the invoice says) and holds a full escrow. */
  function escrowChain(over: Partial<ChainClient> = {}): ChainClient {
    return makeChain({
      escrowOf: vi.fn(async () => ESCROW_ENOUGH),
      getService: vi.fn(async (id: number) => onChainService(id)),
      ...over,
    });
  }

  /** The invoice for service `serviceId` at the standard 0.502 NEAR total (service 1 is the default). */
  function invoiceFor(serviceId: number, nonce = '42'): PaymentRequiredResponse {
    const base = requirements(nonce, 'near-mock');
    base.accepts[0]!.extra.serviceId = serviceId;
    return base;
  }

  function escrowClient(chain: ChainClient, over: { maxYocto?: string; payFrom?: 'deposit' | 'escrow' } = {}, impl?: typeof fetch) {
    return createAgentGateClient({
      chain,
      signer: SIGNER,
      payFrom: 'escrow',
      fetchImpl: impl ?? (queuedFetch([json(requirements('42', 'near-mock'), 402), json({ ok: 1 }, 200)]).impl),
      ...over,
    });
  }

  it('402 → payFromEscrow → retry with the proof: the escrow pays, `pay` is never called', async () => {
    const { impl, calls } = queuedFetch([json(requirements('42', 'near-mock'), 402), json({ gold: 3310.25 }, 200)]);
    const chain = escrowChain();
    const client = escrowClient(chain, {}, impl);

    const r = await client.fetchPaid('http://svc.test/svc/1');

    expect(r).toMatchObject({ paid: true, status: 200, body: { gold: 3310.25 }, txHash: TX_HASH, priceYocto: PRICE, payFrom: 'escrow' });
    // what the payment cost: price + storage fee, debited from the escrow (nothing is attached)
    expect(r.depositYocto).toBe(MAX_AMOUNT);
    expect(chain.payFromEscrow).toHaveBeenCalledTimes(1);
    expect(chain.payFromEscrow).toHaveBeenCalledWith({ serviceId: 1, nonce: '42' }, SIGNER);
    expect(chain.pay).not.toHaveBeenCalled();
    expect(chain.escrowOf).toHaveBeenCalledWith('buyer.mock'); // the payer's own escrow
    // the same proof as a deposit payment: the tx, the nonce, the payer
    expect(calls).toHaveLength(2);
    const proof = decodeXPayment(new Headers(calls[1]?.init?.headers).get('X-PAYMENT')!);
    expect(proof.payload).toEqual({ kind: 'tx', transaction: TX_HASH, nonce: '42', payer: 'buyer.mock' });
  });

  it('the default is "deposit": `pay` is called, the escrow is never read or spent', async () => {
    const { impl } = queuedFetch([json(requirements('42', 'near-mock'), 402), json({ ok: 1 }, 200)]);
    const chain = makeChain();
    const r = await createAgentGateClient({ chain, signer: SIGNER, fetchImpl: impl }).fetchPaid('http://svc.test/svc/1');
    expect(r.payFrom).toBe('deposit');
    expect(chain.pay).toHaveBeenCalledTimes(1);
    expect(chain.escrowOf).not.toHaveBeenCalled();
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
    // the attached deposit is what a `pay` can cost, enforced on chain: no registry lookup needed
    expect(chain.getService).not.toHaveBeenCalled();
  });

  it('refuses before sending when the escrow holds less than price + fee: ERR_ESCROW_INSUFFICIENT, nothing paid, no gas burned', async () => {
    const short = (BigInt(MAX_AMOUNT) - 1n).toString();
    const { impl, calls } = queuedFetch([json(requirements('42', 'near-mock'), 402)]);
    const chain = escrowChain({ escrowOf: vi.fn(async () => short) });
    const err = await escrowClient(chain, {}, impl).fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentGateError);
    expect(err).toMatchObject({ code: 'ERR_ESCROW_INSUFFICIENT', httpStatus: 402 });
    // the contract's own words, then what happened
    expect((err as Error).message).toBe(
      `ERR_ESCROW_INSUFFICIENT: the escrow holds ${short} yocto, the payment needs ${MAX_AMOUNT} (price + storage fee); nothing was sent`,
    );
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
    expect(chain.pay).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // the unpaid invoice request only
  });

  it('an escrow of exactly price + fee is enough', async () => {
    const chain = escrowChain({ escrowOf: vi.fn(async () => MAX_AMOUNT) });
    const r = await escrowClient(chain).fetchPaid('http://svc.test/svc/1');
    expect(r.paid).toBe(true);
    expect(chain.payFromEscrow).toHaveBeenCalledTimes(1);
  });

  it('an unknown escrow ("0") is insufficient, not an error of another kind', async () => {
    const chain = escrowChain({ escrowOf: vi.fn(async () => '0') });
    await expect(escrowClient(chain).fetchPaid('http://svc.test/svc/1')).rejects.toMatchObject({ code: 'ERR_ESCROW_INSUFFICIENT' });
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
  });

  it('the budget still compares the TOTAL (price + 0.002 NEAR): BUDGET_EXCEEDED first, the escrow is not even read', async () => {
    const { impl } = queuedFetch([json(requirements('42', 'near-mock'), 402)]);
    const chain = escrowChain({ escrowOf: vi.fn(async () => ESCROW_ENOUGH) });
    const err = await escrowClient(chain, { maxYocto: PRICE }, impl).fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'BUDGET_EXCEEDED', httpStatus: 402 });
    expect(chain.escrowOf).not.toHaveBeenCalled();
    expect(chain.payFromEscrow).not.toHaveBeenCalled();

    // a cap equal to the total passes
    const ok = escrowChain({ escrowOf: vi.fn(async () => ESCROW_ENOUGH) });
    expect((await escrowClient(ok, { maxYocto: MAX_AMOUNT }).fetchPaid('http://svc.test/svc/1')).paid).toBe(true);
  });

  it('the invoice refusals come first too: SERVICE_MISMATCH and REGISTRY_MISMATCH never touch the escrow', async () => {
    const chain = escrowChain({ escrowOf: vi.fn(async () => ESCROW_ENOUGH) });
    const mismatch = createAgentGateClient({
      chain,
      signer: SIGNER,
      payFrom: 'escrow',
      expectedServiceId: 2,
      fetchImpl: queuedFetch([json(requirements('42', 'near-mock'), 402)]).impl,
    });
    await expect(mismatch.fetchPaid('http://svc.test/svc/2')).rejects.toMatchObject({ code: 'SERVICE_MISMATCH' });
    const other = escrowChain({ registryId: 'other-registry.mock', escrowOf: vi.fn(async () => ESCROW_ENOUGH) });
    await expect(escrowClient(other).fetchPaid('http://svc.test/svc/1')).rejects.toMatchObject({ code: 'REGISTRY_MISMATCH' });
    expect(chain.escrowOf).not.toHaveBeenCalled();
    expect(other.escrowOf).not.toHaveBeenCalled();
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
    expect(other.payFromEscrow).not.toHaveBeenCalled();
  });

  it('a failing escrow read or payFromEscrow propagates as-is: nothing was paid, so it is not PAID_NOT_SERVED', async () => {
    const rpcDown = new AgentGateError('RPC_ERROR', 'the NEAR RPC was unreachable for the escrow_of view', 502);
    const readFails = escrowChain({ escrowOf: vi.fn(async () => { throw rpcDown; }) });
    await expect(escrowClient(readFails).fetchPaid('http://svc.test/svc/1')).rejects.toBe(rpcDown);
    expect(readFails.payFromEscrow).not.toHaveBeenCalled();

    const used = new AgentGateError('ERR_NONCE_USED', 'ERR_NONCE_USED: nonce already paid', 400);
    const payFails = escrowChain({
      escrowOf: vi.fn(async () => ESCROW_ENOUGH),
      payFromEscrow: vi.fn(async () => { throw used; }),
    });
    const err = await escrowClient(payFails).fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toBe(used);
    expect(err).not.toBeInstanceOf(PaidNotServedError);
    expect(payFails.pay).not.toHaveBeenCalled();
  });

  it('PAID_NOT_SERVED is unchanged: the escrow was debited, the gateway refused the proof, the error carries it', async () => {
    const { impl } = queuedFetch([json(requirements('42', 'near-mock'), 402), rejected402('42', 'not_found')]);
    const chain = escrowChain({ escrowOf: vi.fn(async () => ESCROW_ENOUGH) });
    const err = await escrowClient(chain, {}, impl).fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidNotServedError);
    expect(err).toMatchObject({ reason: 'refused', txHash: TX_HASH, nonce: '42', serviceId: 1, depositYocto: MAX_AMOUNT });
    expect(chain.payFromEscrow).toHaveBeenCalledTimes(1);
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('reads the service from the registry and checks the invoice total against its on-chain price (once, before any send)', async () => {
    const chain = escrowChain();
    await escrowClient(chain).fetchPaid('http://svc.test/svc/1');
    expect(chain.getService).toHaveBeenCalledTimes(1);
    expect(chain.getService).toHaveBeenCalledWith(1);
  });

  it('an invoice that understates the on-chain price is PRICE_MISMATCH: pay_from_escrow would debit more, so nothing is sent', async () => {
    // The seller's invoice says 0.502 NEAR in total; the registry prices service 1 at 5 NEAR.
    const chain = escrowChain({
      getService: vi.fn(async (id: number) => onChainService(id, { priceYocto: '5000000000000000000000000' })),
    });
    const { impl, calls } = queuedFetch([json(requirements('42', 'near-mock'), 402)]);
    // the budget would pass the understated invoice: only the registry check catches the lie
    const err = await escrowClient(chain, { maxYocto: MAX_AMOUNT }, impl).fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentGateError);
    expect(err).toMatchObject({ code: 'PRICE_MISMATCH', httpStatus: 502 });
    expect((err as Error).message).toContain('0.502 NEAR');
    expect((err as Error).message).toContain('5 NEAR + 0.002 NEAR storage');
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
    expect(chain.pay).not.toHaveBeenCalled();
    expect(chain.escrowOf).not.toHaveBeenCalled(); // no escrow read needed to refuse
    expect(calls).toHaveLength(1);
  });

  it('an invoice that overstates the on-chain price is refused as well (the totals must be equal)', async () => {
    const chain = escrowChain({
      getService: vi.fn(async (id: number) => onChainService(id, { priceYocto: '100000000000000000000000' })),
    });
    await expect(escrowClient(chain).fetchPaid('http://svc.test/svc/1')).rejects.toMatchObject({ code: 'PRICE_MISMATCH' });
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
  });

  it('with expectedServiceId unset, the service the invoice NAMES is the one whose on-chain price is checked', async () => {
    const getService = vi.fn(async (id: number) =>
      onChainService(id, id === 5 ? { priceYocto: '9000000000000000000000000' } : {}),
    );
    // service 5 is dear on chain; the invoice (for service 5) claims the 0.5 NEAR of service 1
    const lying = escrowChain({ getService });
    const { impl } = queuedFetch([json(invoiceFor(5), 402)]);
    await expect(escrowClient(lying, {}, impl).fetchPaid('http://svc.test/svc/5')).rejects.toMatchObject({ code: 'PRICE_MISMATCH' });
    expect(getService).toHaveBeenCalledWith(5);
    expect(lying.payFromEscrow).not.toHaveBeenCalled();

    // and an honest invoice for another service pays THAT service
    const honest = escrowChain();
    const { impl: impl2 } = queuedFetch([json(invoiceFor(7), 402), json({ ok: 1 }, 200)]);
    const r = await escrowClient(honest, {}, impl2).fetchPaid('http://svc.test/svc/7');
    expect(r.paid).toBe(true);
    expect(honest.payFromEscrow).toHaveBeenCalledWith({ serviceId: 7, nonce: '42' }, SIGNER);
  });

  it('the budget runs on the verified total: a cap below the on-chain total refuses even for an honest invoice', async () => {
    const chain = escrowChain();
    const err = await escrowClient(chain, { maxYocto: PRICE }).fetchPaid('http://svc.test/svc/1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(chain.getService).toHaveBeenCalledTimes(1); // verified first, then budgeted
    expect(chain.escrowOf).not.toHaveBeenCalled();
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
  });

  it('a missing or paused service is refused (SERVICE_NOT_FOUND / SERVICE_INACTIVE) before anything is sent', async () => {
    const gone = escrowChain({ getService: vi.fn(async () => null) });
    await expect(escrowClient(gone).fetchPaid('http://svc.test/svc/1')).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND', httpStatus: 404 });
    const paused = escrowChain({ getService: vi.fn(async (id: number) => onChainService(id, { active: false })) });
    await expect(escrowClient(paused).fetchPaid('http://svc.test/svc/1')).rejects.toMatchObject({ code: 'SERVICE_INACTIVE', httpStatus: 403 });
    for (const chain of [gone, paused]) {
      expect(chain.escrowOf).not.toHaveBeenCalled();
      expect(chain.payFromEscrow).not.toHaveBeenCalled();
    }
  });

  it('a failing registry read propagates as-is and nothing is sent', async () => {
    const rpcDown = new AgentGateError('RPC_ERROR', 'the NEAR RPC was unreachable for the get_service view', 502);
    const chain = escrowChain({ getService: vi.fn(async () => { throw rpcDown; }) });
    await expect(escrowClient(chain).fetchPaid('http://svc.test/svc/1')).rejects.toBe(rpcDown);
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
  });

  it('rejects a payFrom other than "deposit" or "escrow" at construction (BAD_OPTS)', () => {
    for (const bad of ['wallet', '', 'ESCROW', 1, null]) {
      expect(
        () => createAgentGateClient({ chain: makeChain(), signer: SIGNER, payFrom: bad as never }),
        String(bad),
      ).toThrow(expect.objectContaining({ code: 'BAD_OPTS' }));
    }
    expect(() => createAgentGateClient({ chain: makeChain(), signer: SIGNER, payFrom: undefined })).not.toThrow();
  });

  it('rejects escrow mode on a chain client that has no escrow methods (BAD_OPTS)', () => {
    const old = { ...makeChain(), payFromEscrow: undefined } as unknown as ChainClient;
    expect(() => createAgentGateClient({ chain: old, signer: SIGNER, payFrom: 'escrow' })).toThrow(
      expect.objectContaining({ code: 'BAD_OPTS' }),
    );
    expect(() => createAgentGateClient({ chain: old, signer: SIGNER })).not.toThrow(); // deposit mode needs only `pay`
  });
});

describe('parsePaymentRequired', () => {
  it('returns the matching PaymentRequirements entry', () => {
    const r = requirements('42', 'near-mock');
    const result = parsePaymentRequired(r, 'near-mock');
    expect(result).toEqual(r.accepts[0]);
    expect(result.maxAmountRequired).toBe(MAX_AMOUNT);
    expect(result.extra.nonce).toBe('42');
  });

  it('rejects non-object bodies', () => {
    for (const bad of [null, 'str', 42, [1, 2]]) {
      expect(() => parsePaymentRequired(bad, 'near-mock')).toThrowError(/invalid 402 invoice/);
    }
  });

  it('rejects wrong x402Version', () => {
    expect(() =>
      parsePaymentRequired({ ...requirements('42', 'near-mock'), x402Version: 2 }, 'near-mock'),
    ).toThrowError(/invalid 402 invoice/);
  });

  it('rejects when no accepts entry matches chain network (NETWORK_MISMATCH)', () => {
    let thrown: unknown;
    try { parsePaymentRequired(requirements('42', 'near-testnet'), 'near-mock'); }
    catch (e) { thrown = e; }
    expect(isAgentGateError(thrown)).toBe(true);
    if (isAgentGateError(thrown)) expect(thrown.code).toBe('NETWORK_MISMATCH');
  });

  it('rejects when no accepts entry matches scheme (BAD_INVOICE)', () => {
    const req = requirements('42', 'near-mock');
    const badReq = { ...req, accepts: [{ ...req.accepts[0]!, scheme: 'upto' }] };
    expect(() => parsePaymentRequired(badReq, 'near-mock')).toThrowError(/invalid 402 invoice/);
  });

  it('rejects an extra.serviceId that is not a positive safe integer (BAD_INVOICE)', () => {
    const req = requirements('42', 'near-mock');
    for (const serviceId of [undefined, null, 0, -1, 1.5, 2 ** 53, Number.NaN, '1']) {
      const badReq = {
        ...req,
        accepts: [{ ...req.accepts[0]!, extra: { ...req.accepts[0]!.extra, serviceId } }],
      };
      expect(() => parsePaymentRequired(badReq, 'near-mock'), String(serviceId)).toThrowError(
        /invalid 402 invoice: extra\.serviceId must be a positive integer/,
      );
    }
    const ok = { ...req, accepts: [{ ...req.accepts[0]!, extra: { ...req.accepts[0]!.extra, serviceId: 7 } }] };
    expect(parsePaymentRequired(ok, 'near-mock').extra.serviceId).toBe(7);
  });

  it('skips an entry in another asset listed first and returns the NEAR entry', () => {
    const req = requirements('7', 'near-mock');
    const nearEntry = req.accepts[0]!;
    const other = { ...nearEntry, asset: 'USDC' };
    expect(parsePaymentRequired({ ...req, accepts: [other, nearEntry] }, 'near-mock')).toEqual(nearEntry);
  });

  it('rejects an invoice with no NEAR entry on the network (BAD_INVOICE)', () => {
    const req = requirements('7', 'near-mock');
    const other = { ...req.accepts[0]!, asset: 'USDC' };
    expect(() => parsePaymentRequired({ ...req, accepts: [other] }, 'near-mock')).toThrowError(
      /invalid 402 invoice: no accepts entry pays in NEAR/,
    );
  });

  it('rejects a storage fee other than the registry fee, even when the total adds up (BAD_INVOICE)', () => {
    const req = requirements('7', 'near-mock');
    const entry = req.accepts[0]!;
    const resplit = {
      ...req,
      accepts: [
        {
          ...entry,
          extra: { ...entry.extra, priceYocto: '499000000000000000000000', storageFeeYocto: '3000000000000000000000' },
        },
      ],
    };
    expect(() => parsePaymentRequired(resplit, 'near-mock')).toThrowError(/extra\.storageFeeYocto must be/);
  });

  it('rejects expiresAtMs: NaN (BAD_INVOICE)', () => {
    const req = requirements('42', 'near-mock');
    const badReq = {
      ...req,
      accepts: [{ ...req.accepts[0]!, extra: { ...req.accepts[0]!.extra, expiresAtMs: NaN } }],
    };
    expect(() => parsePaymentRequired(badReq, 'near-mock')).toThrowError(/invalid 402 invoice/);
  });
});

describe('assertFetchableUrl (registry-sourced endpoint URLs)', () => {
  it('accepts http(s) and returns the parsed URL', async () => {
    const url = await assertFetchableUrl('http://127.0.0.1:4021/svc/1', { rejectPrivateHosts: false });
    expect(url.href).toBe('http://127.0.0.1:4021/svc/1');
  });

  it.each(['javascript:alert(1)', 'data:text/plain,hi', 'ftp://svc.test/x', '', 'nope'])(
    'refuses %j with BAD_URL',
    async (raw) => {
      await expect(assertFetchableUrl(raw, { rejectPrivateHosts: false })).rejects.toMatchObject({ code: 'BAD_URL' });
    },
  );

  it('refuses private/loopback hosts only when asked (live), with FORBIDDEN_HOST', async () => {
    await expect(assertFetchableUrl('http://127.0.0.1:4021/svc/1', { rejectPrivateHosts: true })).rejects.toMatchObject({
      code: 'FORBIDDEN_HOST',
    });
    await expect(assertFetchableUrl('http://10.0.0.8/svc/1', { rejectPrivateHosts: true })).rejects.toMatchObject({
      code: 'FORBIDDEN_HOST',
    });
  });
});

/** Start an HTTP server on an ephemeral loopback port. */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('fetchPaid · a gateway redirect is never followed (R35)', () => {
  let target: Server;
  let gateway: Server;
  let targetUrl: string;
  let gatewayUrl: string;
  let targetHits: Array<{ url: string; xPayment: string | undefined }>;
  let gatewayHandler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeEach(async () => {
    targetHits = [];
    const t = await listen((req, res) => {
      const xp = req.headers['x-payment'];
      targetHits.push({ url: req.url ?? '', xPayment: typeof xp === 'string' ? xp : undefined });
      res.end('{"instanceRole":"secret"}');
    });
    target = t.server;
    targetUrl = `${t.base}/latest/meta-data/`;
    const g = await listen((req, res) => gatewayHandler(req, res));
    gateway = g.server;
    gatewayUrl = `${g.base}/svc/1`;
  });

  afterEach(async () => {
    await closeServer(gateway);
    await closeServer(target);
  });

  it('a 302 on the invoice request is refused (REDIRECT_REFUSED, names the status): the target is never contacted, nothing is paid', async () => {
    gatewayHandler = (_req, res) => {
      res.writeHead(302, { location: targetUrl });
      res.end();
    };
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER }); // the real fetch

    const err = await client.fetchPaid(gatewayUrl).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REDIRECT_REFUSED' });
    expect((err as Error).message).toContain('302');
    expect(targetHits).toHaveLength(0);
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('a 307 on the paid retry is not followed: PAID_NOT_SERVED (redirect), the proof never reaches the target', async () => {
    gatewayHandler = (req, res) => {
      if (req.headers['x-payment'] === undefined) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify(requirements('42', 'near-mock')));
        return;
      }
      res.writeHead(307, { location: targetUrl });
      res.end();
    };
    const chain = makeChain();
    const client = createAgentGateClient({ chain, signer: SIGNER });

    const err = await client.fetchPaid(gatewayUrl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaidNotServedError);
    expect(err).toMatchObject({ code: 'PAID_NOT_SERVED', reason: 'redirect', status: 307, txHash: TX_HASH, nonce: '42' });
    expect((err as Error).message).toContain('307');
    expect(chain.pay).toHaveBeenCalledTimes(1);
    expect(targetHits).toHaveLength(0);
  });
});
