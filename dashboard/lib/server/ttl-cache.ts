/**
 * Tiny in-process TTL cache for the dashboard's /api/* bodies.
 *
 * Each route fans out to several NEAR RPC views per uncached request (a catalog read is one
 * `list_services` plus one `get_score` per service), the pages poll every 5 s, and the public RPC
 * rate-limits. One TtlCache per route collapses every open tab onto a single upstream load per TTL
 * window, shares one in-flight promise between concurrent cold loads, and keeps the last good body
 * so a failed refresh (an RPC 429, a brief outage) can degrade to a stale response via
 * `peekLatest` instead of an error.
 *
 * Server-only and per process: with several dashboard processes each one keeps its own cache.
 */

/** How a response body was produced: the value of the routes' `x-cache` header. */
export type CacheVia = 'hit' | 'miss' | 'stale';

interface Entry<T> {
  at: number;
  body: T;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  /**
   * @param ttlMs   how long a loaded body counts as fresh
   * @param maxKeys cap on distinct keys; the key written longest ago is dropped first, so a
   *                caller cycling through ids cannot grow the cache without bound
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 256,
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
   * loader call. A rejected load is never cached and does not stay in flight, so the next call
   * tries the upstream again.
   */
  async load(key: string, loader: () => Promise<T>): Promise<{ body: T; via: Exclude<CacheVia, 'stale'> }> {
    const fresh = this.peekFresh(key);
    if (fresh !== null) return { body: fresh, via: 'hit' };

    const pending = this.inflight.get(key);
    if (pending !== undefined) return { body: await pending, via: 'miss' };

    const loading = loader()
      .then((body) => {
        this.store(key, body);
        return body;
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
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
