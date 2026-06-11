import { NextResponse } from 'next/server';
import { trustTier } from '@agentgate/shared';
import { getChain, toApiFailure } from '@/lib/server/chain';
import type { ServicesResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const { chain } = getChain();
    const services = await chain.listServices();
    const entries = await Promise.all(
      services.map(async (service) => {
        const score = await chain.getScore(service.id);
        return { service, score, trustTier: trustTier(score) };
      }),
    );
    const body: ServicesResponse = { network: chain.network, services: entries };
    return NextResponse.json(body);
  } catch (err) {
    const { status, body } = toApiFailure(err, '/api/services');
    return NextResponse.json(body, { status });
  }
}
