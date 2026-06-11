import type { Motes } from '@agentgate/shared';

/** One issued 402 invoice, keyed by its nonce (= Casper transfer_id). */
export interface StoredInvoice {
  nonce: string;
  serviceId: number;
  priceMotes: Motes;
  expiresAt: number; // unix ms
  used: boolean;
}

/**
 * Nonce/invoice persistence seam. The default is in-memory (MemoryInvoiceStore);
 * the async surface lets a Redis-backed store swap in without touching the app.
 */
export interface InvoiceStore {
  put(invoice: StoredInvoice): Promise<void>;
  /** Returns a copy of the invoice, or null when unknown (or already swept). */
  get(nonce: string): Promise<StoredInvoice | null>;
  /**
   * Atomically transitions an invoice from unused → used.
   * Returns false when the nonce is unknown OR already used — exactly one
   * concurrent caller wins, which is what makes invoices single-use.
   */
  markUsed(nonce: string): Promise<boolean>;
  /** Stops background sweeps. Safe to call multiple times. */
  close(): void;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * In-memory InvoiceStore with a periodic TTL sweep (interval is unref'd so it
 * never keeps the process alive). Expired invoices survive one extra sweep
 * interval so a late proof still gets the precise `invoice_expired` error
 * instead of `unknown_nonce`.
 */
export class MemoryInvoiceStore implements InvoiceStore {
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly graceMs: number;
  private closed = false;

  constructor(sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS) {
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new RangeError(`sweepIntervalMs must be a positive number, got ${sweepIntervalMs}`);
    }
    this.graceMs = sweepIntervalMs;
    this.sweeper = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweeper.unref();
  }

  /** Number of invoices currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.invoices.size;
  }

  put(invoice: StoredInvoice): Promise<void> {
    this.invoices.set(invoice.nonce, { ...invoice });
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
    return Promise.resolve(true);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
  }

  /** Removes invoices whose expiry is more than one sweep interval in the past. */
  private sweep(): void {
    const cutoff = Date.now() - this.graceMs;
    for (const [nonce, invoice] of this.invoices) {
      if (invoice.expiresAt < cutoff) this.invoices.delete(nonce);
    }
  }
}
