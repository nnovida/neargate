import type { ChainClient, ServiceRecord, ServiceScore } from '@agentgate/shared';
import { trustTier, yoctoToNear, type TrustTier } from '@agentgate/shared';

export interface ServiceListing {
  service: ServiceRecord;
  score: ServiceScore;
  tier: TrustTier;
}

/**
 * Programmatic `neargate list`: the on-chain catalog joined with scores and
 * trust tiers, in the order the chain returns it.
 */
export async function listServices(opts: { chain: ChainClient }): Promise<ServiceListing[]> {
  const services = await opts.chain.listServices();
  return Promise.all(
    services.map(async (service) => {
      const score = await opts.chain.getScore(service.id);
      return { service, score, tier: trustTier(score) };
    }),
  );
}

/** Plain monospace table: pads every column to its widest cell, two spaces apart. */
function renderTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

/**
 * The `neargate list` table: `id  name  price(NEAR)  calls  tier  active`, where price is the
 * service price in NEAR (each call also attaches the 0.002 NEAR storage fee) and calls is
 * successful/total paid calls.
 */
export function formatServiceTable(listings: ServiceListing[]): string {
  const rows = listings.map(({ service, score, tier }) => [
    String(service.id),
    service.name,
    yoctoToNear(service.priceYocto),
    `${score.successCalls}/${score.totalCalls}`,
    tier,
    service.active ? 'yes' : 'no',
  ]);
  return renderTable(['id', 'name', 'price(NEAR)', 'calls', 'tier', 'active'], rows);
}
