import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MemoryInvoiceStore, UpstreamStore } from '../src/index';
import { sleep, until } from './helpers';

describe('MemoryInvoiceStore', () => {
  it('stores and retrieves invoices by nonce (copies, not references)', async () => {
    const store = new MemoryInvoiceStore();
    try {
      await store.put({ nonce: '42', serviceId: 1, priceMotes: '100', expiresAt: Date.now() + 1000, used: false });
      const got = await store.get('42');
      expect(got).toMatchObject({ nonce: '42', serviceId: 1, used: false });
      if (got) got.used = true; // mutating the copy must not affect the store
      expect((await store.get('42'))?.used).toBe(false);
      expect(await store.get('nope')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('markUsed is single-winner: exactly one of two competing calls succeeds', async () => {
    const store = new MemoryInvoiceStore();
    try {
      await store.put({ nonce: '7', serviceId: 1, priceMotes: '100', expiresAt: Date.now() + 1000, used: false });
      const [a, b] = await Promise.all([store.markUsed('7'), store.markUsed('7')]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await store.markUsed('missing')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('TTL sweep evicts long-expired invoices', async () => {
    const store = new MemoryInvoiceStore(25);
    try {
      await store.put({ nonce: '1', serviceId: 1, priceMotes: '100', expiresAt: Date.now() - 100, used: false });
      await store.put({ nonce: '2', serviceId: 1, priceMotes: '100', expiresAt: Date.now() + 60_000, used: false });
      await until(() => store.size === 1, 2_000);
      expect(await store.get('1')).toBeNull();
      expect(await store.get('2')).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('rejects a non-positive sweep interval', () => {
    expect(() => new MemoryInvoiceStore(0)).toThrow(RangeError);
  });
});

describe('UpstreamStore', () => {
  async function tmpFile(): Promise<string> {
    return path.join(await mkdtemp(path.join(os.tmpdir(), 'agentgate-us-')), 'upstreams.json');
  }

  it('starts empty when the file does not exist', async () => {
    const store = new UpstreamStore(await tmpFile());
    store.loadSync();
    expect(store.list()).toEqual([]);
  });

  it('persists atomically and reloads: set/delete round-trip with no stray tmp files', async () => {
    const file = await tmpFile();
    const store = new UpstreamStore(file);
    store.loadSync();
    await Promise.all([
      store.set(3, 'http://example.com/c'),
      store.set(1, 'http://example.com/a'),
      store.set(2, 'http://example.com/b'),
    ]);
    await store.delete(2);
    await store.flush();

    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    expect(onDisk).toEqual({ '1': 'http://example.com/a', '3': 'http://example.com/c' });
    expect((await readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const reloaded = new UpstreamStore(file);
    reloaded.loadSync();
    expect(reloaded.list()).toEqual([
      { serviceId: 1, upstreamUrl: 'http://example.com/a' },
      { serviceId: 3, upstreamUrl: 'http://example.com/c' },
    ]);
    expect(reloaded.get(3)).toBe('http://example.com/c');
    expect(reloaded.get(2)).toBeUndefined();
  });

  it('throws a clear error on a corrupt mapping file', async () => {
    const file = await tmpFile();
    await writeFile(file, '{not json', 'utf8');
    const store = new UpstreamStore(file);
    expect(() => store.loadSync()).toThrow(/not valid JSON/);

    await writeFile(file, '["array"]', 'utf8');
    const arrayStore = new UpstreamStore(file);
    expect(() => arrayStore.loadSync()).toThrow(/JSON object/);

    await writeFile(file, '{"abc": "http://x"}', 'utf8');
    const badKeyStore = new UpstreamStore(file);
    expect(() => badKeyStore.loadSync()).toThrow(/invalid entry/);
  });

  it('delete is idempotent and skips disk writes when nothing changed', async () => {
    const file = await tmpFile();
    const store = new UpstreamStore(file);
    store.loadSync();
    await store.delete(99); // never existed — must not create the file
    await store.flush();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await sleep(1); // settle queue
  });
});
