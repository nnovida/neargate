import { PAY_DELEGATE_REFUSALS, type PayDelegateRefusal } from '@agentgate/chain/delegate';

/**
 * Machine-readable reason codes attached to 402 responses.
 *
 * Two distinct categories — do NOT conflate them:
 *
 * 1. **Wire `error` strings** — surfaced verbatim in the PaymentRequiredResponse JSON body.
 *    These are the strings a client actually receives:
 *    'X-PAYMENT header is required' (literal string, not in this union),
 *    'invoice_expired', 'invoice_used', 'unknown_nonce', 'invalid_payment_header',
 *    'relayer_disabled', 'settlement_pending' (sent on wire for a pending payment), the
 *    verifyPayment pass-throughs below, and the gasless rail's own refusals (RELAYER_ENABLED):
 *    'delegate_<reason>' (the delegate's structure: malformed, wrong_sender, wrong_receiver,
 *    wrong_action, wrong_args, deposit_not_zero, gas_too_high, gas_too_low, expired,
 *    nonce_too_large), 'bad_signature', 'unknown_key', 'key_not_allowed', 'stale_nonce',
 *    'escrow_insufficient' and 'relay_failed' (with the chain's `code` in the body).
 *
 * 2. **Internal `verifyPayment` reason codes** — returned by `ChainClient.verifyPayment`
 *    and mapped inside the handler before being sent on the wire.  The notable mismatch:
 *    `verifyPayment` returns `'pending'` internally, but the wire label is `'settlement_pending'`.
 *
 * Wire codes: 'invoice_expired' | 'invoice_used' | 'unknown_nonce' | 'invalid_payment_header'
 *             | 'relayer_disabled' | 'not_found' | 'wrong_service' | 'amount_too_low' | 'expired'
 *             | 'already_attested' | 'tx_mismatch' | 'settlement_pending'
 *             | `delegate_${PayDelegateRefusal}` | 'bad_signature' | 'unknown_key' | 'key_not_allowed'
 *             | 'stale_nonce' | 'escrow_insufficient' | 'relay_failed'
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
  | `delegate_${PayDelegateRefusal}`
  | 'bad_signature'
  | 'unknown_key'
  | 'key_not_allowed'
  | 'stale_nonce'
  | 'escrow_insufficient'
  | 'relay_failed'
  | 'pending';

/**
 * Every 402 `error` the gasless rail answers of its own (RELAYER_ENABLED): the rail off, the
 * delegate (its structure, then its timing once the payment checks passed), its signature, its key
 * and nonce, the escrow, the relay. It also answers the invoice checks it shares with the tx rail
 * (`invoice_used`, ...) and `settlement_pending`. The docs list each one (dashboard/test).
 */
export const DELEGATE_RAIL_ERRORS: readonly PaywallErrorCode[] = [
  'relayer_disabled',
  ...PAY_DELEGATE_REFUSALS.map((reason) => `delegate_${reason}` as const),
  'bad_signature',
  'unknown_key',
  'key_not_allowed',
  'stale_nonce',
  'escrow_insufficient',
  'relay_failed',
];

/** x402 proof header (request) + settlement header (response). Lowercase on the wire. */
export const HEADER_X_PAYMENT = 'x-payment';
export const HEADER_X_PAYMENT_RESPONSE = 'X-PAYMENT-RESPONSE';
