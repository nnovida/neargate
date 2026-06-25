import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentGateError, type Logger } from '@agentgate/shared';

export interface UpstreamMapping {
  serviceId: number;
  upstreamUrl: string;
}

/**
 * serviceId → upstream URL map persisted to a JSON file
 * (`{"<serviceId>": "<upstreamUrl>", ...}`).
 *
 * - `loadSync()` reads the file at boot (missing file = empty map; corrupt
 *   file = hard failure so we never silently drop seller config).
 * - Writes are atomic (write tmp file in the same directory, then rename)
 *   and serialized through an internal queue so concurrent admin calls can
 *   never interleave partial files.
 */
export class UpstreamStore {
  readonly filePath: string;
  private readonly map = new Map<number, string>();
  private readonly logger: Logger | undefined;
  /** Tail of the write queue; kept rejection-free so one failure can't poison it. */
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, logger?: Logger) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
  }

  /**
   * Loads the mapping file at boot. Missing file → empty map. Corrupt file →
   * throws. An optional `validate(url, serviceId)` predicate (e.g. the SSRF
   * guard) lets the caller drop entries that are no longer acceptable — a
   * persisted mapping to a now-forbidden host is skipped (with a loud warn)
   * rather than silently trusted.
   */
  loadSync(validate?: (upstreamUrl: string, serviceId: number) => boolean): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgentGateError(
        'UPSTREAMS_FILE_INVALID',
        `upstream map file is not valid JSON: ${this.filePath} — fix or delete it`,
        500,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AgentGateError(
        'UPSTREAMS_FILE_INVALID',
        `upstream map file must be a JSON object of {"serviceId": "url"}: ${this.filePath}`,
        500,
      );
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!/^\d{1,15}$/.test(key) || typeof value !== 'string') {
        throw new AgentGateError(
          'UPSTREAMS_FILE_INVALID',
          `upstream map file has an invalid entry (key ${JSON.stringify(key)}): ${this.filePath}`,
          500,
        );
      }
      const serviceId = Number(key);
      if (validate && !validate(value, serviceId)) {
        // Defense-in-depth: a persisted mapping that fails the current guard
        // (e.g. a now-forbidden private host) is dropped, not trusted.
        this.logger?.warn('upstream_entry_rejected_on_load', { serviceId });
        continue;
      }
      this.map.set(serviceId, value);
    }
    this.logger?.info('upstreams_loaded', { count: this.map.size });
  }

  get(serviceId: number): string | undefined {
    return this.map.get(serviceId);
  }

  has(serviceId: number): boolean {
    return this.map.has(serviceId);
  }

  list(): UpstreamMapping[] {
    return [...this.map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([serviceId, upstreamUrl]) => ({ serviceId, upstreamUrl }));
  }

  /** Adds/replaces a mapping and persists atomically. Resolves once on disk. */
  async set(serviceId: number, upstreamUrl: string): Promise<void> {
    this.map.set(serviceId, upstreamUrl);
    await this.persist();
  }

  /** Removes a mapping (idempotent) and persists atomically. */
  async delete(serviceId: number): Promise<void> {
    if (!this.map.delete(serviceId)) return; // nothing changed — skip the disk write
    await this.persist();
  }

  /** Resolves when all queued writes have settled (used by graceful shutdown). */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private persist(): Promise<void> {
    const snapshot: Record<string, string> = {};
    for (const { serviceId, upstreamUrl } of this.list()) snapshot[String(serviceId)] = upstreamUrl;
    const write = this.queue.then(() => this.writeAtomic(snapshot));
    // Keep the queue tail rejection-free; callers of set/delete still see the error.
    this.queue = write.catch(() => undefined);
    return write;
  }

  private async writeAtomic(snapshot: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(tmpPath, this.filePath);
  }
}
