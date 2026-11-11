/**
 * Tiny in-process TTL cache for the dashboard's /api/* bodies.
 *
 * Each route fans out to several NEAR RPC views per uncached request (a catalog read is one
 * `list_services` plus one `get_score` per service), the pages poll every 5 s, and the public RPC
 * rate-limits. One TtlCache per route collapses every open tab onto a single upstream load per TTL
 * window, shares one in-flight promise between concurrent cold loads, and keeps the last good body
 * so a failed refresh (an RPC 429, a brief outage) can degrade to a stale response via
 * `peekLatest` instead of an error. A failed load also backs the key off for one TTL window: while
 * the upstream is down, the pollers are answered from the stale body (or the same error) instead of
 * each tab re-running the whole fan-out against a rate-limited RPC.
 *
 * Server-only and per process: with several dashboard processes each one keeps its own cache.
 */

/** How a response body was produced: the value of the routes' `x-cache` header. */
export type CacheVia = 'hit' | 'miss' | 'stale';

interface Entry<T> {
  at: number;
  body: T;
}

interface Failure {
  at: number;
  error: unknown;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly failures = new Map<string, Failure>();

  /**
   * @param ttlMs    how long a loaded body counts as fresh, and how long a failed load is not retried
   * @param maxKeys  cap on distinct keys (bodies and remembered failures each); the key written
   *                 longest ago is dropped first, so a caller cycling through ids cannot grow the
   *                 cache without bound
   * @param backsOff whether a loader error is an upstream failure worth a retry pause. Return false
   *                 for an expected outcome such as an unknown id: it is rethrown every time and
   *                 asks the upstream again on the next call. Default: every error backs off.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 256,
    private readonly backsOff: (error: unknown) => boolean = () => true,
  ) {}

  /** The cached body if it is younger than the TTL, else null. */
  peekFresh(key: string): T | null {
    const entry = this.entries.get(key);
    return entry !== undefined && Date.now() - entry.at < this.ttlMs ? entry.body : null;
  }

  /** The most recent cached body of any age, else null: the stale fallback after a failed refresh. */
  peekLatest(key: string): T | null {
    return this.entries.get(key)?.body ?? null;
  }

  /**
   * The fresh cached body, or the result of `loader`. Concurrent callers for one key share a single
   * loader call. A rejected load is never cached and does not stay in flight; the error is
   * rethrown, without calling the loader, for `ttlMs` after the failure, then the next call tries
   * the upstream again. A successful load clears the failure.
   */
  async load(key: string, loader: () => Promise<T>): Promise<{ body: T; via: Exclude<CacheVia, 'stale'> }> {
    const fresh = this.peekFresh(key);
    if (fresh !== null) return { body: fresh, via: 'hit' };

    const pending = this.inflight.get(key);
    if (pending !== undefined) return { body: await pending, via: 'miss' };

    const failure = this.failures.get(key);
    if (failure !== undefined && Date.now() - failure.at < this.ttlMs) throw failure.error;

    const loading = loader()
      .then((body) => {
        this.failures.delete(key);
        this.store(key, body);
        return body;
      })
      .catch((error: unknown) => {
        if (this.backsOff(error)) this.remember(key, error);
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, loading);
    return { body: await loading, via: 'miss' };
  }

  private store(key: string, body: T): void {
    // Delete first so a rewritten key moves to the back of the Map's insertion order.
    this.entries.delete(key);
    this.entries.set(key, { at: Date.now(), body });
    evictOldest(this.entries, this.maxKeys);
  }

  private remember(key: string, error: unknown): void {
    this.failures.delete(key);
    this.failures.set(key, { at: Date.now(), error });
    evictOldest(this.failures, this.maxKeys);
  }
}

/** Drops the first-inserted keys of `map` until at most `max` remain. */
function evictOldest(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) return;
    map.delete(oldest.value);
  }
}
