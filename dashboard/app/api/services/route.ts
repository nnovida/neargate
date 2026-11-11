import { NextResponse } from 'next/server';
import { trustTier } from '@agentgate/shared';
import { getChain, toApiFailure } from '@/lib/server/chain';
import { TtlCache } from '@/lib/server/ttl-cache';
import type { ServicesResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Short server-side cache: the catalog polls this route every 5 s and each miss is a `list_services`
 * view plus one `get_score` view per service on the NEAR RPC, which rate-limits public clients.
 * Every open tab shares one load per window, and the last good body is served (`stale: true`)
 * through a failed refresh.
 */
const CACHE_TTL_MS = 15_000;
const CACHE_KEY = 'all';
const cache = new TtlCache<ServicesResponse>(CACHE_TTL_MS);

async function loadServices(): Promise<ServicesResponse> {
  const { chain } = getChain();
  const services = await chain.listServices();
  const entries = await Promise.all(
    services.map(async (service) => {
      const score = await chain.getScore(service.id);
      return { service, score, trustTier: trustTier(score) };
    }),
  );
  return { network: chain.network, services: entries };
}

export async function GET(): Promise<NextResponse> {
  try {
    const { body, via } = await cache.load(CACHE_KEY, loadServices);
    return NextResponse.json(body, { headers: { 'x-cache': via } });
  } catch (err) {
    const latest = cache.peekLatest(CACHE_KEY);
    if (latest !== null) {
      return NextResponse.json({ ...latest, stale: true }, { headers: { 'x-cache': 'stale' } });
    }
    const { status, body } = toApiFailure(err, '/api/services');
    return NextResponse.json(body, { status });
  }
}
