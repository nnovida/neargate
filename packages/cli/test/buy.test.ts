import { describe, expect, it } from 'vitest';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  ServiceRecord,
  ServiceScore,
  Yocto,
} from '@agentgate/shared';
import { encodeXPaymentResponse, nativeNearOption } from '@agentgate/shared';
import { buyService, formatBuyBody, formatBuyReceipt } from '../src/buy';

type PayInput = { serviceId: number; nonce: string; depositYocto: Yocto };

// ---------------------------------------------------------------------------
// fakes — mirror cli.test.ts, plus pay capture for the payment leg
// ---------------------------------------------------------------------------

/** A base58 string of NEAR tx-hash length. */
const TX = (c: string): string => c.repeat(44);
const BUYER: AnySigner = { kind: 'mock', accountId: 'buyer.mock' };
const REGISTRY = 'registry.mock';
const SELLER = 'seller.mock';
const PAYMENT_TX = TX('D');
const NONCE = '778899';
const PRICE = '500000000000000000000000'; // 0.5 NEAR
const STORAGE_FEE = '2000000000000000000000'; // 0.002 NEAR
const MAX_AMOUNT = '502000000000000000000000'; // price + storage fee
const SIGNED_DELEGATE = Buffer.from('a signed NEP-366 delegate').toString('base64');
/** The relay tx the gateway names: a real 32-byte base58 hash (the client keeps no other kind). */
const RELAY_TX = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';
const RELAYER = 'gateway.mock';

interface FakeChain extends ChainClient {
  payments: Array<{ input: PayInput; signer: AnySigner }>;
  /** `payFromEscrow` calls, in order. */
  escrowPayments: Array<{ input: { serviceId: number; nonce: string }; signer: AnySigner }>;
  /** What `escrowOf` answers (default: a full 1 NEAR). */
  escrow: Yocto;
  /** Accounts `escrowOf` was asked about, in order. */
  escrowReads: string[];
  /** `signPayDelegate` calls, in order (the gasless rail). */
  delegates: Array<{ input: { serviceId: number; nonce: string }; signer: AnySigner }>;
}

function makeService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id,
    name: `svc-${id}`,
    description: 'a service',
    endpointUrl: `http://gw.example:4021/svc/${id}`,
    priceYocto: PRICE,
    paymentTarget: SELLER,
    owner: 'owner.mock',
    attestor: 'owner.mock',
    active: true,
    createdAt: 1_700_000_000_000,
    accepts: [nativeNearOption(PRICE)],
    ...over,
  };
}

function makeFakeChain(service: ServiceRecord | null): FakeChain {
  const payments: FakeChain['payments'] = [];
  const escrowPayments: FakeChain['escrowPayments'] = [];
  return {
    network: 'near-mock',
    registryId: REGISTRY,
    payments,
    escrowPayments,
    escrow: '1000000000000000000000000',
    escrowReads: [],
    delegates: [],
    async blockHeight() {
      return 1_000;
    },
    async accessKey() {
      return { nonce: 41n, permission: 'FullAccess' as const };
    },
    async signPayDelegate(input, signer) {
      this.delegates.push({ input, signer });
      return SIGNED_DELEGATE;
    },
    async relayPay() {
      throw new Error('the buyer never relays');
    },
    async escrowOf(accountId) {
      this.escrowReads.push(accountId);
      return this.escrow;
    },
    async depositEscrow() {
      throw new Error('not used');
    },
    async withdrawEscrow() {
      throw new Error('not used');
    },
    async payFromEscrow(input, signer) {
      escrowPayments.push({ input, signer });
      return { txHash: PAYMENT_TX };
    },
    async getService(id) {
      return service !== null && id === service.id ? service : null;
    },
    async listServices() {
      return service === null ? [] : [service];
    },
    async getScore(): Promise<ServiceScore> {
      return { totalCalls: 0, successCalls: 0 };
    },
    async listAttestations(): Promise<AttestationRecord[]> {
      return [];
    },
    async listRecentActivity() {
      return [];
    },
    async getBalance() {
      return '0';
    },
    async getPayment() {
      return null;
    },
    async verifyPayment() {
      return { ok: false, reason: 'not_found' } as const;
    },
    async isFullAccessKey() {
      return false;
    },
    async accountExists() {
      return true;
    },
    async registerService() {
      throw new Error('not used');
    },
    async pay(input, signer) {
      payments.push({ input, signer });
      return { txHash: PAYMENT_TX };
    },
    async recordAttestation() {
      return { txHash: TX('B') };
    },
    async setActive() {
      return { txHash: TX('C') };
    },
  };
}

