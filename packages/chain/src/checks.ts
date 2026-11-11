import { AgentGateError, isValidNonce } from '@agentgate/shared';
import type { PaymentRecord, VerifyPaymentQuery, VerifyResult } from '@agentgate/shared';

// Argument checks and the registry-record half of `verifyPayment`, shared by
// MockChainHttpClient and LiveNearClient so both answer with the same codes and messages.

/** A yocto amount as the registry writes it: a decimal string without sign or leading zeros. */
export const YOCTO_RE = /^(0|[1-9]\d*)$/;

export function invalid(message: string): AgentGateError {
  return new AgentGateError('invalid_query', message, 400);
}

export function assertNonEmpty(value: string, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${what} must be a non-empty string`);
  }
}

export function assertServiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalid(`serviceId must be a positive integer, got ${String(id)}`);
  }
}

export function assertYocto(value: unknown, what: string): void {
  if (typeof value !== 'string' || !YOCTO_RE.test(value)) {
    throw invalid(`${what} must be a yocto decimal string`);
  }
}

/** Throws invalid_query unless the query's nonce, serviceId, minAmountYocto and maxAgeMs are well formed. */
export function checkVerifyQuery(q: VerifyPaymentQuery): void {
  if (typeof q.nonce !== 'string' || !isValidNonce(q.nonce)) {
    throw invalid('nonce must be 1–20 decimal digits');
  }
  assertServiceId(q.serviceId);
  assertYocto(q.minAmountYocto, 'minAmountYocto');
  if (typeof q.maxAgeMs !== 'number' || !Number.isFinite(q.maxAgeMs) || q.maxAgeMs < 0) {
    throw invalid('maxAgeMs must be a non-negative number');
  }
}

/**
 * The registry record's verdict on a payment, checked in this order: not_found, wrong_service,
 * amount_too_low, expired (older than `maxAgeMs` at `nowMs`), already_attested, then ok with
 * the record's payer, amount, time and selfPaid.
 */
export function judgePaymentRecord(payment: PaymentRecord | null, q: VerifyPaymentQuery, nowMs: number): VerifyResult {
  if (payment === null) return { ok: false, reason: 'not_found' };
  if (payment.serviceId !== q.serviceId) return { ok: false, reason: 'wrong_service' };
  if (BigInt(payment.amountYocto) < BigInt(q.minAmountYocto)) return { ok: false, reason: 'amount_too_low' };
  if (nowMs - payment.timestamp > q.maxAgeMs) return { ok: false, reason: 'expired' };
  if (payment.attested) return { ok: false, reason: 'already_attested' };
  return {
    ok: true,
    amountYocto: payment.amountYocto,
    payer: payment.payer,
    timestamp: payment.timestamp,
    selfPaid: payment.selfPaid,
  };
}
