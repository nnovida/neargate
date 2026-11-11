import { AgentGateError } from './errors';
import { isRecord } from './guards';
import { isValidNonce } from './nonce';
import { isNearTxHash } from './x402';

/**
 * What the gateway did about attesting one paid call, as `GET /receipts/:nonce` reports it:
 *
 * - `pending`: the call was served; the attestation is still being sent (or retried)
 * - `recorded`: the registry holds the attestation (`txHash` names the gateway's tx; absent
 *   when the registry already had it from another party, `ERR_ALREADY_ATTESTED`)
 * - `skipped_self_paid`: the payer is the service owner or payment target; never attested
 * - `skipped_upstream_failed`: the gateway could not reach the upstream; not scored either way
 * - `failed`: every attempt failed; a durable queue retries it on the next gateway boot
 */
export type ReceiptAttestationStatus =
  | 'pending'
  | 'recorded'
  | 'skipped_self_paid'
  | 'skipped_upstream_failed'
  | 'failed';

export const RECEIPT_ATTESTATION_STATUSES: readonly ReceiptAttestationStatus[] = [
  'pending',
  'recorded',
  'skipped_self_paid',
  'skipped_upstream_failed',
  'failed',
];

export interface ReceiptAttestation {
  status: ReceiptAttestationStatus;
  /** The attestation transaction, once the gateway's `record_attestation` answered with one. */
  txHash?: string;
}

/**
 * The gateway's record of one paid call, keyed by the invoice nonce. Everything in it is
 * already public on chain: the service, the payment's tx hash and the attestation's.
 */
export interface GatewayReceipt {
  nonce: string;
  serviceId: number;
  /** The `pay` transaction the buyer presented. */
  paymentTxHash: string;
  attestation: ReceiptAttestation;
}

function badReceipt(why: string): AgentGateError {
  return new AgentGateError('BAD_RECEIPT', `invalid gateway receipt: ${why}`, 502);
}

/**
 * Validates a receipt a gateway sent (untrusted JSON) and returns it with only the known
 * fields. Throws AgentGateError('BAD_RECEIPT') on any violation.
 */
export function parseGatewayReceipt(raw: unknown): GatewayReceipt {
  if (!isRecord(raw)) throw badReceipt('body is not a JSON object');
  const { nonce, serviceId, paymentTxHash, attestation } = raw;
  if (typeof nonce !== 'string' || !isValidNonce(nonce)) throw badReceipt('nonce must be 1-20 decimal digits');
  if (typeof serviceId !== 'number' || !Number.isSafeInteger(serviceId) || serviceId < 1) {
    throw badReceipt('serviceId must be a positive integer');
  }
  if (!isNearTxHash(paymentTxHash)) throw badReceipt('paymentTxHash must be a NEAR tx hash');
  if (!isRecord(attestation)) throw badReceipt('attestation must be an object');
  const { status, txHash } = attestation;
  if (typeof status !== 'string' || !RECEIPT_ATTESTATION_STATUSES.includes(status as ReceiptAttestationStatus)) {
    throw badReceipt(`attestation.status must be one of ${RECEIPT_ATTESTATION_STATUSES.join(', ')}`);
  }
  if (txHash !== undefined && !isNearTxHash(txHash)) {
    throw badReceipt('attestation.txHash must be a NEAR tx hash');
  }
  return {
    nonce,
    serviceId,
    paymentTxHash,
    attestation: {
      status: status as ReceiptAttestationStatus,
      ...(txHash !== undefined ? { txHash } : {}),
    },
  };
}
