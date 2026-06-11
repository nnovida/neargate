import type { ChainClient, ServiceRecord, ServiceScore } from '@agentgate/shared';
import { trustTier, type TrustTier } from '@agentgate/shared';

export interface ServiceListing {
  service: ServiceRecord;
  score: ServiceScore;
  tier: TrustTier;
}

/**
 * Programmatic `agentgate list`: the on-chain catalog joined with scores and
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
