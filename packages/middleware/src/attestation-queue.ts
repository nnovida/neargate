/**
 * Durable attestation queue (finding F7).
 *
 * A served-and-paid call is scored by an on-chain `record_attestation`. That
 * write is fire-and-forget with in-process retry (see app.ts `scheduleAttestation`),
 * so a call whose retries all fail — or whose process exits mid-retry (deploy,
 * crash) — would be silently *under-counted*: the buyer paid, the seller served,
 * but the trust ledger never learned about it.
 *
 * This queue closes that gap. Each pending attestation is enqueued *before* the
 * first on-chain attempt and removed only once the attempt confirms. Unconfirmed
 * entries survive a restart (file-backed variant) and are replayed on boot.
 * Replay is safe because the registry contract dedups by
 * `(service_id, payment_deploy_hash)` (`seen_payments`), so re-submitting an
 * already-recorded attestation is an idempotent no-op on-chain.
 */
export interface PendingAttestation {
  /** Payment deploy hash — the idempotent key (on-chain `seen_payments` dedups replays). */
  paymentDeployHash: string;
  /** Service whose score this attestation feeds. */
  serviceId: number;
  /** Whether the served upstream response was a 2xx (success flag recorded on-chain). */
  success: boolean;
  /** ms-epoch the payment was captured (kept for diagnostics / future age-based pruning). */
  enqueuedAt: number;
}

/**
 * Persistence seam for pending attestations. The default is in-memory
 * ({@link MemoryAttestationQueue}); a file-backed variant survives restarts. The
 * interface is async so a shared store (e.g. Redis) can slot in for a
 * multi-instance deployment, exactly like {@link InvoiceStore}.
 */
export interface AttestationQueue {
  /** Record a pending attestation. Keyed by `paymentDeployHash` — enqueuing the same hash twice is idempotent. */
  enqueue(item: PendingAttestation): Promise<void>;
  /** Drop a confirmed attestation so it is never replayed. */
  remove(paymentDeployHash: string): Promise<void>;
  /** All still-pending attestations (used to replay on boot). */
  list(): Promise<PendingAttestation[]>;
  /** Release any resources (timers/handles). Idempotent. */
  close(): void;
}

/** In-memory {@link AttestationQueue}: retries survive within a process but not a restart. */
export class MemoryAttestationQueue implements AttestationQueue {
  private readonly items = new Map<string, PendingAttestation>();

  /** Number of pending attestations currently held. */
  get size(): number {
    return this.items.size;
  }

  enqueue(item: PendingAttestation): Promise<void> {
    this.items.set(item.paymentDeployHash, { ...item });
    return Promise.resolve();
  }

  remove(paymentDeployHash: string): Promise<void> {
    this.items.delete(paymentDeployHash);
    return Promise.resolve();
  }

  list(): Promise<PendingAttestation[]> {
    return Promise.resolve([...this.items.values()].map((i) => ({ ...i })));
  }

  close(): void {
    // no-op
  }
}