/** A strictly valid 402 PaymentRequiredResponse for the mock network (`over`/`extraOver` patch the entry). */
function invoice402(over: Record<string, unknown> = {}, extraOver: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [
        {
          scheme: 'exact',
          network: 'near-mock',
          maxAmountRequired: MAX_AMOUNT,
          asset: 'NEAR',
          payTo: REGISTRY,
          resource: 'http://gw.example:4021/svc/1',
          description: 'svc-1',
          maxTimeoutSeconds: 300,
          extra: {
            nonce: NONCE,
            serviceId: 1,
            expiresAtMs: Date.now() + 300_000,
            settlement: 'neargate-registry-pay',
            contractId: REGISTRY,
            method: 'pay',
            priceYocto: PRICE,
            storageFeeYocto: STORAGE_FEE,
            seller: SELLER,
            caip2: 'near:mock',
            ...extraOver,
          },
          ...over,
        },
      ],
    },
    { status: 402 },
  );
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** 402 on the first (proof-less) request, `paidResponse` once X-PAYMENT is present. */
function gatewayFetch(paidResponse: () => Response): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const hasProof = new Headers(init?.headers).has('X-PAYMENT');
    return hasProof ? paidResponse() : invoice402();
  }) as typeof fetch;
  return { impl, calls };
}

function baseOpts(chain: FakeChain, fetchImpl: typeof fetch) {
  return { chain, signer: BUYER, id: 1, fetchImpl, settleDelayMs: 0 };
}

// ---------------------------------------------------------------------------
// buyService
// ---------------------------------------------------------------------------

