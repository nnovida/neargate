import type { AnySigner, ChainClient, ServiceRecord } from '@agentgate/shared';
import { AgentGateError, isAgentGateError } from '@agentgate/shared';

export interface SetServiceActiveOpts {
  chain: ChainClient;
  signer: AnySigner;
  id: number;
  /** true = resume (set_active(true)), false = pause (set_active(false)). */
  active: boolean;
}

export interface SetServiceActiveResult {
  /** Hash of the on-chain `set_active` tx. */
  txHash: string;
  /** The service record re-fetched AFTER the toggle — `service.active` is the new state. */
  service: ServiceRecord;
}

/**
 * Programmatic `agentgate pause/resume <id>`: flips the on-chain active flag
 * via `set_active` (owner only), then re-fetches the record so callers can
 * report the new state. Throws AgentGateError('INVALID_SERVICE_ID', 400) for
 * bad ids and rewords the chain's 403 `not_authorized` into a clear
 * owner-only message; every other AgentGateError passes through unchanged.
 */
export async function setServiceActive(
  opts: SetServiceActiveOpts,
): Promise<SetServiceActiveResult> {
  const { chain, signer, id, active } = opts;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${String(id)}`,
      400,
    );
  }

  let txHash: string;
  try {
    ({ txHash } = await chain.setActive(id, active, signer));
  } catch (err) {
    if (isAgentGateError(err) && err.code === 'not_authorized') {
      throw new AgentGateError(
        'not_authorized',
        `only the service owner can pause/resume service ${id} — sign with the owner key (mock: MOCK_SELLER_ACCOUNT, live: SELLER_SIGNER_PEM_PATH)`,
        403,
      );
    }
    throw err;
  }

  const service = await chain.getService(id);
  if (service === null) {
    throw new AgentGateError(
      'SERVICE_NOT_FOUND',
      `service ${id} not found on-chain after set_active (tx ${txHash})`,
      404,
    );
  }
  return { txHash, service };
}
