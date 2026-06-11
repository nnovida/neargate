import type { Logger } from '@agentgate/shared';
import type { FeedResponse, FetchLike, PairFeed, SourceQuote } from './types';
import { FIXTURE_USD_IDR, FIXTURE_XAU_USD, STATIC_ATTRIBUTION, fixtureFeed, fixturePair } from './fixture';
import { SOURCES, fetchSource, type SourceResult } from './sources';
import { confidenceOf, roundTo } from './math';

/** In-memory cache TTL (SPEC §7: 60s). */
export const CACHE_TTL_MS = 60_000;

export interface FeedProviderOpts {
  staticMode: boolean;
  fetchImpl: FetchLike;
  logger: Logger;
  now: () => number;
}

function buildPair(
  quotes: SourceQuote[],
  fixtureValue: number,
): { pair: PairFeed; usedFixture: boolean } {
  if (quotes.length === 0) {
    return { pair: fixturePair(fixtureValue), usedFixture: true };
  }
  const values = quotes.map((q) => q.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    pair: { value: roundTo(mean, 4), sources: quotes, confidence: confidenceOf(values) },
    usedFixture: false,
  };
}

/** Pure assembly of the feed body from whichever sources responded. */
export function buildFeed(results: readonly SourceResult[], asOf: number): FeedResponse {
  const idrQuotes: SourceQuote[] = [];
  const xauQuotes: SourceQuote[] = [];
  for (const r of results) {
    if (r.usdIdr !== null) idrQuotes.push({ name: r.name, value: r.usdIdr });
    if (r.xauUsd !== null) xauQuotes.push({ name: r.name, value: r.xauUsd });
  }

  const usdIdr = buildPair(idrQuotes, FIXTURE_USD_IDR);
  const xauUsd = buildPair(xauQuotes, FIXTURE_XAU_USD);

  const names = results.map((r) => r.name);
  if (usdIdr.usedFixture || xauUsd.usedFixture) names.push(STATIC_ATTRIBUTION);
  const attribution = names.length === 0 ? STATIC_ATTRIBUTION : names.join(', ');

  return {
    pairs: { usd_idr: usdIdr.pair, xau_usd: xauUsd.pair },
    asOf,
    attribution,
  };
}

/**
 * Best-effort feed provider: fetches the two no-key sources concurrently
 * (5s timeout each), caches the assembled feed for 60s, deduplicates
 * concurrent refreshes, and never rejects — when everything is down it
 * returns the deterministic fixture with attribution "static-fixture".
 */
export class FeedProvider {
  private cache: { feed: FeedResponse; fetchedAt: number } | null = null;
  private inflight: Promise<FeedResponse> | null = null;

  constructor(private readonly opts: FeedProviderOpts) {}

  async getFeed(): Promise<FeedResponse> {
    const now = this.opts.now();
    if (this.opts.staticMode) return fixtureFeed(now);
    if (this.cache !== null && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.feed;
    }
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<FeedResponse> {
    try {
      const settled = await Promise.all(
        SOURCES.map((def) => fetchSource(def, this.opts.fetchImpl, this.opts.logger)),
      );
      const results = settled.filter((r): r is SourceResult => r !== null);
      const asOf = this.opts.now();
      const feed = buildFeed(results, asOf);
      this.cache = { feed, fetchedAt: asOf };
      if (results.length === 0) {
        this.opts.logger.warn('all oracle sources unavailable — serving static fixture');
      }
      return feed;
    } catch (err) {
      // Defensive: fetchSource never throws, but the consumer must never see an error.
      this.opts.logger.error('oracle refresh failed — serving static fixture', {
        error: err instanceof Error ? err.message : String(err),
      });
      const asOf = this.opts.now();
      const feed = fixtureFeed(asOf);
      this.cache = { feed, fetchedAt: asOf };
      return feed;
    }
  }
}
