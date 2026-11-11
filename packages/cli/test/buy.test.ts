import { describe, expect, it } from 'vitest';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  ServiceRecord,
  ServiceScore,
  Yocto,
} from '@agentgate/shared';
import { nativeNearOption } from '@agentgate/shared';
import { buyService } from '../src/buy';

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

interface FakeChain extends ChainClient {
  payments: Array<{ input: PayInput; signer: AnySigner }>;
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
  return {
    network: 'mock',
    registryId: REGISTRY,
    payments,
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

/** A strictly valid 402 PaymentRequiredResponse for the mock network. */
function invoice402(over: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [
        {
          scheme: 'exact',
          network: 'mock',
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
    expect(result.priceYocto).toBe(MAX_AMOUNT);

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

  it('refuses to pay when the on-chain price exceeds --max, before any HTTP', async () => {
    const chain = makeFakeChain(makeService(1)); // 0.5 NEAR
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    await expect(
      buyService({ ...baseOpts(chain, impl), maxNear: '0.4' }),
    ).rejects.toMatchObject({ name: 'AgentGateError', code: 'PRICE_EXCEEDED' });

    expect(chain.payments).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('caps the invoice too: a 402 priced above --max is refused after the 402, unpaid', async () => {
    // on-chain price fits the cap, but the gateway invoice demands more
    const chain = makeFakeChain(makeService(1, { priceYocto: '400000000000000000000000' }));
    const calls: FetchCall[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return invoice402({ maxAmountRequired: '900000000000000000000000' });
    }) as typeof fetch;

    await expect(
      buyService({ ...baseOpts(chain, impl), maxNear: '0.5' }),
    ).rejects.toMatchObject({ code: 'PRICE_EXCEEDED' });

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
