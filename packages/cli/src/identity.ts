import type { AnySigner } from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';
import { requireAccountId } from './validate';

/**
 * Account id of a signer. `wrap` uses it as the default payment target and
 * attestor. Mock and NEAR key signers both carry their account id.
 */
export function signerAccountId(signer: AnySigner): string {
  return requireAccountId(signer.accountId, 'signer.accountId');
}

/**
 * Signs `message` with the seller's NEAR key for the gateway's owner-signature
 * self-map auth (D4). Returns the NEAR public key (`ed25519:…`) and the base64
 * ed25519 signature. Only NEAR key signers can sign — mock mode uses the
 * admin-token path.
 *
 * TODO(Task 5): sign via `loadNearSigner` from @agentgate/chain (near-keys.ts, R3):
 * key order secretKey → keyPath → ~/.near-credentials/<network>/<accountId>.json,
 * warning on a group/other-readable key file (as the baseline key loader did).
 */
export async function signMessage(
  signer: AnySigner,
  _message: Uint8Array,
): Promise<{ publicKey: string; signature: string }> {
  if (signer.kind !== 'near') {
    throw new AgentGateError(
      'SIGNER_UNSUPPORTED',
      'self-service gateway mapping needs a NEAR key signer (live mode) — pass --key-file <path>',
      400,
    );
  }
  throw new AgentGateError('NOT_IMPLEMENTED', 'NEAR self-map signing lands in Task 5', 501);
}