describe('buyService', () => {
  it('pays the 402 invoice and returns the paid response with the payment hash', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({ rate: 16250 }));

    const { service, url, result } = await buyService(baseOpts(chain, impl));

    expect(service.id).toBe(1);
    expect(url).toBe('http://gw.example:4021/svc/1');
    expect(result.paid).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ rate: 16250 });
    expect(result.txHash).toBe(PAYMENT_TX);
    expect(result.priceYocto).toBe(PRICE);
    expect(result.depositYocto).toBe(MAX_AMOUNT);

    // exactly one registry `pay`: the invoice's service + nonce, price + storage fee attached
    expect(chain.payments).toEqual([
      {
        input: { serviceId: 1, nonce: NONCE, depositYocto: MAX_AMOUNT },
        signer: BUYER,
      },
    ]);

    // two requests to the same URL: bare, then with the X-PAYMENT proof
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('http://gw.example:4021/svc/1');
    expect(new Headers(calls[1]!.init?.headers).has('X-PAYMENT')).toBe(true);
  });

  it('keeps the private-host guard on a live chain; rejectPrivateHosts: false lifts it for that one call', async () => {
    const live = {
      ...makeFakeChain(makeService(1, { endpointUrl: 'http://127.0.0.1:4021/svc/1' })),
      network: 'near-testnet',
    } as FakeChain;
    let asked = 0;
    const impl = (async () => {
      asked += 1;
      return Response.json({ free: true });
    }) as typeof fetch;

    await expect(buyService(baseOpts(live, impl))).rejects.toMatchObject({ code: 'FORBIDDEN_HOST' });
    expect(asked).toBe(0); // refused before any request

    const { result } = await buyService({ ...baseOpts(live, impl), rejectPrivateHosts: false });
    expect(asked).toBe(1);
    expect(result).toMatchObject({ status: 200, paid: false });
  });

  it('--max caps the total spend: price + storage fee above it is refused before any HTTP', async () => {
    const chain = makeFakeChain(makeService(1)); // 0.5 NEAR + 0.002 NEAR storage
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    // A cap equal to the bare price is not enough: the buyer attaches 0.502 NEAR.
    const err = await buyService({ ...baseOpts(chain, impl), maxNear: '0.5' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AgentGateError', code: 'BUDGET_EXCEEDED' });
    expect((err as Error).message).toContain('0.5 NEAR + 0.002 NEAR storage');

    expect(chain.payments).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('--max equal to price + storage fee pays', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl } = gatewayFetch(() => Response.json({ ok: true }));
    const { result } = await buyService({ ...baseOpts(chain, impl), maxNear: '0.502' });
    expect(result.paid).toBe(true);
    expect(chain.payments[0]!.input.depositYocto).toBe(MAX_AMOUNT);
  });

  it('caps the invoice too: a 402 asking more than --max is refused after the 402, unpaid', async () => {
    // on-chain price fits the cap, but the gateway invoice demands more
    const chain = makeFakeChain(makeService(1, { priceYocto: '400000000000000000000000' }));
    const calls: FetchCall[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return invoice402({ maxAmountRequired: '900000000000000000000000' }, { priceYocto: '898000000000000000000000' });
    }) as typeof fetch;

    await expect(
      buyService({ ...baseOpts(chain, impl), maxNear: '0.5' }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });

    expect(chain.payments).toHaveLength(0); // never paid
    expect(calls).toHaveLength(1); // only the bare 402 request
  });

  it('passes a non-402 first response through unpaid, without paying', async () => {
    const chain = makeFakeChain(makeService(1));
    const impl = (async () => Response.json({ free: true })) as typeof fetch;

    const { result } = await buyService(baseOpts(chain, impl));

    expect(result).toMatchObject({ status: 200, paid: false, body: { free: true } });
    expect(chain.payments).toHaveLength(0);
  });

  it('uses the --gateway override instead of the on-chain endpoint', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    const { url } = await buyService({
      ...baseOpts(chain, impl),
      gateway: 'https://gateway.example/', // trailing slash on purpose
    });

    expect(url).toBe('https://gateway.example/svc/1');
    expect(calls[0]!.url).toBe('https://gateway.example/svc/1');
  });

  it('sends --method and a JSON --body on both legs of the exchange', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({ ok: true }));

    await buyService({
      ...baseOpts(chain, impl),
      method: 'post',
      body: '{"q":"gold"}',
    });

    for (const call of calls) {
      expect(call.init?.method).toBe('POST');
      expect(call.init?.body).toBe('{"q":"gold"}');
      expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    }
  });

  it('rejects a non-JSON --body up front with INVALID_INPUT', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    await expect(
      buyService({ ...baseOpts(chain, impl), body: 'not json' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
    expect(chain.payments).toHaveLength(0);
  });

  it('rejects unknown services with SERVICE_NOT_FOUND', async () => {
    const chain = makeFakeChain(null);
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    await expect(buyService(baseOpts(chain, impl))).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
      httpStatus: 404,
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses paused services with SERVICE_INACTIVE before any HTTP', async () => {
    const chain = makeFakeChain(makeService(1, { active: false }));
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    await expect(buyService(baseOpts(chain, impl))).rejects.toMatchObject({
      code: 'SERVICE_INACTIVE',
      httpStatus: 403,
    });
    expect(calls).toHaveLength(0);
    expect(chain.payments).toHaveLength(0);
  });

  it('rejects invalid ids with INVALID_SERVICE_ID without touching anything', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(buyService({ ...baseOpts(chain, impl), id })).rejects.toMatchObject({
        code: 'INVALID_SERVICE_ID',
        httpStatus: 400,
      });
    }
    expect(calls).toHaveLength(0);
    expect(chain.payments).toHaveLength(0);
  });
});

