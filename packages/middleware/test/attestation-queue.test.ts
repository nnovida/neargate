import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FileAttestationQueue } from '../src/attestation-queue-file';
import { MemoryAttestationQueue } from '../src/attestation-queue';

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentgate-att-'));
  return path.join(dir, 'attestations.json');
}

describe('MemoryAttestationQueue', () => {
  it('enqueues, lists, and removes in-memory', async () => {
    const q = new MemoryAttestationQueue();
    await q.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: true, enqueuedAt: 1 });
    await q.enqueue({ nonce: '22', paymentTxHash: 'TxBB', serviceId: 2, success: false, enqueuedAt: 2 });
    expect((await q.list()).map((i) => i.nonce).sort()).toEqual(['11', '22']);
    await q.remove('11');
    expect((await q.list()).map((i) => i.nonce)).toEqual(['22']);
    q.close();
  });

  it('enqueue is idempotent on nonce (the registry attests a payment nonce once)', async () => {
    const q = new MemoryAttestationQueue();
    await q.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: true, enqueuedAt: 1 });
    await q.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: false, enqueuedAt: 9 });
    expect(await q.list()).toHaveLength(1);
    q.close();
  });
});

describe('FileAttestationQueue (F7 — survives restart)', () => {
  it('persists enqueued attestations and reloads them from disk on a new instance', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file);
    await q1.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: true, enqueuedAt: 1 });
    await q1.enqueue({ nonce: '22', paymentTxHash: 'TxBB', serviceId: 2, success: false, enqueuedAt: 2 });
    q1.close();

    const q2 = new FileAttestationQueue(file);
    const items = await q2.list();
    expect(items.map((i) => i.nonce).sort()).toEqual(['11', '22']);
    expect(items.find((i) => i.nonce === '22')).toMatchObject({
      serviceId: 2,
      success: false,
    });
    q2.close();
  });

  it('remove() persists the deletion so a reloaded instance no longer sees it', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file);
    await q1.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: true, enqueuedAt: 1 });
    await q1.remove('11');
    q1.close();

    const q2 = new FileAttestationQueue(file);
    expect(await q2.list()).toEqual([]);
    q2.close();
  });

  it('a missing or corrupt file starts empty rather than throwing', async () => {
    const file = await tmpFile();
    const q1 = new FileAttestationQueue(file); // no file yet
    expect(await q1.list()).toEqual([]);
    await q1.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: true, enqueuedAt: 1 });
    q1.close();

    // Corrupt the backing file → a fresh instance must not crash.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{not json', 'utf8');
    const q2 = new FileAttestationQueue(file);
    expect(await q2.list()).toEqual([]);
    q2.close();
  });

  it('rejects an empty file path', () => {
    expect(() => new FileAttestationQueue('')).toThrow();
  });

  it('writes valid JSON to disk on enqueue', async () => {
    const file = await tmpFile();
    const q = new FileAttestationQueue(file);
    await q.enqueue({ nonce: '11', paymentTxHash: 'TxAA', serviceId: 1, success: true, enqueuedAt: 1 });
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown[];
    expect(parsed).toHaveLength(1);
    q.close();
  });
});
