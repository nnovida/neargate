import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainClient, PaymentRequiredResponse, ServiceRecord } from '@agentgate/shared';
import { AgentGateError, decodeXPayment, encodeXPaymentResponse, nativeNearOption } from '@agentgate/shared';
import { GASLESS_WAIT_MS, GaslessNotServedError, createAgentGateClient, type AgentGateClientOpts, type GaslessWait } from '@agentgate/client';

// The client's gasless mode (Task 10c): sign a NEP-366 pay_from_escrow delegate (chain.signPayDelegate)
// and hand it to the gateway, which relays it and pays the gas. No network: fetch and chain are fakes.

const REGISTRY = 'registry.mock';
const RELAYER = 'gateway.mock';
const PRICE = '500000000000000000000000'; // 0.5 NEAR
const TOTAL = '502000000000000000000000'; // price + 0.002 NEAR storage fee
const ESCROW_ENOUGH = '1000000000000000000000000';
const RELAY_TX = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';
const DELEGATE = Buffer.from('a signed NEP-366 delegate').toString('base64');
const SIGNER = { kind: 'mock', accountId: 'buyer.mock' } as const;
const URL_1 = 'http://svc.test/svc/1';

/** The gateway's 402 for invoice `nonce` of service 1; `relayer: null` drops the gasless offer. */
function invoice(nonce = '42', over: { relayer?: string | null; relayMethod?: string; error?: string } = {}): PaymentRequiredResponse {
  const extra: Record<string, unknown> = {
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
  };
  if (over.relayer !== null) extra['relayer'] = over.relayer ?? RELAYER;
  if (over.relayer !== null) extra['relayMethod'] = over.relayMethod ?? 'pay_from_escrow';
  return {
    x402Version: 1,
    error: over.error ?? 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'exact',
        network: 'near-mock',
        maxAmountRequired: TOTAL,
        asset: 'NEAR',
        payTo: REGISTRY,
        resource: URL_1,
        description: 'Test',
        maxTimeoutSeconds: 300,
        extra: extra as unknown as PaymentRequiredResponse['accepts'][number]['extra'],
      },
    ],
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function served(body: unknown = { gold: 3310.25 }): Response {
  return json(body, 200, {
    'x-payment-response': encodeXPaymentResponse({ success: true, transaction: RELAY_TX, network: 'near-mock', payer: 'buyer.mock' }),
  });
}

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

/** A chain whose registry prices service 1 at 0.5 NEAR, with a full escrow and a delegate signer. */
function gaslessChain(over: Partial<ChainClient> = {}): ChainClient {
  const unused = (): Promise<never> => Promise.reject(new Error('not used on the gasless rail'));
  return {
    network: 'near-mock',
    registryId: REGISTRY,
    getService: vi.fn(async (id: number) => onChainService(id)),
    listServices: vi.fn(async () => []),
    getScore: vi.fn(async () => ({ totalCalls: 0, successCalls: 0 })),
    listAttestations: vi.fn(async () => []),
    listRecentActivity: vi.fn(async () => []),
    getBalance: vi.fn(async () => '0'),
    getPayment: vi.fn(async () => null),
    verifyPayment: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
    isFullAccessKey: vi.fn(async () => false),
    accountExists: vi.fn(async () => true),
    registerService: vi.fn(unused),
    pay: vi.fn(unused),
    recordAttestation: vi.fn(unused),
    setActive: vi.fn(unused),
    escrowOf: vi.fn(async () => ESCROW_ENOUGH),
    depositEscrow: vi.fn(unused),
    withdrawEscrow: vi.fn(unused),
    payFromEscrow: vi.fn(unused),
    blockHeight: vi.fn(async () => 1_000),
    accessKey: vi.fn(async () => ({ nonce: 41n, permission: 'FullAccess' as const })),
    signPayDelegate: vi.fn(async () => DELEGATE),
    relayPay: vi.fn(unused),
    ...over,
  };
}

