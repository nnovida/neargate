import { NextResponse } from 'next/server';
import { facilitatorConfigFromAccepts, parseMotes, trustTier, type Motes } from '@agentgate/shared';
import { getChain, parseServiceId, toApiFailure } from '@/lib/server/chain';
import type { ServiceDetailResponse } from '@/lib/api-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

const ATTESTATION_LIMIT = 50;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawId } = await params;
  const id = parseServiceId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  try {
    const { chain, config } = getChain();
    const service = await chain.getService(id);
    if (service === null) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const [score, attestations] = await Promise.all([
      chain.getScore(id),
      chain.listAttestations(id, ATTESTATION_LIMIT),
    ]);

    // Money math stays bigint-backed: revenue = price × successCalls.
    const revenueMotes: Motes = (
      parseMotes(service.priceMotes) * BigInt(score.successCalls)
    ).toString();

    // Mock-mode extra: live wallet balance of the payment target.
    let balanceMotes: Motes | null = null;
    if (config.mode === 'mock') {
      try {
        balanceMotes = await chain.getBalance(service.paymentTarget);
      } catch {
        balanceMotes = null; // balance is a bonus surface — never fail the page for it
      }
    }

    // Facilitator rail: env override first, else derived from on-chain accepts[].
    const fac = config.facilitatorServices[id] ?? facilitatorConfigFromAccepts(service.accepts);
    const body: ServiceDetailResponse = {
      network: chain.network,
      mode: config.mode,
      service,
      score,
      trustTier: trustTier(score),
      attestations,
      revenueMotes,
      balanceMotes,
      ...(fac
        ? { facilitator: { amount: fac.amount, symbol: fac.token.symbol, decimals: fac.token.decimals } }
        : {}),
    };
    return NextResponse.json(body);
  } catch (err) {
    const { status, body } = toApiFailure(err, `/api/services/${rawId}`);
    return NextResponse.json(body, { status });
  }
}
