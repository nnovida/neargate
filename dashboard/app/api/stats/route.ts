import { NextResponse } from 'next/server';
import { parseMotes } from '@agentgate/shared';
import { getChain, toApiFailure } from '@/lib/server/chain';
import type { StatsResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const { chain } = getChain();
    const services = await chain.listServices();
    const scores = await Promise.all(services.map((s) => chain.getScore(s.id)));

    let totalCalls = 0;
    let successCalls = 0;
    let revenue = 0n; // motes, bigint — never float math on money
    services.forEach((service, i) => {
      const score = scores[i];
      if (!score) return;
      totalCalls += score.totalCalls;
      successCalls += score.successCalls;
      revenue += parseMotes(service.priceMotes) * BigInt(score.successCalls);
    });

    const body: StatsResponse = {
      network: chain.network,
      services: services.length,
      activeServices: services.filter((s) => s.active).length,
      totalCalls,
      successCalls,
      revenueMotes: revenue.toString(),
    };
    return NextResponse.json(body);
  } catch (err) {
    const { status, body } = toApiFailure(err, '/api/stats');
    return NextResponse.json(body, { status });
  }
}
