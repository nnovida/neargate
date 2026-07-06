import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, loadConfig, type AgentGateConfig } from '@agentgate/shared';
import {
  startServer,
  type FeedResponse,
  type FetchLike,
  type RunningServer,
  type SinglePairResponse,
} from '../src/index';

const silentLogger = createLogger('oracle-test', { LOG_LEVEL: 'error' });

function cfg(overrides: Record<string, string> = {}): AgentGateConfig {
  return loadConfig({ ...overrides });
}

function jsonResponse(body: unknown): ReturnType<FetchLike> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** Fake fetch covering both SPEC sources, with per-URL call counting. */
function makeFakeFetch(opts: {
  erApiIdr?: number;
  erApiXau?: number; // XAU per USD (will be inverted by the oracle)
  currencyApiIdr?: number;
  currencyApiXau?: number; // XAU per USD
  failErApi?: boolean;
  failCurrencyApi?: boolean;
}): { fetchImpl: FetchLike; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const fetchImpl: FetchLike = (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    const host = new URL(url).hostname;
    if (host === 'open.er-api.com') {
      if (opts.failErApi) return Promise.reject(new Error('ECONNREFUSED'));
      const rates: Record<string, number> = {};
      if (opts.erApiIdr !== undefined) rates['IDR'] = opts.erApiIdr;
      if (opts.erApiXau !== undefined) rates['XAU'] = opts.erApiXau;
      return jsonResponse({ result: 'success', base_code: 'USD', rates });
    }
    if (host === 'cdn.jsdelivr.net') {
      if (opts.failCurrencyApi) return Promise.reject(new Error('ETIMEDOUT'));
      const usd: Record<string, number> = {};
      if (opts.currencyApiIdr !== undefined) usd['idr'] = opts.currencyApiIdr;
      if (opts.currencyApiXau !== undefined) usd['xau'] = opts.currencyApiXau;
      return jsonResponse({ date: '2026-06-12', usd });
    }
    return Promise.reject(new Error(`unexpected url: ${url}`));
  };
  return { fetchImpl, calls };
}

let server: RunningServer | null = null;

