import { NextResponse } from 'next/server';
import { parseYocto } from '@agentgate/shared';
import { getChain, toApiFailure } from '@/lib/server/chain';
import { TtlCache } from '@/lib/server/ttl-cache';
import type { StatsResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Short server-side cache: the stats strip polls this route and each miss is a `list_services` view
 * plus one `get_score` view per service on the NEAR RPC, which rate-limits public clients. Every
 * open tab shares one load per window, and the last good body is served (`stale: true`) through a
 * failed refresh.
 */
const CACHE_TTL_MS = 15_000;
const CACHE_KEY = 'all';
const cache = new TtlCache<StatsResponse>(CACHE_TTL_MS);

async function loadStats(): Promise<StatsResponse> {
  const { chain } = getChain();
  const services = await chain.listServices();
  const scores = await Promise.all(services.map((s) => chain.getScore(s.id)));

  let totalCalls = 0;
  let successCalls = 0;
  let revenue = 0n; // yocto, bigint — never float math on money
  services.forEach((service, i) => {
    const score = scores[i];
    if (!score) return;
    totalCalls += score.totalCalls;
    successCalls += score.successCalls;
    revenue += parseYocto(service.priceYocto) * BigInt(score.successCalls);
  });

  return {
    network: chain.network,
    services: services.length,
    activeServices: services.filter((s) => s.active).length,
    totalCalls,
    successCalls,
    revenueYocto: revenue.toString(),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const { body, via } = await cache.load(CACHE_KEY, loadStats);
    return NextResponse.json(body, { headers: { 'x-cache': via } });
  } catch (err) {
    const latest = cache.peekLatest(CACHE_KEY);
    if (latest !== null) {
      return NextResponse.json({ ...latest, stale: true }, { headers: { 'x-cache': 'stale' } });
    }
    const { status, body } = toApiFailure(err, '/api/stats');
    return NextResponse.json(body, { status });
  }
}