function gaslessClient(chain: ChainClient, impl: typeof fetch, over: Partial<AgentGateClientOpts> = {}) {
  return createAgentGateClient({ chain, signer: SIGNER, gasless: true, fetchImpl: impl, ...over });
}

/** The gateway's settlement_pending 402 for invoice 42: the same invoice, the relay tx, Retry-After. */
function pending(retryAfter: string | null = '2'): Response {
  return json(
    { ...invoice('42', { error: 'settlement_pending' }), transaction: RELAY_TX },
    402,
    retryAfter === null ? {} : { 'retry-after': retryAfter },
  );
}

/**
 * A fetch that answers the invoice 402 first, then `answer(n)` for the n-th proof presentation
 * (1-based), recording when each request came (the fake clock) and its X-PAYMENT header.
 */
function scriptedFetch(answer: (presentation: number) => Response) {
  const at: number[] = [];
  const proofs: Array<string | null> = [];
  const impl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    at.push(Date.now());
    const proof = new Headers(init?.headers).get('x-payment');
    if (proof === null) return json(invoice('42'), 402);
    proofs.push(proof);
    return answer(proofs.length);
  });
  return { impl: impl as unknown as typeof fetch, at, proofs };
}

/** Runs `fetchPaid` under the fake clock to its end: its result, or what it threw. */
async function settle<T>(run: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const outcome = run.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  return outcome;
}