async function boot(opts: {
  staticMode?: boolean;
  fetchImpl?: FetchLike;
}): Promise<RunningServer> {
  server = await startServer({
    port: 0,
    config: cfg(opts.staticMode ? { ORACLE_STATIC: '1' } : {}),
    logger: silentLogger,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return server;
}

async function getJson<T>(port: number, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

afterEach(async () => {
  if (server !== null) {
    await server.close();
    server = null;
  }
});

describe('static fixture mode (ORACLE_STATIC=1)', () => {
  it('GET /feed serves the exact fixture shape and values without fetching', async () => {
    const { fetchImpl, calls } = makeFakeFetch({ erApiIdr: 1, currencyApiIdr: 1 });
    const { port } = await boot({ staticMode: true, fetchImpl });

    const { status, body } = await getJson<FeedResponse>(port, '/feed');
    expect(status).toBe(200);
    expect(body.pairs.usd_idr).toEqual({
      value: 16250.5,
      sources: [{ name: 'static-fixture', value: 16250.5 }],
      confidence: 0.97,
    });
    expect(body.pairs.xau_usd).toEqual({
      value: 3310.25,
      sources: [{ name: 'static-fixture', value: 3310.25 }],
      confidence: 0.97,
    });
    expect(body.attribution).toBe('static-fixture');
    expect(typeof body.asOf).toBe('number');
    expect(body.asOf).toBeGreaterThan(0);
    expect(calls.size).toBe(0); // static mode never touches the network
  });

  it('GET /feed/usd-idr and /feed/gold serve the fixture pair entries', async () => {
    const { port } = await boot({ staticMode: true });

    const idr = await getJson<SinglePairResponse>(port, '/feed/usd-idr');
    expect(idr.status).toBe(200);
    expect(idr.body.pair).toBe('usd_idr');
    expect(idr.body.value).toBe(16250.5);
    expect(idr.body.confidence).toBe(0.97);
    expect(idr.body.attribution).toBe('static-fixture');

    const gold = await getJson<SinglePairResponse>(port, '/feed/gold');
    expect(gold.status).toBe(200);
    expect(gold.body.pair).toBe('xau_usd');
    expect(gold.body.value).toBe(3310.25);
    expect(gold.body.sources).toEqual([{ name: 'static-fixture', value: 3310.25 }]);
  });

  it('GET /healthz reports ok', async () => {
    const { port } = await boot({ staticMode: true });
    const { status, body } = await getJson<{ ok: boolean }>(port, '/healthz');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

describe('confidence math (injected fake fetch)', () => {
  it('two sources agreeing exactly → confidence 1; single-source pair → 0.5', async () => {
    const { fetchImpl } = makeFakeFetch({
      erApiIdr: 16200,
      currencyApiIdr: 16200,
      currencyApiXau: 0.0003125, // → XAU/USD 3200, only one source
    });
    const { port } = await boot({ fetchImpl });

    const { status, body } = await getJson<FeedResponse>(port, '/feed');
    expect(status).toBe(200);

    expect(body.pairs.usd_idr.value).toBe(16200);
    expect(body.pairs.usd_idr.confidence).toBe(1);
    expect(body.pairs.usd_idr.sources).toEqual([
      { name: 'open.er-api.com', value: 16200 },
      { name: 'fawazahmed0/currency-api', value: 16200 },
    ]);

    expect(body.pairs.xau_usd.value).toBe(3200);
    expect(body.pairs.xau_usd.confidence).toBe(0.5);
    expect(body.pairs.xau_usd.sources).toEqual([
      { name: 'fawazahmed0/currency-api', value: 3200 },
    ]);

    expect(body.attribution).toBe('open.er-api.com, fawazahmed0/currency-api');
  });

  it('diverging sources → max(0, 1 - (maxDev/mean)*10) rounded to 2dp', async () => {
    // values 16000 & 16400 → mean 16200, maxDev 200 → 1 - (200/16200)*10 = 0.8765… → 0.88
    const { fetchImpl } = makeFakeFetch({ erApiIdr: 16000, currencyApiIdr: 16400 });
    const { port } = await boot({ fetchImpl });

    const { body } = await getJson<FeedResponse>(port, '/feed');
    expect(body.pairs.usd_idr.value).toBe(16200);
    expect(body.pairs.usd_idr.confidence).toBe(0.88);
  });

  it('wildly diverging sources floor at confidence 0', async () => {
    // values 10000 & 22400 → mean 16200, maxDev 6200 → 1 - (6200/16200)*10 < 0 → 0
    const { fetchImpl } = makeFakeFetch({ erApiIdr: 10000, currencyApiIdr: 22400 });
    const { port } = await boot({ fetchImpl });

    const { body } = await getJson<FeedResponse>(port, '/feed');
    expect(body.pairs.usd_idr.confidence).toBe(0);
  });
});

describe('best-effort fallback', () => {
  it('all sources down → 200 with the exact fixture and attribution "static-fixture"', async () => {
    const { fetchImpl } = makeFakeFetch({ failErApi: true, failCurrencyApi: true });
    const { port } = await boot({ fetchImpl });

    const { status, body } = await getJson<FeedResponse>(port, '/feed');
    expect(status).toBe(200);
    expect(body.pairs.usd_idr.value).toBe(16250.5);
    expect(body.pairs.xau_usd.value).toBe(3310.25);
    expect(body.pairs.usd_idr.confidence).toBe(0.97);
    expect(body.pairs.xau_usd.confidence).toBe(0.97);
    expect(body.attribution).toBe('static-fixture');
  });

  it('one source down → other source still served (single source → 0.5)', async () => {
    const { fetchImpl } = makeFakeFetch({
      erApiIdr: 16100,
      failCurrencyApi: true,
    });
    const { port } = await boot({ fetchImpl });

    const { status, body } = await getJson<FeedResponse>(port, '/feed');
    expect(status).toBe(200);
    expect(body.pairs.usd_idr.value).toBe(16100);
    expect(body.pairs.usd_idr.confidence).toBe(0.5);
    expect(body.pairs.usd_idr.sources).toEqual([{ name: 'open.er-api.com', value: 16100 }]);
    // gold has no live source → fixture fill, attribution records both
    expect(body.pairs.xau_usd.value).toBe(3310.25);
    expect(body.attribution).toBe('open.er-api.com, static-fixture');
  });
});

describe('60s cache', () => {
  it('second call within 60s does not re-fetch the sources', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      erApiIdr: 16200,
      currencyApiIdr: 16200,
      currencyApiXau: 0.0003125,
    });
    const { port } = await boot({ fetchImpl });

    const first = await getJson<FeedResponse>(port, '/feed');
    const second = await getJson<FeedResponse>(port, '/feed');
    const third = await getJson<SinglePairResponse>(port, '/feed/usd-idr');

    // each source fetched exactly once across all three requests
    expect([...calls.values()]).toEqual([1, 1]);
    expect(second.body).toEqual(first.body);
    expect(third.body.asOf).toBe(first.body.asOf);
  });
});
