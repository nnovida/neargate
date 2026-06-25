import type { AttestationRecord, ChainClient, ServiceRecord, ServiceScore } from '@agentgate/shared';
import { AgentGateError, trustTier, type TrustTier } from '@agentgate/shared';

/** How many recent attestations `agentgate status` shows. */
export const STATUS_ATTESTATION_LIMIT = 10;

export interface ServiceStatusResult {
  service: ServiceRecord;
  score: ServiceScore;
  tier: TrustTier;
  /** Most recent attestations, newest first (up to STATUS_ATTESTATION_LIMIT). */
  attestations: AttestationRecord[];
}

/**
 * Programmatic `agentgate status <id>`: service record + score + trust tier +
 * recent attestations. Throws AgentGateError('SERVICE_NOT_FOUND', 404) for
 * unknown ids and AgentGateError('INVALID_SERVICE_ID', 400) for bad ids.
 * Service ids are 1-based, so 0 is rejected (matches pause/resume).
 */
export async function serviceStatus(opts: {
  chain: ChainClient;
  id: number;
}): Promise<ServiceStatusResult> {
  const { chain, id } = opts;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${String(id)}`,
      400,
    );
  }
  const service = await chain.getService(id);
  if (service === null) {
    throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found on-chain`, 404);
  }
  const [score, attestations] = await Promise.all([
    chain.getScore(id),
    chain.listAttestations(id, STATUS_ATTESTATION_LIMIT),
  ]);
  return { service, score, tier: trustTier(score), attestations };
}
