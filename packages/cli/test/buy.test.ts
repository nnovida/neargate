import { describe, expect, it } from 'vitest';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  Motes,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { buyService } from '../src/buy';

type TransferInput = { to: string; amountMotes: Motes; transferId: string };

// ---------------------------------------------------------------------------
// fakes — mirror cli.test.ts, plus transfer capture for the payment leg
// ---------------------------------------------------------------------------

const HEX64 = (c: string): string => c.repeat(64);
const BUYER: AnySigner = { kind: 'mock', publicKey: `01${HEX64('b')}` };
const PAY_TO = `account-hash-${HEX64('1')}`;
const PAYMENT_TX = HEX64('d');
const NONCE = '778899';

interface FakeChain extends ChainClient {
  transfers: Array<{ input: TransferInput; signer: AnySigner }>;
}

function makeService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id,
    name: `svc-${id}`,
    description: 'a service',
    endpointUrl: `http://gw.example:4021/svc/${id}`,
    priceMotes: '500000000',
    paymentTarget: PAY_TO,
    owner: `01${HEX64('a')}`,
    attestor: `01${HEX64('a')}`,
    active: true,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function makeFakeChain(service: ServiceRecord | null): FakeChain {
  const transfers: FakeChain['transfers'] = [];
  return {
    network: 'mock',
    transfers,
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
    async verifyTransfer() {
      return { ok: false, reason: 'not_found' } as const;
    },
    async registerService() {
      throw new Error('not used');
    },
    async recordAttestation() {
      return { txHash: HEX64('b') };
    },
    async setActive() {
      return { txHash: HEX64('c') };
    },
    async transfer(input, signer) {
      transfers.push({ input, signer });
      return { deployHash: PAYMENT_TX };
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
          maxAmountRequired: '500000000',
          asset: 'CSPR',
          payTo: PAY_TO,
          resource: 'http://gw.example:4021/svc/1',
          description: 'svc-1',
          maxTimeoutSeconds: 300,
          extra: {
            nonce: NONCE,
            serviceId: 1,
            expiresAtMs: Date.now() + 300_000,
            settlement: 'casper-native-transfer',
            transferIdEncoding: 'u64-decimal',
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
    expect(result.deployHash).toBe(PAYMENT_TX);
    expect(result.priceMotes).toBe('500000000');

    // exactly one payment: invoice amount to the invoice payTo, nonce as transfer_id
    expect(chain.transfers).toEqual([
      {
        input: { to: PAY_TO, amountMotes: '500000000', transferId: NONCE },
        signer: BUYER,
      },
    ]);

    // two requests to the same URL: bare, then with the X-PAYMENT proof
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('http://gw.example:4021/svc/1');
    expect(new Headers(calls[1]!.init?.headers).has('X-PAYMENT')).toBe(true);
  });

  it('refuses to pay when the on-chain price exceeds --max, before any HTTP', async () => {
    const chain = makeFakeChain(makeService(1)); // 0.5 CSPR
    const { impl, calls } = gatewayFetch(() => Response.json({}));

    await expect(
      buyService({ ...baseOpts(chain, impl), maxCspr: '0.4' }),
    ).rejects.toMatchObject({ name: 'AgentGateError', code: 'PRICE_EXCEEDED' });

    expect(chain.transfers).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('caps the invoice too: a 402 priced above --max is refused after the 402, unpaid', async () => {
    // on-chain price fits the cap, but the gateway invoice demands more
    const chain = makeFakeChain(makeService(1, { priceMotes: '400000000' }));
    const calls: FetchCall[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return invoice402({ maxAmountRequired: '900000000' });
    }) as typeof fetch;

    await expect(
      buyService({ ...baseOpts(chain, impl), maxCspr: '0.5' }),
    ).rejects.toMatchObject({ code: 'PRICE_EXCEEDED' });

    expect(chain.transfers).toHaveLength(0); // never paid
    expect(calls).toHaveLength(1); // only the bare 402 request
  });

  it('passes a non-402 first response through unpaid, without transferring', async () => {
    const chain = makeFakeChain(makeService(1));
    const impl = (async () => Response.json({ free: true })) as typeof fetch;

    const { result } = await buyService(baseOpts(chain, impl));

    expect(result).toMatchObject({ status: 200, paid: false, body: { free: true } });
    expect(chain.transfers).toHaveLength(0);
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
    expect(chain.transfers).toHaveLength(0);
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
    expect(chain.transfers).toHaveLength(0);
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
    expect(chain.transfers).toHaveLength(0);
  });
});
