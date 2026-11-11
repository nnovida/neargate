import { NextResponse } from 'next/server';
import { parseYocto, trustTier, type Yocto } from '@agentgate/shared';
import { getChain, parseServiceId, toApiFailure } from '@/lib/server/chain';
import { TtlCache } from '@/lib/server/ttl-cache';
import type { ServiceDetailResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const ATTESTATION_LIMIT = 50;

/**
 * Short server-side cache, one entry per validated service id: the detail page polls this route
 * and each miss is several views on the NEAR RPC, which rate-limits public clients. Only a
 * successful body is cached (a not-found id is thrown out of the loader, so it is never stored),
 * and the last good body is served (`stale: true`) through a failed refresh.
 */
const CACHE_TTL_MS = 15_000;
const cache = new TtlCache<ServiceDetailResponse>(CACHE_TTL_MS);

class ServiceNotFoundError extends Error {}

async function loadDetail(id: number): Promise<ServiceDetailResponse> {
  const { chain, config } = getChain();
  const service = await chain.getService(id);
  if (service === null) throw new ServiceNotFoundError(`service ${id} is not registered`);
  const [score, attestations] = await Promise.all([
    chain.getScore(id),
    chain.listAttestations(id, ATTESTATION_LIMIT),
  ]);

  // Money math stays bigint-backed: revenue = price × successCalls.
  const revenueYocto: Yocto = (
    parseYocto(service.priceYocto) * BigInt(score.successCalls)
  ).toString();

  // Mock-mode extra: live wallet balance of the payment target.
  let balanceYocto: Yocto | null = null;
  if (config.mode === 'mock') {
    try {
      balanceYocto = await chain.getBalance(service.paymentTarget);
    } catch {
      balanceYocto = null; // balance is a bonus surface — never fail the page for it
    }
  }

  return {
    network: chain.network,
    explorerUrl: config.nearExplorerUrl,
    mode: config.mode,
    service,
    score,
    trustTier: trustTier(score),
    attestations,
    revenueYocto,
    balanceYocto,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseServiceId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  const key = String(id); // the parsed id, so "01" and "1" share one entry
  try {
    const { body, via } = await cache.load(key, () => loadDetail(id));
    return NextResponse.json(body, { headers: { 'x-cache': via } });
  } catch (err) {
    if (err instanceof ServiceNotFoundError) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const latest = cache.peekLatest(key);
    if (latest !== null) {
      return NextResponse.json({ ...latest, stale: true }, { headers: { 'x-cache': 'stale' } });
    }
    const { status, body } = toApiFailure(err, `/api/services/${rawId}`);
    return NextResponse.json(body, { status });
  }
}
