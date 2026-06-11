import type { FeedResponse, PairFeed } from './types';

/**
 * Deterministic fixture data (SPEC §7) — served when `ORACLE_STATIC=1` or when
 * every live source is unavailable (best-effort, never-throw behavior).
 */
export const FIXTURE_USD_IDR = 16250.5;
export const FIXTURE_XAU_USD = 3310.25;
export const FIXTURE_CONFIDENCE = 0.97;
export const STATIC_ATTRIBUTION = 'static-fixture';

/** Fixture entry for a single pair. */
export function fixturePair(value: number): PairFeed {
  return {
    value,
    sources: [{ name: STATIC_ATTRIBUTION, value }],
    confidence: FIXTURE_CONFIDENCE,
  };
}

/** The full deterministic fixture feed. */
export function fixtureFeed(asOf: number): FeedResponse {
  return {
    pairs: {
      usd_idr: fixturePair(FIXTURE_USD_IDR),
      xau_usd: fixturePair(FIXTURE_XAU_USD),
    },
    asOf,
    attribution: STATIC_ATTRIBUTION,
  };
}
