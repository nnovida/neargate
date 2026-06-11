import type { ChainClient, ServiceRecord } from '@agentgate/shared';

export const SERVICE_CACHE_TTL_MS = 60_000;

/**
 * 60-second read-through cache over ChainClient.getService.
 * Positive results are cached for the TTL; misses are NOT cached so a freshly
 * registered service becomes reachable immediately.
 */
export class ServiceCache {
  private readonly chain: ChainClient;
  private readonly ttlMs: number;
  private readonly entries = new Map<number, { fetchedAt: number; record: ServiceRecord }>();

  constructor(chain: ChainClient, ttlMs: number = SERVICE_CACHE_TTL_MS) {
    this.chain = chain;
    this.ttlMs = ttlMs;
  }

  async get(id: number): Promise<ServiceRecord | null> {
    const hit = this.entries.get(id);
    if (hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit.record;
    const record = await this.chain.getService(id);
    if (record) {
      this.entries.set(id, { fetchedAt: Date.now(), record });
    } else {
      this.entries.delete(id);
    }
    return record;
  }
}
