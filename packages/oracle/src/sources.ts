import type { Logger } from '@agentgate/shared';
import type { FetchLike } from './types';
import { roundTo } from './math';

/** Per-source fetch timeout (SPEC §7: 5s per source). */
export const SOURCE_TIMEOUT_MS = 5_000;

/** What one upstream source yielded after parsing (null = pair not provided). */
export interface SourceResult {
  name: string;
  usdIdr: number | null;
  xauUsd: number | null;
}

export interface SourceDef {
  name: string;
  url: string;
  parse(body: unknown): { usdIdr: number | null; xauUsd: number | null };
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function positiveNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Rates quoted as "X per 1 USD"; XAU/USD is the inverse. */
function invert(perUsd: number | null): number | null {
  return perUsd === null ? null : roundTo(1 / perUsd, 4);
}

/**
 * The two free, no-key sources (SPEC §7). Both quote rates per 1 USD;
 * gold (XAU) is inverted into XAU/USD where the source provides it.
 */
export const SOURCES: readonly SourceDef[] = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse(body) {
      const rates = asObject(asObject(body)?.['rates']);
      return {
        usdIdr: positiveNumber(rates?.['IDR']),
        xauUsd: invert(positiveNumber(rates?.['XAU'])),
      };
    },
  },
  {
    name: 'fawazahmed0/currency-api',
    url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    parse(body) {
      const usd = asObject(asObject(body)?.['usd']);
      return {
        usdIdr: positiveNumber(usd?.['idr']),
        xauUsd: invert(positiveNumber(usd?.['xau'])),
      };
    },
  },
];

/**
 * Bounds a promise with a hard timeout. Used as a safety net in addition to
 * `AbortSignal.timeout` so even a fetchImpl that ignores the signal cannot hang
 * a request beyond the source timeout.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fetch + parse one source. Never throws: any network error, non-2xx status,
 * invalid JSON, timeout, or unusable payload yields `null` (logged at warn).
 */
export async function fetchSource(
  def: SourceDef,
  fetchImpl: FetchLike,
  logger: Logger,
): Promise<SourceResult | null> {
  try {
    const body = await withTimeout(
      (async (): Promise<unknown> => {
        const res = await fetchImpl(def.url, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })(),
      SOURCE_TIMEOUT_MS,
      def.name,
    );
    const parsed = def.parse(body);
    if (parsed.usdIdr === null && parsed.xauUsd === null) {
      logger.warn('oracle source returned no usable rates', { source: def.name });
      return null;
    }
    return { name: def.name, ...parsed };
  } catch (err) {
    logger.warn('oracle source fetch failed', {
      source: def.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
