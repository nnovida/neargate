/**
 * Public response shapes for the AgentGate oracle (SPEC §7) plus the minimal
 * structural fetch contract used for dependency injection in tests.
 */

/** Minimal structural response so tests can fake fetch without building Response objects. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Structural fetch signature — `globalThis.fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export type PairKey = 'usd_idr' | 'xau_usd';

/** One source's contribution to a pair. */
export interface SourceQuote {
  name: string;
  value: number;
}

/** Per-pair feed entry: `{value, sources: [{name, value}], confidence}`. */
export interface PairFeed {
  value: number;
  sources: SourceQuote[];
  confidence: number;
}

/** `GET /feed` body (SPEC §7). */
export interface FeedResponse {
  pairs: {
    usd_idr: PairFeed;
    xau_usd: PairFeed;
  };
  asOf: number; // unix ms when the data was obtained
  attribution: string;
}

/** `GET /feed/usd-idr` and `GET /feed/gold` body: the pair entry + feed metadata. */
export interface SinglePairResponse extends PairFeed {
  pair: PairKey;
  asOf: number;
  attribution: string;
}
