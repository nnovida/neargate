import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCache } from '@/lib/server/ttl-cache';

/** The dashboard routes' contract: hit, miss and the stale fallback, with in-flight dedup. */
describe('TtlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a body younger than the TTL without calling the loader again (hit)', async () => {
    const cache = new TtlCache<number>(100);
    const loader = vi.fn().mockResolvedValue(1);

    const first = await cache.load('k', loader);
    const second = await cache.load('k', loader);

    expect(first).toEqual({ body: 1, via: 'miss' });
    expect(second).toEqual({ body: 1, via: 'hit' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('reloads after the TTL has elapsed (miss)', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(100);
    const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await cache.load('k', loader);

    vi.advanceTimersByTime(99);
    expect(await cache.load('k', loader)).toEqual({ body: 1, via: 'hit' });

    vi.advanceTimersByTime(2); // 101 ms since the load: expired
    expect(await cache.load('k', loader)).toEqual({ body: 2, via: 'miss' });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('concurrent loads for one key share one loader call', async () => {
    let resolveLoad!: (value: number) => void;
    const loader = vi.fn(() => new Promise<number>((resolve) => (resolveLoad = resolve)));
    const cache = new TtlCache<number>(1000);

    const a = cache.load('k', loader);
    const b = cache.load('k', loader);
    resolveLoad(7);

    expect(await Promise.all([a, b])).toEqual([
      { body: 7, via: 'miss' },
      { body: 7, via: 'miss' },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('a rejected load is not cached and clears its in-flight entry', async () => {
    const cache = new TtlCache<number>(1000);
    let rejectLoad!: (reason: Error) => void;
    const failing = vi.fn(() => new Promise<number>((_resolve, reject) => (rejectLoad = reject)));

    // Both concurrent callers see the one shared failure.
    const a = cache.load('k', failing);
    const b = cache.load('k', failing);
    rejectLoad(new Error('rpc down'));
    await expect(a).rejects.toThrow('rpc down');
    await expect(b).rejects.toThrow('rpc down');
    expect(failing).toHaveBeenCalledTimes(1);
    expect(cache.peekLatest('k')).toBeNull();

    // The key is not wedged on the dead promise: the next load goes upstream again and succeeds.
    const recovered = vi.fn().mockResolvedValue(42);
    expect(await cache.load('k', recovered)).toEqual({ body: 42, via: 'miss' });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(await cache.load('k', recovered)).toEqual({ body: 42, via: 'hit' });
  });

  it('a failed refresh leaves the last good body for peekLatest', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(50);
    await cache.load('k', async () => 'good');
    vi.advanceTimersByTime(51);

    await expect(
      cache.load('k', async () => {
        throw new Error('rpc down');
      }),
    ).rejects.toThrow('rpc down');

    expect(cache.peekFresh('k')).toBeNull();
    expect(cache.peekLatest('k')).toBe('good');
  });

  it('peekLatest keeps the body after the TTL while peekFresh does not', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(50);
    expect(cache.peekFresh('k')).toBeNull();
    expect(cache.peekLatest('k')).toBeNull();

    await cache.load('k', async () => 'good');
    expect(cache.peekFresh('k')).toBe('good');

    vi.advanceTimersByTime(51);
    expect(cache.peekFresh('k')).toBeNull();
    expect(cache.peekLatest('k')).toBe('good');
  });

  it('keeps keys independent', async () => {
    const cache = new TtlCache<number>(1000);
    await cache.load('a', async () => 1);
    await cache.load('b', async () => 2);

    expect(cache.peekFresh('a')).toBe(1);
    expect(cache.peekFresh('b')).toBe(2);
    expect(cache.peekFresh('c')).toBeNull();
  });

  it('evicts the oldest key once maxKeys is exceeded', async () => {
    const cache = new TtlCache<number>(1000, 2);
    await cache.load('a', async () => 1);
    await cache.load('b', async () => 2);
    expect(cache.peekLatest('a')).toBe(1);

    await cache.load('c', async () => 3);

    expect(cache.peekLatest('a')).toBeNull();
    expect(cache.peekLatest('b')).toBe(2);
    expect(cache.peekLatest('c')).toBe(3);
  });

  it('counts a refreshed key as newly written when picking the oldest', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(100, 2);
    await cache.load('a', async () => 1);
    await cache.load('b', async () => 2);
    vi.advanceTimersByTime(101);
    await cache.load('a', async () => 10); // a is rewritten, so b is now the oldest

    await cache.load('c', async () => 3);

    expect(cache.peekLatest('b')).toBeNull();
    expect(cache.peekLatest('a')).toBe(10);
    expect(cache.peekLatest('c')).toBe(3);
  });

  it('defaults to 256 keys', async () => {
    const cache = new TtlCache<number>(1000);
    for (let i = 0; i < 257; i++) await cache.load(`k${i}`, async () => i);

    expect(cache.peekLatest('k0')).toBeNull();
    expect(cache.peekLatest('k1')).toBe(1);
    expect(cache.peekLatest('k256')).toBe(256);
  });
});