describe('createAgentGateClient · fetchPaid with gasless: true', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('402 → signs the pay_from_escrow delegate → X-PAYMENT {kind: delegate} → served; nothing is sent from the account', async () => {
    const { impl, calls } = queuedFetch([json(invoice('42'), 402), served()]);
    const chain = gaslessChain();

    const r = await gaslessClient(chain, impl).fetchPaid(URL_1);

    expect(r).toMatchObject({
      status: 200,
      body: { gold: 3310.25 },
      paid: true,
      gasless: true,
      relayer: RELAYER,
      payFrom: 'escrow',
      txHash: RELAY_TX, // the relay tx, from the gateway's X-PAYMENT-RESPONSE
      priceYocto: PRICE,
      depositYocto: TOTAL, // what the escrow paid
    });
    expect(chain.signPayDelegate).toHaveBeenCalledTimes(1);
    expect(chain.signPayDelegate).toHaveBeenCalledWith({ serviceId: 1, nonce: '42' }, SIGNER);
    expect(chain.pay).not.toHaveBeenCalled();
    expect(chain.payFromEscrow).not.toHaveBeenCalled();
    const header = new Headers(calls[1]!.init?.headers).get('x-payment');
    expect(decodeXPayment(header!)).toEqual({
      x402Version: 1,
      scheme: 'exact',
      network: 'near-mock',
      payload: { kind: 'delegate', signedDelegate: DELEGATE, nonce: '42', payer: 'buyer.mock' },
    });
  });

  it('RELAYER_UNAVAILABLE when the gateway offers no relay of pay_from_escrow — before any read or signature', async () => {
    for (const over of [{ relayer: null }, { relayMethod: 'pay' }, { relayer: 'Not An Account' }]) {
      const { impl, calls } = queuedFetch([json(invoice('42', over), 402)]);
      const chain = gaslessChain();
      await expect(gaslessClient(chain, impl).fetchPaid(URL_1), JSON.stringify(over)).rejects.toMatchObject({
        code: 'RELAYER_UNAVAILABLE',
      });
      expect(chain.getService).not.toHaveBeenCalled();
      expect(chain.escrowOf).not.toHaveBeenCalled();
      expect(chain.signPayDelegate).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1); // the invoice request only
    }
  });

  it('a delegate that cannot be signed aborts the call before any proof is sent', async () => {
    const { impl, calls } = queuedFetch([json(invoice('42'), 402)]);
    const chain = gaslessChain({
      signPayDelegate: vi.fn(async () => {
        throw new AgentGateError('SIGNER_KEY_NOT_FOUND', 'ed25519:… is not an access key of buyer.mock on near-mock', 400);
      }),
    });
    await expect(gaslessClient(chain, impl).fetchPaid(URL_1)).rejects.toMatchObject({ code: 'SIGNER_KEY_NOT_FOUND' });
    expect(calls).toHaveLength(1); // no X-PAYMENT ever reached the gateway
  });

  it("escrow mode's checks run first (R54): PRICE_MISMATCH, BUDGET_EXCEEDED, ERR_ESCROW_INSUFFICIENT — nothing is signed", async () => {
    const cases: Array<[ChainClient, { maxYocto?: string }, string]> = [
      [gaslessChain({ getService: vi.fn(async (id: number) => onChainService(id, { priceYocto: '1' })) }), {}, 'PRICE_MISMATCH'],
      [gaslessChain(), { maxYocto: PRICE }, 'BUDGET_EXCEEDED'],
      [gaslessChain({ escrowOf: vi.fn(async () => (BigInt(TOTAL) - 1n).toString()) }), {}, 'ERR_ESCROW_INSUFFICIENT'],
    ];
    for (const [chain, over, code] of cases) {
      const { impl, calls } = queuedFetch([json(invoice('42'), 402)]);
      await expect(gaslessClient(chain, impl, over).fetchPaid(URL_1)).rejects.toMatchObject({ code });
      expect(chain.signPayDelegate).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1); // no delegate reached the gateway
    }
  });

  it('settlement_pending (the relay is in flight or timed out): the same delegate is presented again, never re-signed', async () => {
    vi.useFakeTimers();
    const { impl, proofs } = scriptedFetch((n) => (n === 1 ? pending('0') : served()));
    const chain = gaslessChain();

    const { value: r } = await settle(gaslessClient(chain, impl).fetchPaid(URL_1));

    expect(r).toMatchObject({ status: 200, paid: true, gasless: true, txHash: RELAY_TX });
    expect(chain.signPayDelegate).toHaveBeenCalledTimes(1);
    expect(proofs).toHaveLength(2);
    expect(proofs[1]).toBe(proofs[0]);
  });

  it('keeps presenting the same delegate while the relay settles, however long the gateway needs within the cap: then served', async () => {
    vi.useFakeTimers();
    const waits: GaslessWait[] = [];
    const { impl, at, proofs } = scriptedFetch((n) => (n <= 40 ? pending('2') : served()));
    const chain = gaslessChain();

    const { value: r } = await settle(gaslessClient(chain, impl, { onGaslessWait: (w) => waits.push(w) }).fetchPaid(URL_1));

    expect(r).toMatchObject({ status: 200, paid: true, gasless: true, txHash: RELAY_TX });
    expect(proofs).toHaveLength(41); // far past the tx rail's 3 retries
    expect(new Set(proofs).size).toBe(1);
    expect(chain.signPayDelegate).toHaveBeenCalledTimes(1);
    expect(at.at(-1)! - at[1]!).toBe(80_000); // 40 waits of 2 s, under the 150 s cap
    expect(waits).toHaveLength(40);
    expect(waits[0]).toEqual({ attempt: 1, transaction: RELAY_TX, retryInMs: 2_000, capMs: GASLESS_WAIT_MS });
    expect(waits.at(-1)?.attempt).toBe(40);
  });

  it('honors Retry-After clamped to 1-10 s between presentations (2 s when the gateway names none)', async () => {
    vi.useFakeTimers();
    const retryAfter = ['0', '60', null, '7'];
    const { impl, at } = scriptedFetch((n) => (n <= retryAfter.length ? pending(retryAfter[n - 1]) : served()));
    await settle(gaslessClient(gaslessChain(), impl).fetchPaid(URL_1));
    const gaps = at.slice(2).map((t, i) => t - at[i + 1]!);
    expect(gaps).toEqual([1_000, 10_000, 2_000, 7_000]);
  });

  it('gives up at the wall-clock cap, never later: GASLESS_NOT_SERVED (escrowPaid unknown) naming the relay tx and the escrow balance', async () => {
    vi.useFakeTimers();
    const { impl, at, proofs } = scriptedFetch(() => pending('10'));
    const client = gaslessClient(gaslessChain(), impl, {
      gaslessWaitMs: 25_000,
      explorerUrl: 'https://testnet.nearblocks.io',
      escrowBalanceHint: '`neargate escrow balance`',
    });

    const { error } = await settle(client.fetchPaid(URL_1));

    expect(error).toBeInstanceOf(GaslessNotServedError);
    expect(error).toMatchObject({
      code: 'GASLESS_NOT_SERVED',
      reason: 'settlement_pending',
      escrowPaid: 'unknown',
      txHash: RELAY_TX,
      signedDelegate: DELEGATE,
      nonce: '42',
    });
    expect(at.slice(1).map((t) => t - at[1]!)).toEqual([0, 10_000, 20_000, 25_000]); // the last wait cut to the cap
    expect(proofs).toHaveLength(4);
    const message = (error as Error).message;
    expect(message).toContain(`https://testnet.nearblocks.io/txns/${RELAY_TX}`);
    expect(message).toContain('`neargate escrow balance`');
    expect(message).toContain('buying again signs a NEW payment');
    expect(message).not.toMatch(/present the same/i); // advice the CLI and MCP cannot follow
    expect(message).not.toContain(DELEGATE);
  });

  it('a relay that can no longer land ends as delegate_expired: a typed "not paid" GASLESS_NOT_SERVED', async () => {
    vi.useFakeTimers();
    const expired = (): Response => json(invoice('43', { error: 'delegate_expired' }), 402);
    const { impl, proofs } = scriptedFetch((n) => (n <= 3 ? pending('5') : expired()));

    const { error } = await settle(gaslessClient(gaslessChain(), impl).fetchPaid(URL_1));

    expect(error).toBeInstanceOf(GaslessNotServedError);
    expect(error).toMatchObject({ reason: 'refused', status: 402, gatewayError: 'delegate_expired', escrowPaid: 'no' });
    expect(proofs).toHaveLength(4);
    expect((error as Error).message).toContain('the escrow did not pay');
  });

  it('a gateway refusal is GASLESS_NOT_SERVED with its error (and the chain code after relay_failed), not PAID_NOT_SERVED', async () => {
    const refusals: Array<[Record<string, unknown>, string, string | undefined, 'no' | 'unknown']> = [
      [{ ...invoice('43', { error: 'escrow_insufficient' }) }, 'escrow_insufficient', undefined, 'no'],
      [{ ...invoice('44', { error: 'relay_failed' }), code: 'ERR_SERVICE_INACTIVE' }, 'relay_failed', 'ERR_SERVICE_INACTIVE', 'no'],
      [{ ...invoice('45', { error: 'stale_nonce' }) }, 'stale_nonce', undefined, 'no'],
      // The registry holds a payment the gateway does not know it relayed: maybe this delegate's, before a restart.
      [{ ...invoice('46', { error: 'invoice_used' }) }, 'invoice_used', undefined, 'unknown'],
    ];
    for (const [body, gatewayError, code, escrowPaid] of refusals) {
      const { impl } = queuedFetch([json(invoice('42'), 402), json(body, 402)]);
      const err = await gaslessClient(gaslessChain(), impl).fetchPaid(URL_1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GaslessNotServedError);
      expect(err).toMatchObject({
        code: 'GASLESS_NOT_SERVED',
        reason: 'refused',
        status: 402,
        gatewayError,
        chainCode: code,
        escrowPaid,
        nonce: '42',
        serviceId: 1,
        signedDelegate: DELEGATE,
      });
      expect((err as Error).message).toContain(gatewayError);
      expect((err as Error).message).toContain(escrowPaid === 'no' ? 'the escrow did not pay' : 'the escrow may have paid');
    }
  });

  it('after settlement_pending, any refusal but delegate_expired leaves it open whether the escrow paid', async () => {
    vi.useFakeTimers();
    const { impl } = scriptedFetch((n) => (n === 1 ? pending('1') : json(invoice('43', { error: 'relay_failed' }), 402)));
    const { error } = await settle(gaslessClient(gaslessChain(), impl).fetchPaid(URL_1));
    expect(error).toMatchObject({ reason: 'refused', gatewayError: 'relay_failed', escrowPaid: 'unknown', txHash: RELAY_TX });
    expect((error as Error).message).toContain(`the relay tx ${RELAY_TX}`);
  });

  it('a redirect or a failed request after the delegate went out: GASLESS_NOT_SERVED that may have paid (redirect, transport)', async () => {
    const redirect = queuedFetch([json(invoice('42'), 402), new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/x' } })]);
    const redirected = await gaslessClient(gaslessChain(), redirect.impl).fetchPaid(URL_1).catch((e: unknown) => e);
    expect(redirected).toBeInstanceOf(GaslessNotServedError);
    expect(redirected).toMatchObject({ reason: 'redirect', status: 302, escrowPaid: 'unknown', signedDelegate: DELEGATE });
    expect((redirected as Error).message).toContain('the escrow may have paid');

    const calls: string[] = [];
    const broken = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      calls.push(String(input));
      if (new Headers(init?.headers).get('x-payment') === null) return json(invoice('42'), 402);
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const failed = await gaslessClient(gaslessChain(), broken).fetchPaid(URL_1).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GaslessNotServedError);
    expect(failed).toMatchObject({ reason: 'transport', status: undefined, escrowPaid: 'unknown', signedDelegate: DELEGATE });
    expect((failed as Error).message).toContain('fetch failed');
    expect(calls).toHaveLength(2); // presented once: a transport failure is never retried blind
  });

  it('BAD_OPTS: a gasless wait that is no duration, a hint or explorer URL that is no text, a progress callback that is no function', () => {
    const chain = gaslessChain();
    const bad: Array<Partial<AgentGateClientOpts>> = [
      { gaslessWaitMs: -1 },
      { gaslessWaitMs: Number.NaN },
      { gaslessWaitMs: Number.POSITIVE_INFINITY },
      { explorerUrl: '' },
      { explorerUrl: 42 as unknown as string },
      { escrowBalanceHint: '' },
      { onGaslessWait: 'log' as unknown as AgentGateClientOpts['onGaslessWait'] },
    ];
    for (const over of bad) {
      expect(() => createAgentGateClient({ chain, signer: SIGNER, gasless: true, ...over }), JSON.stringify(over)).toThrow(
        expect.objectContaining({ code: 'BAD_OPTS' }),
      );
    }
    expect(() => createAgentGateClient({ chain, signer: SIGNER, gasless: true, gaslessWaitMs: 0 })).not.toThrow();
  });

  it('BAD_OPTS: gasless with payFrom "deposit", a non-boolean gasless, or a chain that cannot sign delegates', () => {
    const chain = gaslessChain();
    expect(() => createAgentGateClient({ chain, signer: SIGNER, gasless: true, payFrom: 'deposit' })).toThrow(
      expect.objectContaining({ code: 'BAD_OPTS' }),
    );
    expect(() => createAgentGateClient({ chain, signer: SIGNER, gasless: 'yes' as unknown as boolean })).toThrow(
      expect.objectContaining({ code: 'BAD_OPTS' }),
    );
    const noDelegates = gaslessChain();
    delete (noDelegates as Partial<ChainClient>).signPayDelegate;
    expect(() => createAgentGateClient({ chain: noDelegates, signer: SIGNER, gasless: true })).toThrow(
      expect.objectContaining({ code: 'BAD_OPTS' }),
    );
    // gasless implies the escrow; saying so explicitly is fine
    expect(() => createAgentGateClient({ chain, signer: SIGNER, gasless: true, payFrom: 'escrow' })).not.toThrow();
  });
});
