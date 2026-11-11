/**
 * The dashboard's /api routes against an in-process mock devnet (localhost only, port 0): the
 * same chain stack `npm run dev:seed` boots, called through the real route handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient } from '@agentgate/chain';
import { createDemoAccounts } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import {
  MOCK_NETWORK,
  isNearTxHash,
  loadConfig,
  nativeNearOption,
  type ActivityEvent,
  type Logger,
} from '@agentgate/shared';
import type {
  ActivityResponse,
  ServiceDetailResponse,
  ServicesResponse,
  StatsResponse,
} from '@/lib/api-types';

const PRICE_YOCTO = '500000000000000000000000'; // 0.5 NEAR
const STORAGE_FEE_YOCTO = '2000000000000000000000'; // 0.002 NEAR
const NONCE = '73920184556012';

function quietLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = { name: 'dash-test', level: 'error', debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

describe('dashboard /api routes (mock devnet)', () => {
  let close: () => Promise<void>;
  let paymentTx: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const devnet = await startDevnet({ port: 0, config: loadConfig({}), logger: quietLogger() });
    close = devnet.close;
    const devnetUrl = `http://127.0.0.1:${devnet.port}`;

    // The state `npm run dev:seed` leaves: one wrapped service, one paid + attested call.
    const accounts = await createDemoAccounts({ devnetUrl });
    const chain = new MockChainHttpClient(devnetUrl);
    const seller = { kind: 'mock', accountId: accounts.seller.accountId } as const;
    const buyer = { kind: 'mock', accountId: accounts.buyer.accountId } as const;
    // The mock registry plays the gateway's attestor: the seller registers itself as attestor.
    const { serviceId } = await chain.registerService(
      {
        name: 'RWA FX & Gold Oracle',
        description: 'USD/IDR rate and gold spot price feed',
        gatewayBaseUrl: 'http://localhost:4021',
        priceYocto: PRICE_YOCTO,
        paymentTarget: accounts.seller.accountId,
        attestor: accounts.seller.accountId,
      },
      seller,
    );
    expect(serviceId).toBe(1);
    expect(nativeNearOption(PRICE_YOCTO).symbol).toBe('NEAR');
    const paid = await chain.pay(
      { serviceId, nonce: NONCE, depositYocto: (BigInt(PRICE_YOCTO) + BigInt(STORAGE_FEE_YOCTO)).toString() },
      buyer,
    );
    paymentTx = paid.txHash;
    await chain.recordAttestation({ serviceId, nonce: NONCE, paymentTxHash: paid.txHash, success: true }, seller);

    for (const key of ['AGENTGATE_MODE', 'DEVNET_URL', 'NEAR_EXPLORER_URL']) savedEnv[key] = process.env[key];
    process.env['AGENTGATE_MODE'] = 'mock';
    process.env['DEVNET_URL'] = devnetUrl;
    delete process.env['NEAR_EXPLORER_URL'];
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await close();
  });

  it('/api/services lists the service with its NEAR price and its 1/1 score', async () => {
    const { GET } = await import('@/app/api/services/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServicesResponse;
    expect(body.network).toBe(MOCK_NETWORK);
    expect(body.services).toHaveLength(1);
    const entry = body.services[0];
    expect(entry?.service.priceYocto).toBe(PRICE_YOCTO);
    expect(entry?.score).toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('/api/services/1 carries the explorer base, the attestation, revenue = price × successes', async () => {
    const { GET } = await import('@/app/api/services/[id]/route');
    const res = await GET(new Request('http://localhost/api/services/1'), { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServiceDetailResponse;
    expect(body.network).toBe(MOCK_NETWORK);
    expect(body.explorerUrl).toBe('https://testnet.nearblocks.io');
    expect(body.revenueYocto).toBe(PRICE_YOCTO);
    expect(body.attestations).toHaveLength(1);
    expect(body.attestations[0]?.paymentTxHash).toBe(paymentTx);
    expect(body.score).toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('/api/services/<unknown> is a 404 and a malformed id a 400', async () => {
    const { GET } = await import('@/app/api/services/[id]/route');
    expect((await GET(new Request('http://x'), { params: Promise.resolve({ id: '99' }) })).status).toBe(404);
    expect((await GET(new Request('http://x'), { params: Promise.resolve({ id: 'abc' }) })).status).toBe(400);
  });

  it('/api/activity has the register, payment and attestation events with real tx hashes and the explorer base', async () => {
    const { GET } = await import('@/app/api/activity/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://localhost/api/activity?limit=50'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActivityResponse;
    expect(body.network).toBe(MOCK_NETWORK);
    expect(body.explorerUrl).toBe('https://testnet.nearblocks.io');
    const kinds = body.events.map((e: ActivityEvent) => e.kind).sort();
    expect(kinds).toEqual(['attestation', 'payment', 'service_registered']);
    for (const event of body.events) {
      expect(event.txHash !== null && isNearTxHash(event.txHash)).toBe(true);
    }
    const payment = body.events.find((e) => e.kind === 'payment');
    expect(payment?.txHash).toBe(paymentTx);
    expect(payment?.amountYocto).toBe(PRICE_YOCTO);
  });

  it('/api/stats sums NEAR revenue and calls', async () => {
    const { GET } = await import('@/app/api/stats/route');
    const body = (await (await GET()).json()) as StatsResponse;
    expect(body).toMatchObject({
      network: MOCK_NETWORK,
      services: 1,
      activeServices: 1,
      totalCalls: 1,
      successCalls: 1,
      revenueYocto: PRICE_YOCTO,
    });
  });
});
