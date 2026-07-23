import { NextResponse } from 'next/server';
import { facilitatorConfigFromAccepts, trustTier } from '@agentgate/shared';
import { getChain, toApiFailure } from '@/lib/server/chain';
import type { ServicesResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET(): Promise<NextResponse> {
  try {
    const { chain, config } = getChain();
    const services = await chain.listServices();
    const entries = await Promise.all(
      services.map(async (service) => {
        const score = await chain.getScore(service.id);
        // Facilitator rail: env override first, else derived from on-chain accepts[].
        const fac = config.facilitatorServices[service.id] ?? facilitatorConfigFromAccepts(service.accepts);
        return {
          service,
          score,
          trustTier: trustTier(score),
          ...(fac
            ? { facilitator: { amount: fac.amount, symbol: fac.token.symbol, decimals: fac.token.decimals } }
            : {}),
        };
      }),
    );
    const body: ServicesResponse = { network: chain.network, services: entries };
    return NextResponse.json(body);
  } catch (err) {
    const { status, body } = toApiFailure(err, '/api/services');
    return NextResponse.json(body, { status });
  }
}
