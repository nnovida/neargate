import { NextRequest, NextResponse } from 'next/server';
import { getChain, parseLimit, toApiFailure } from '@/lib/server/chain';
import { TtlCache } from '@/lib/server/ttl-cache';
import type { ActivityResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

/**
 * Short server-side cache. The /activity page polls this route frequently and each miss is a
 * `get_recent_activity` view on the NEAR RPC, which rate-limits public clients, so without a cache
 * many open tabs quickly hit the limit. Caching per limit collapses all pollers to one upstream
 * fetch per TTL, and the last good response is served through a transient upstream failure (e.g. a
 * 429) so the feed degrades to "cached" instead of blank.
 */
const CACHE_TTL_MS = 30_000;
const cache = new TtlCache<ActivityResponse>(CACHE_TTL_MS);

async function loadActivity(limit: number): Promise<ActivityResponse> {
  const { chain, config } = getChain();
  const events = await chain.listRecentActivity(limit);
  return { network: chain.network, explorerUrl: config.nearExplorerUrl, events };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 50, 200);
  const key = String(limit);
  try {
    const { body, via } = await cache.load(key, () => loadActivity(limit));
    return NextResponse.json(body, { headers: { 'x-cache': via } });
  } catch (err) {
    // Serve the last good data through a transient upstream failure so the feed
    // shows "cached" rather than emptying out (RPC 429s, brief outages).
    const latest = cache.peekLatest(key);
    if (latest !== null) {
      return NextResponse.json({ ...latest, stale: true }, { headers: { 'x-cache': 'stale' } });
    }
    const { status, body } = toApiFailure(err, '/api/activity');
    return NextResponse.json(body, { status });
  }
}