describe('buyService --from-escrow', () => {
  it('pays out of the escrow: payFromEscrow once, `pay` never, the same price + storage reported', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({ rate: 16250 }));

    const bought = await buyService({ ...baseOpts(chain, impl), fromEscrow: true });

    expect(bought.result).toMatchObject({ paid: true, status: 200, payFrom: 'escrow', txHash: PAYMENT_TX, priceYocto: PRICE, depositYocto: MAX_AMOUNT });
    expect(chain.escrowPayments).toEqual([{ input: { serviceId: 1, nonce: NONCE }, signer: BUYER }]);
    expect(chain.payments).toEqual([]);
    expect(new Headers(calls[1]!.init?.headers).has('X-PAYMENT')).toBe(true);
  });

  it('without the flag the deposit rail pays and the escrow is not spent', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl } = gatewayFetch(() => Response.json({}));
    const bought = await buyService(baseOpts(chain, impl));
    expect(bought.result.payFrom).toBe('deposit');
    expect(chain.payments).toHaveLength(1);
    expect(chain.escrowPayments).toEqual([]);
  });

  it('an escrow below price + fee refuses with ERR_ESCROW_INSUFFICIENT and sends nothing', async () => {
    const chain = makeFakeChain(makeService(1));
    chain.escrow = (BigInt(MAX_AMOUNT) - 1n).toString();
    const { impl } = gatewayFetch(() => Response.json({}));
    await expect(buyService({ ...baseOpts(chain, impl), fromEscrow: true })).rejects.toMatchObject({ code: 'ERR_ESCROW_INSUFFICIENT' });
    expect(chain.escrowPayments).toEqual([]);
    expect(chain.payments).toEqual([]);
  });

  it('--max still caps the total (price + 0.002 NEAR), before the escrow is read', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = gatewayFetch(() => Response.json({}));
    await expect(buyService({ ...baseOpts(chain, impl), fromEscrow: true, maxNear: '0.5' })).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(calls).toHaveLength(0);
    expect(chain.escrowReads).toEqual([]); // refused before the escrow was even read
    const ok = await buyService({ ...baseOpts(chain, impl), fromEscrow: true, maxNear: '0.502' });
    expect(ok.result.paid).toBe(true);
    expect(chain.escrowReads).toEqual(['buyer.mock']); // the payer's own escrow, read once the budget passed
  });

  it('an invoice that understates the on-chain price is PRICE_MISMATCH and nothing is paid (the client checks the registry)', async () => {
    const chain = makeFakeChain(makeService(1, { priceYocto: '5000000000000000000000000' })); // on chain: 5 NEAR
    const { impl } = gatewayFetch(() => Response.json({})); // the invoice still says 0.502 NEAR in total
    await expect(buyService({ ...baseOpts(chain, impl), fromEscrow: true })).rejects.toMatchObject({ code: 'PRICE_MISMATCH' });
    expect(chain.escrowPayments).toEqual([]);
    expect(chain.escrowReads).toEqual([]);
  });

  it('the receipt says the escrow paid', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl } = gatewayFetch(() => Response.json({ rate: 16250 }));
    const bought = await buyService({ ...baseOpts(chain, impl), fromEscrow: true });
    expect(formatBuyReceipt(bought)).toEqual([
      'service:  #1 svc-1',
      'url:      http://gw.example:4021/svc/1',
      'paid:     0.5 NEAR + 0.002 NEAR storage',
      'from:     escrow (nothing attached; the escrow was debited)',
      `payment:  ${PAYMENT_TX}`,
      'status:   200',
    ]);
  });
});

