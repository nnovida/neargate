import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AttestationQueue, PendingAttestation } from './attestation-queue';

/**
 * File-backed {@link AttestationQueue}: an in-memory Map mirrored to a JSON file
 * with an atomic (temp-write + rename) flush on every mutation. Unlike
 * {@link MemoryAttestationQueue}, a pending attestation survives a process
 * restart — so a served-and-paid call whose on-chain attestation never confirmed
 * before a deploy/crash is replayed on the next boot instead of being silently
 * dropped from the trust ledger (finding F7). Replay is idempotent: the registry
 * dedups by `(service_id, payment_deploy_hash)`, so re-recording is a no-op.
 *
 * Single-instance only; for a multi-instance deployment use a shared store (the
 * async interface is designed for a Redis-backed one).
 */
export class FileAttestationQueue implements AttestationQueue {
  private readonly items = new Map<string, PendingAttestation>();

  constructor(private readonly filePath: string) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new Error('FileAttestationQueue requires a non-empty file path');
    }
    this.load();
  }

  /** Number of pending attestations currently held. */
  get size(): number {
    return this.items.size;
  }

  enqueue(item: PendingAttestation): Promise<void> {
    this.items.set(item.paymentDeployHash, { ...item });
    this.persist();
    return Promise.resolve();
  }

  remove(paymentDeployHash: string): Promise<void> {
    if (this.items.delete(paymentDeployHash)) this.persist();
    return Promise.resolve();
  }

  list(): Promise<PendingAttestation[]> {
    return Promise.resolve([...this.items.values()].map((i) => ({ ...i })));
  }

  close(): void {
    // No timers held; nothing to release.
  }

  /** Loads pending attestations from disk. A missing or corrupt file starts empty (never throws). */
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
      for (const entry of parsed) {
        const p = entry as Partial<PendingAttestation>;
        if (
          p &&
          typeof p.paymentDeployHash === 'string' &&
          typeof p.serviceId === 'number' &&
          typeof p.success === 'boolean' &&
          typeof p.enqueuedAt === 'number'
        ) {
          this.items.set(p.paymentDeployHash, p as PendingAttestation);
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
    writeFileSync(tmp, JSON.stringify([...this.items.values()]), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
