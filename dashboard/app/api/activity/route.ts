import { NextRequest, NextResponse } from 'next/server';
import { getChain, parseLimit, toApiFailure } from '@/lib/server/chain';
import type { ActivityResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 50, 200);
  try {
    const { chain } = getChain();
    const events = await chain.listRecentActivity(limit);
    const body: ActivityResponse = { network: chain.network, events };
    return NextResponse.json(body);
  } catch (err) {
    const { status, body } = toApiFailure(err, '/api/activity');
    return NextResponse.json(body, { status });
  }
}
