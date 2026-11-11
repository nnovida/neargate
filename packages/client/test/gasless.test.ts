import { describe, expect, it, vi } from 'vitest';
import type { ChainClient, PaymentRequiredResponse, ServiceRecord } from '@agentgate/shared';
import { decodeXPayment, encodeXPaymentResponse, nativeNearOption } from '@agentgate/shared';
import { GaslessNotServedError, createAgentGateClient } from '@agentgate/client';

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

function gaslessClient(chain: ChainClient, impl: typeof fetch, over: { maxYocto?: string } = {}) {
  return createAgentGateClient({ chain, signer: SIGNER, gasless: true, fetchImpl: impl, ...over });
}

describe('createAgentGateClient · fetchPaid with gasless: true', () => {
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
      const { impl } = queuedFetch([json(invoice('42', over), 402)]);
      const chain = gaslessChain();
      await expect(gaslessClient(chain, impl).fetchPaid(URL_1), JSON.stringify(over)).rejects.toMatchObject({
        code: 'RELAYER_UNAVAILABLE',
      });
      expect(chain.getService).not.toHaveBeenCalled();
      expect(chain.escrowOf).not.toHaveBeenCalled();
      expect(chain.signPayDelegate).not.toHaveBeenCalled();
    }
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
    const pending = json({ ...invoice('42', { error: 'settlement_pending' }), transaction: RELAY_TX }, 402, { 'retry-after': '0' });
    const { impl, calls } = queuedFetch([json(invoice('42'), 402), pending, served()]);
    const chain = gaslessChain();

    const r = await gaslessClient(chain, impl).fetchPaid(URL_1);

    expect(r).toMatchObject({ status: 200, paid: true, gasless: true, txHash: RELAY_TX });
    expect(chain.signPayDelegate).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[2]!.init?.headers).get('x-payment')).toBe(new Headers(calls[1]!.init?.headers).get('x-payment'));
  });

  it('a gateway refusal is GASLESS_NOT_SERVED with its error (and the chain code after relay_failed), not PAID_NOT_SERVED', async () => {
    const refusals: Array<[Record<string, unknown>, string, string | undefined]> = [
      [{ ...invoice('43', { error: 'escrow_insufficient' }) }, 'escrow_insufficient', undefined],
      [{ ...invoice('44', { error: 'relay_failed' }), code: 'ERR_SERVICE_INACTIVE' }, 'relay_failed', 'ERR_SERVICE_INACTIVE'],
    ];
    for (const [body, gatewayError, code] of refusals) {
      const { impl } = queuedFetch([json(invoice('42'), 402), json(body, 402)]);
      const err = await gaslessClient(gaslessChain(), impl).fetchPaid(URL_1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GaslessNotServedError);
      expect(err).toMatchObject({
        code: 'GASLESS_NOT_SERVED',
        reason: 'refused',
        status: 402,
        gatewayError,
        chainCode: code,
        nonce: '42',
        serviceId: 1,
        signedDelegate: DELEGATE,
      });
      expect((err as Error).message).toContain(gatewayError);
    }
  });

  it('still settling after the last retry: GASLESS_NOT_SERVED naming the relay tx, which may have paid', async () => {
    const pending = (): Response =>
      json({ ...invoice('42', { error: 'settlement_pending' }), transaction: RELAY_TX }, 402, { 'retry-after': '0' });
    const { impl } = queuedFetch([json(invoice('42'), 402), pending(), pending(), pending(), pending()]);
    const err = await gaslessClient(gaslessChain(), impl).fetchPaid(URL_1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GaslessNotServedError);
    expect(err).toMatchObject({ reason: 'settlement_pending', txHash: RELAY_TX, signedDelegate: DELEGATE });
    expect((err as Error).message).toContain(RELAY_TX);
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
