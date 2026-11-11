/**
 * Machine-readable reason codes attached to 402 responses.
 *
 * Two distinct categories — do NOT conflate them:
 *
 * 1. **Wire `error` strings** — surfaced verbatim in the PaymentRequiredResponse JSON body.
 *    These are the strings a client actually receives:
 *    'X-PAYMENT header is required' (literal string, not in this union),
 *    'invoice_expired', 'invoice_used', 'unknown_nonce', 'invalid_payment_header',
 *    'relayer_disabled', 'settlement_pending' (sent on wire for a pending payment), and the
 *    verifyPayment pass-throughs below.
 *
 * 2. **Internal `verifyPayment` reason codes** — returned by `ChainClient.verifyPayment`
 *    and mapped inside the handler before being sent on the wire.  The notable mismatch:
 *    `verifyPayment` returns `'pending'` internally, but the wire label is `'settlement_pending'`.
 *
 * Wire codes: 'invoice_expired' | 'invoice_used' | 'unknown_nonce' | 'invalid_payment_header'
 *             | 'relayer_disabled' | 'not_found' | 'wrong_service' | 'amount_too_low' | 'expired'
 *             | 'already_attested' | 'tx_mismatch' | 'settlement_pending'
 * Internal-only codes (never sent raw): 'pending'
 */
export type PaywallErrorCode =
  | 'invoice_expired'
  | 'invoice_used'
  | 'unknown_nonce'
  | 'invalid_payment_header'
  | 'relayer_disabled'
  | 'not_found'
  | 'wrong_service'
  | 'amount_too_low'
  | 'expired'
  | 'already_attested'
  | 'tx_mismatch'
  | 'pending';

/** x402 proof header (request) + settlement header (response). Lowercase on the wire. */
export const HEADER_X_PAYMENT = 'x-payment';
export const HEADER_X_PAYMENT_RESPONSE = 'X-PAYMENT-RESPONSE';
