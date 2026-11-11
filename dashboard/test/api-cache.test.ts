/**
 * The dashboard's /api routes behind their server TTL cache, with the chain layer mocked: no
 * devnet, no NEAR RPC, no network. Each test imports the routes fresh (vi.resetModules), so every
 * route starts with an empty cache, and moves only Date forward to age the entries.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceRecord } from '@agentgate/shared';
import type {
  ActivityResponse,
  ServiceDetailResponse,
  ServicesResponse,
  StatsResponse,
} from '@/lib/api-types';

const chainMock = vi.hoisted(() => ({
  chain: {
    network: 'near-testnet',
    listServices: vi.fn(),
    getScore: vi.fn(),
    getService: vi.fn(),
    listAttestations: vi.fn(),
    listRecentActivity: vi.fn(),
    getBalance: vi.fn(),
  },
  config: { mode: 'live', nearExplorerUrl: 'https://testnet.nearblocks.io' },
}));

// Everything in the chain module stays real (toApiFailure, the id and limit parsers) except the
// handle to the chain itself.
vi.mock('@/lib/server/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/chain')>()),
  getChain: () => chainMock,
}));

const PRICE_YOCTO = '500000000000000000000000'; // 0.5 NEAR
const SERVICES_TTL_MS = 15_000;
const ACTIVITY_TTL_MS = 30_000;

const service: ServiceRecord = {
  id: 1,
  name: 'USD rates',
  description: 'USD exchange rates',
  endpointUrl: 'https://gateway.example/svc/1',
  priceYocto: PRICE_YOCTO,
  paymentTarget: 'seller.testnet',
  owner: 'seller.testnet',
  attestor: 'gateway.testnet',
  active: true,
  createdAt: 1_700_000_000_000,
  accepts: [{ asset: 'near', amount: PRICE_YOCTO, decimals: 24, symbol: 'NEAR' }],
};

const rpcDown = (): Error => new Error('the NEAR RPC was unreachable');

function resetChain(): void {
  const { chain } = chainMock;
  chain.listServices.mockReset().mockResolvedValue([service]);
  chain.getScore.mockReset().mockResolvedValue({ totalCalls: 2, successCalls: 1 });
  chain.getService.mockReset().mockResolvedValue(service);
  chain.listAttestations.mockReset().mockResolvedValue([]);
  chain.listRecentActivity.mockReset().mockResolvedValue([]);
  chain.getBalance.mockReset().mockResolvedValue('0');
}

function age(ms: number): void {
  vi.advanceTimersByTime(ms);
}

async function detailGet(id: string): Promise<Response> {
  const { GET } = await import('@/app/api/services/[id]/route');
  return GET(new Request(`http://localhost/api/services/${id}`), { params: Promise.resolve({ id }) });
}

async function activityGet(query = ''): Promise<Response> {
  const { GET } = await import('@/app/api/activity/route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest(`http://localhost/api/activity${query}`));
}

describe('dashboard /api routes: server TTL cache', () => {
  const savedLogLevel = process.env['LOG_LEVEL'];

  beforeAll(() => {
    process.env['LOG_LEVEL'] = 'error'; // keep the expected "chain unreachable" warnings out of the output
  });

  afterAll(() => {
    if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
    else process.env['LOG_LEVEL'] = savedLogLevel;
  });

  beforeEach(() => {
    vi.resetModules();
    resetChain();
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('/api/services', () => {
    it('loads once per 15 s window: miss, then hit, then a reload', async () => {
      const { GET } = await import('@/app/api/services/route');

      const first = await GET();
      expect(first.status).toBe(200);
      expect(first.headers.get('x-cache')).toBe('miss');
      const body = (await first.json()) as ServicesResponse;
      expect(body.services[0]?.score).toEqual({ totalCalls: 2, successCalls: 1 });

      age(SERVICES_TTL_MS - 1);
      const second = await GET();
      expect(second.headers.get('x-cache')).toBe('hit');
      expect(await second.json()).toEqual(body);
      expect(chainMock.chain.listServices).toHaveBeenCalledTimes(1);

      age(2);
      expect((await GET()).headers.get('x-cache')).toBe('miss');
      expect(chainMock.chain.listServices).toHaveBeenCalledTimes(2);
    });

    it('serves the last good body as stale when the refresh fails', async () => {
      const { GET } = await import('@/app/api/services/route');
      const good = (await (await GET()).json()) as ServicesResponse;

      age(SERVICES_TTL_MS + 1);
      chainMock.chain.listServices.mockRejectedValue(rpcDown());
      const res = await GET();

      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('stale');
      expect(await res.json()).toEqual({ ...good, stale: true });
    });

    it('answers a failure with nothing cached as the usual 503, and caches nothing', async () => {
      const { GET } = await import('@/app/api/services/route');
      chainMock.chain.listServices.mockRejectedValueOnce(rpcDown());

      const failed = await GET();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: 'chain_unreachable' });
      expect(failed.headers.get('x-cache')).toBeNull();

      const recovered = await GET();
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get('x-cache')).toBe('miss');
    });
  });

  describe('/api/stats', () => {
    it('loads once per 15 s window and sums revenue = price x successful calls', async () => {
      const { GET } = await import('@/app/api/stats/route');

      const first = await GET();
      expect(first.headers.get('x-cache')).toBe('miss');
      expect(await first.json()).toMatchObject({
        network: 'near-testnet',
        services: 1,
        totalCalls: 2,
        successCalls: 1,
        revenueYocto: PRICE_YOCTO,
      });

      age(SERVICES_TTL_MS - 1);
      expect((await GET()).headers.get('x-cache')).toBe('hit');
      expect(chainMock.chain.listServices).toHaveBeenCalledTimes(1);
    });

    it('serves the last good body as stale when the refresh fails', async () => {
      const { GET } = await import('@/app/api/stats/route');
      const good = (await (await GET()).json()) as StatsResponse;

      age(SERVICES_TTL_MS + 1);
      chainMock.chain.getScore.mockRejectedValue(rpcDown());
      const res = await GET();

      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('stale');
      expect(await res.json()).toEqual({ ...good, stale: true });
    });

    it('answers a failure with nothing cached as the usual 503', async () => {
      const { GET } = await import('@/app/api/stats/route');
      chainMock.chain.listServices.mockRejectedValue(rpcDown());

      const res = await GET();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain_unreachable' });
    });
  });

  describe('/api/services/[id]', () => {
    it('caches per validated id for 15 s', async () => {
      const first = await detailGet('1');
      expect(first.status).toBe(200);
      expect(first.headers.get('x-cache')).toBe('miss');
      const body = (await first.json()) as ServiceDetailResponse;
      expect(body.revenueYocto).toBe(PRICE_YOCTO);

      age(SERVICES_TTL_MS - 1);
      const again = await detailGet('1');
      expect(again.headers.get('x-cache')).toBe('hit');
      expect(await again.json()).toEqual(body);
      expect(chainMock.chain.getService).toHaveBeenCalledTimes(1);

      chainMock.chain.getService.mockResolvedValue({ ...service, id: 2 });
      expect((await detailGet('2')).headers.get('x-cache')).toBe('miss');
      expect(chainMock.chain.getService).toHaveBeenCalledTimes(2);
    });

    it('serves the last good body as stale when the refresh fails', async () => {
      const good = (await (await detailGet('1')).json()) as ServiceDetailResponse;

      age(SERVICES_TTL_MS + 1);
      chainMock.chain.getService.mockRejectedValue(rpcDown());
      const res = await detailGet('1');

      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('stale');
      expect(await res.json()).toEqual({ ...good, stale: true });
    });

    it('never caches a not-found id: it stays a 404 and leaves the cache empty', async () => {
      chainMock.chain.getService.mockResolvedValue(null);

      for (const attempt of [1, 2]) {
        const res = await detailGet('99');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'not_found' });
        expect(res.headers.get('x-cache')).toBeNull();
        expect(chainMock.chain.getService).toHaveBeenCalledTimes(attempt); // asked the chain every time
      }

      // The id appears on chain: the next request loads it fresh, not from a cached 404.
      chainMock.chain.getService.mockResolvedValue({ ...service, id: 99 });
      const found = await detailGet('99');
      expect(found.status).toBe(200);
      expect(found.headers.get('x-cache')).toBe('miss');
    });

    it('rejects a malformed id with 400 before it touches the chain or the cache', async () => {
      for (const raw of ['abc', '1.5', '-1', '0x10', '1234567890123456']) {
        const res = await detailGet(raw);
        expect(res.status, raw).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_id' });
      }
      expect(chainMock.chain.getService).not.toHaveBeenCalled();
    });

    it('answers a failure with nothing cached as the usual 503', async () => {
      chainMock.chain.getService.mockRejectedValue(rpcDown());

      const res = await detailGet('1');

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain_unreachable' });
    });
  });

  describe('/api/activity', () => {
    it('keeps its 30 s window and caches per limit', async () => {
      const first = await activityGet('?limit=10');
      expect(first.headers.get('x-cache')).toBe('miss');

      age(ACTIVITY_TTL_MS - 1);
      expect((await activityGet('?limit=10')).headers.get('x-cache')).toBe('hit');
      expect(chainMock.chain.listRecentActivity).toHaveBeenCalledTimes(1);
      expect(chainMock.chain.listRecentActivity).toHaveBeenCalledWith(10);

      expect((await activityGet('?limit=20')).headers.get('x-cache')).toBe('miss');
      expect(chainMock.chain.listRecentActivity).toHaveBeenLastCalledWith(20);

      age(2);
      expect((await activityGet('?limit=10')).headers.get('x-cache')).toBe('miss');
    });

    it('keeps its limit handling: 50 by default, at most 200, a malformed limit falls back to 50', async () => {
      await activityGet();
      await activityGet('?limit=9999');
      age(ACTIVITY_TTL_MS + 1); // expire both, so the malformed limit below loads again
      await activityGet('?limit=abc');

      expect(chainMock.chain.listRecentActivity.mock.calls).toEqual([[50], [200], [50]]);
    });

    it('serves the last good feed as stale when the refresh fails', async () => {
      const good = (await (await activityGet('?limit=10')).json()) as ActivityResponse;

      age(ACTIVITY_TTL_MS + 1);
      chainMock.chain.listRecentActivity.mockRejectedValue(rpcDown());
      const res = await activityGet('?limit=10');

      expect(res.status).toBe(200);
      expect(res.headers.get('x-cache')).toBe('stale');
      expect(await res.json()).toEqual({ ...good, stale: true });
    });

    it('answers a failure with nothing cached as the usual 503', async () => {
      chainMock.chain.listRecentActivity.mockRejectedValue(rpcDown());

      const res = await activityGet();

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain_unreachable' });
    });
  });
});
