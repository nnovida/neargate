/**
 * Machine-readable reason codes attached to 402 responses.
 * - invoice lifecycle: 'invoice_expired' | 'invoice_used' | 'unknown_nonce' | 'invalid_payment_header'
 * - verifyTransfer passthrough: 'not_found' | 'wrong_target' | 'amount_too_low'
 *   | 'wrong_transfer_id' | 'expired' | 'pending'
 */
export type PaywallErrorCode =
  | 'invoice_expired'
  | 'invoice_used'
  | 'unknown_nonce'
  | 'invalid_payment_header'
  | 'not_found'
  | 'wrong_target'
  | 'amount_too_low'
  | 'wrong_transfer_id'
  | 'expired'
  | 'pending';

/** x402 proof header (request) + settlement header (response). Lowercase on the wire. */
export const HEADER_X_PAYMENT = 'x-payment';
export const HEADER_X_PAYMENT_RESPONSE = 'X-PAYMENT-RESPONSE';
