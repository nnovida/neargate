/**
 * Machine-readable reason codes attached to 402 responses.
 *
 * Two distinct categories — do NOT conflate them:
 *
 * 1. **Wire `error` strings** — surfaced verbatim in the PaymentRequiredResponse JSON body.
 *    These are the strings a client actually receives:
 *    'X-PAYMENT header is required' (literal string, not in this union),
 *    'invoice_expired', 'invoice_used', 'unknown_nonce', 'invalid_payment_header',
 *    'settlement_pending' (sent on wire for a pending transfer), and the
 *    verifyTransfer pass-throughs below.
 *
 * 2. **Internal `verifyTransfer` reason codes** — returned by `ChainClient.verifyTransfer`
 *    and mapped inside the handler before being sent on the wire.  The notable mismatch:
 *    `verifyTransfer` returns `'pending'` internally, but the wire label is `'settlement_pending'`.
 *
 * Wire codes: 'invoice_expired' | 'invoice_used' | 'unknown_nonce' | 'invalid_payment_header'
 *             | 'not_found' | 'wrong_target' | 'amount_too_low' | 'wrong_transfer_id' | 'expired'
 *             | 'settlement_pending'
 * Internal-only codes (never sent raw): 'pending'
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
