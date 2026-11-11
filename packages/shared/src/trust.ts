import type { ServiceScore } from './types';

export type TrustTier = 'new' | 'reliable' | 'trusted';

/**
 * A payment is self-paid when the payer is the service's owner or its payment
 * target. Self-paid calls never earn an attestation, so a seller cannot inflate
 * its own score. NEAR account ids are canonical lowercase, so this is an exact match.
 */
export function isSelfPaid(payer: string, service: { owner: string; paymentTarget: string }): boolean {
  return payer === service.owner || payer === service.paymentTarget;
}

/**
 * Score → trust badge (used by dashboard + buyer agent).
 * - 'new'      if totalCalls < 5
 * - 'trusted'  if totalCalls >= 25 AND success ratio >= 0.95
 * - 'reliable' if totalCalls >= 5  AND success ratio >= 0.9
 * - else 'new'
 * Ratio comparisons use exact integer math to avoid float boundary surprises.
 */
export function trustTier(score: ServiceScore): TrustTier {
  const total = score.totalCalls;
  const success = score.successCalls;
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(success) ||
    total < 0 ||
    success < 0 ||
    success > total
  ) {
    // Malformed scores never earn a badge.
    return 'new';
  }
  if (total < 5) return 'new';
  if (total >= 25 && success * 100 >= total * 95) return 'trusted';
  if (success * 10 >= total * 9) return 'reliable';
  return 'new';
}
