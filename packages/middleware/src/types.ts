import type { Invoice402 } from '@agentgate/shared';

/**
 * Machine-readable reason codes attached to 402 responses.
 * - invoice lifecycle: 'invoice_expired' | 'invoice_used' | 'unknown_nonce'
 * - verifyTransfer passthrough: 'not_found' | 'wrong_target' | 'amount_too_low'
 *   | 'wrong_transfer_id' | 'expired' | 'pending'
 */
export type PaywallErrorCode =
  | 'invoice_expired'
  | 'invoice_used'
  | 'unknown_nonce'
  | 'not_found'
  | 'wrong_target'
  | 'amount_too_low'
  | 'wrong_transfer_id'
  | 'expired'
  | 'pending';

/**
 * The JSON body of every 402 response: a (usually fresh) Invoice402,
 * plus an `error` reason when a previous proof/invoice was rejected and
 * `retry_after_ms` (2000) when the payment is still settling ('pending').
 */
export interface Invoice402Body extends Invoice402 {
  error?: PaywallErrorCode;
  retry_after_ms?: number;
}

/** Payment proof header names (case-insensitive on the wire). */
export const HEADER_PAYMENT_DEPLOY_HASH = 'x-payment-deploy-hash';
export const HEADER_PAYMENT_NONCE = 'x-payment-nonce';
/** Response headers set on every 402 challenge. */
export const HEADER_AGENTGATE_PRICE = 'X-AgentGate-Price';
export const HEADER_AGENTGATE_NONCE = 'X-AgentGate-Nonce';