describe('buyService --gasless', () => {
  /** The gateway offering the relay: 402 naming the relayer, then the body with the relay tx as settlement. */
  function relayingGateway(extraOver: Record<string, unknown> = { relayer: RELAYER, relayMethod: 'pay_from_escrow' }): {
    impl: typeof fetch;
    calls: FetchCall[];
  } {
    const calls: FetchCall[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (!new Headers(init?.headers).has('X-PAYMENT')) return invoice402({}, extraOver);
      return Response.json(
        { rate: 16250 },
        {
          headers: {
            'x-payment-response': encodeXPaymentResponse({ success: true, transaction: RELAY_TX, network: 'near-mock', payer: 'buyer.mock' }),
          },
        },
      );
    }) as typeof fetch;
    return { impl, calls };
  }

  it('implies --from-escrow: signs a pay_from_escrow delegate the gateway relays; nothing is sent from the account', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = relayingGateway();

    const bought = await buyService({ ...baseOpts(chain, impl), gasless: true });

    expect(bought.result).toMatchObject({
      paid: true,
      status: 200,
      gasless: true,
      relayer: RELAYER,
      payFrom: 'escrow',
      txHash: RELAY_TX,
      depositYocto: MAX_AMOUNT,
    });
    expect(chain.delegates).toEqual([{ input: { serviceId: 1, nonce: NONCE }, signer: BUYER }]);
    expect(chain.escrowReads).toEqual(['buyer.mock']); // the escrow pre-check ran first
    expect(chain.payments).toEqual([]);
    expect(chain.escrowPayments).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('the receipt says the escrow paid and the gateway relayed it, paying the gas', async () => {
    const chain = makeFakeChain(makeService(1));
    const bought = await buyService({ ...baseOpts(chain, relayingGateway().impl), gasless: true });
    expect(formatBuyReceipt(bought)).toEqual([
      'service:  #1 svc-1',
      'url:      http://gw.example:4021/svc/1',
      'paid:     0.5 NEAR + 0.002 NEAR storage',
      'from:     escrow (nothing attached; the escrow was debited)',
      `relayed:  gasless — ${RELAYER} relayed the signed pay_from_escrow and paid the gas`,
      `payment:  ${RELAY_TX}`,
      `settled:  ok  (payer buyer.mock)`,
      'status:   200',
    ]);
  });

  it('a gateway that offers no relay is RELAYER_UNAVAILABLE: nothing is signed or sent', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl, calls } = relayingGateway({});
    await expect(buyService({ ...baseOpts(chain, impl), gasless: true })).rejects.toMatchObject({ code: 'RELAYER_UNAVAILABLE' });
    expect(chain.delegates).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// neargate buy output: body → stdout, receipt → stderr
// ---------------------------------------------------------------------------

describe('formatBuyReceipt / formatBuyBody', () => {
  it('the receipt names the service, the price + storage, the payment tx and the status', async () => {
    const chain = makeFakeChain(makeService(1));
    const { impl } = gatewayFetch(() => Response.json({ rate: 16250 }));
    const bought = await buyService(baseOpts(chain, impl));

    expect(formatBuyReceipt(bought)).toEqual([
      'service:  #1 svc-1',
      'url:      http://gw.example:4021/svc/1',
      'paid:     0.5 NEAR + 0.002 NEAR storage',
      `payment:  ${PAYMENT_TX}`,
      'status:   200',
    ]);
    expect(formatBuyReceipt(bought, { explorerUrl: 'https://testnet.nearblocks.io' })).toContain(
      `explorer: https://testnet.nearblocks.io/txns/${PAYMENT_TX}`,
    );
    // the body is printed alone, pretty JSON
    expect(formatBuyBody(bought.result.body)).toBe(JSON.stringify({ rate: 16250 }, null, 2));
    expect(formatBuyBody('plain text')).toBe('plain text');
  });

  it('an unpaid passthrough says so', async () => {
    const chain = makeFakeChain(makeService(1));
    const impl = (async () => Response.json({ free: true })) as typeof fetch;
    const bought = await buyService(baseOpts(chain, impl));
    expect(formatBuyReceipt(bought)).toContain('paid:     no — the endpoint answered without requiring payment');
  });
});
