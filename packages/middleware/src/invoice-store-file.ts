import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { InvoiceStore, StoredInvoice } from './invoice-store';

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * File-backed {@link InvoiceStore}: an in-memory Map mirrored to a JSON file
 * with an atomic (temp-write + rename) flush on every mutation. Unlike
 * {@link MemoryInvoiceStore}, issued invoices survive a process restart — so a
 * buyer who already sent an irreversible on-chain payment is not lost when the
 * gateway redeploys or crashes between the 402 challenge and the proof retry
 * (finding F2). Single-instance only; for a multi-instance deployment use a
 * shared store (the async interface is designed for a Redis-backed one).
 */
export class FileInvoiceStore implements InvoiceStore {
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly graceMs: number;
  private closed = false;

  constructor(
    private readonly filePath: string,
    sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
  ) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('FileInvoiceStore requires a non-empty file path');
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new RangeError(`sweepIntervalMs must be a positive number, got ${sweepIntervalMs}`);
    }
    this.graceMs = sweepIntervalMs;
    this.load();
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }

  /** Number of invoices currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.invoices.size;
  }

  put(invoice: StoredInvoice): Promise<void> {
    this.invoices.set(invoice.nonce, { ...invoice });
    this.persist();
    return Promise.resolve();
  }

  get(nonce: string): Promise<StoredInvoice | null> {
    const found = this.invoices.get(nonce);
    return Promise.resolve(found ? { ...found } : null);
  }

  markUsed(nonce: string): Promise<boolean> {
    const found = this.invoices.get(nonce);
    if (!found || found.used) return Promise.resolve(false);
    found.used = true;
    this.persist();
    return Promise.resolve(true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
  }

  /** Loads invoices from disk. A missing or corrupt file starts empty (never throws). */
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return; // no file yet — fresh start
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        const inv = item as Partial<StoredInvoice>;
        if (
          inv &&
          typeof inv.nonce === 'string' &&
          typeof inv.serviceId === 'number' &&
          typeof inv.priceMotes === 'string' &&
          typeof inv.expiresAt === 'number' &&
          typeof inv.used === 'boolean'
        ) {
          this.invoices.set(inv.nonce, inv as StoredInvoice);
        }
      }
    } catch {
      // Corrupt file — start empty rather than crash the gateway on boot.
    }
  }

  /** Atomically rewrites the backing file (temp + rename) so a crash mid-write never corrupts it. */
  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.invoices.values()]), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Removes invoices whose expiry is more than one sweep interval in the past. */
  private sweep(): void {
    const cutoff = Date.now() - this.graceMs;
    let changed = false;
    for (const [nonce, invoice] of this.invoices) {
      if (invoice.expiresAt < cutoff) {
        this.invoices.delete(nonce);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
