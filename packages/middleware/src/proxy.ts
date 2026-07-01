import { Agent } from 'undici';
import type { Request } from 'express';
import { resolvePinnedIp } from './ssrf';

/** Hard cap on proxied bodies in BOTH directions: 1 MiB. */
export const MAX_PROXY_BODY_BYTES = 1024 * 1024;

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) — never forwarded in either direction.
 * Forwarding is whitelist-based, so this list is enforced by construction;
 * it is exported for documentation/tests.
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
];

/**
 * End-to-end request headers we forward to the upstream. Whitelist only:
 * payment proof headers, cookies, authorization, host, x-forwarded-* etc.
 * never reach the upstream.
 */
const FORWARDED_REQUEST_HEADERS: readonly string[] = ['accept', 'accept-language', 'user-agent'];

export type ProxyFailureCode =
  | 'upstream_timeout'
  | 'upstream_unreachable'
  | 'upstream_response_too_large'
  | 'upstream_request_too_large';

export type ProxyOutcome =
  | { kind: 'response'; status: number; contentType: string | null; body: Buffer }
  | { kind: 'failure'; status: 502 | 504; error: ProxyFailureCode };

export interface ProxyOptions {
  upstreamUrl: string;
  req: Request;
  timeoutMs: number;
  /**
   * Follow upstream redirects (mock mode convenience). Live mode keeps this
   * false so a public upstream cannot redirect the gateway into a private
   * network; the 3xx status passes through WITHOUT the Location header.
   */
  followRedirects: boolean;
  /**
   * Pin the connection to a vetted public IP (live mode), closing the
   * DNS-rebinding TOCTOU between the app-level SSRF re-check and this fetch (F6).
   * Off in mock so localhost demo upstreams work.
   */
  pinToPublicIp: boolean;
}

/** True when the upstream answered with a 2xx — the attestation success flag. */
export function isUpstreamSuccess(outcome: ProxyOutcome): boolean {
  return outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300;
}

function buildTargetUrl(upstreamUrl: string, req: Request): URL {
  const url = new URL(upstreamUrl);
  const queryIndex = req.originalUrl.indexOf('?');
  if (queryIndex !== -1) {
    const rawQuery = req.originalUrl.slice(queryIndex + 1);
    if (rawQuery !== '') {
      url.search = url.search === '' ? rawQuery : `${url.search.slice(1)}&${rawQuery}`;
    }
  }
  return url;
}

/** Reads a fetch Response body, returning null when it exceeds `maxBytes`. */
async function readBodyCapped(res: globalThis.Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Forwards an already-paid request to the seller's upstream:
 * - query string + JSON body forwarded, method preserved
 * - whitelist header forwarding (hop-by-hop and sensitive headers stripped)
 * - `AbortSignal.timeout(timeoutMs)` enforced
 * - 1 MiB body cap in both directions
 * - NEVER throws and NEVER leaks the upstream URL: failures collapse into
 *   constant-string error codes.
 */
export async function proxyToUpstream(opts: ProxyOptions): Promise<ProxyOutcome> {
  const url = buildTargetUrl(opts.upstreamUrl, opts.req);
  const method = opts.req.method.toUpperCase();

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = opts.req.header(name);
    if (value) headers.set(name, value);
  }

  let body: string | undefined;
  if (
    method !== 'GET' &&
    method !== 'HEAD' &&
    opts.req.is('application/json') &&
    typeof opts.req.body === 'object' &&
    opts.req.body !== null
  ) {
    body = JSON.stringify(opts.req.body);
    if (Buffer.byteLength(body) > MAX_PROXY_BODY_BYTES) {
      return { kind: 'failure', status: 502, error: 'upstream_request_too_large' };
    }
    headers.set('content-type', 'application/json');
  }

  // Live mode: pin the connection to a vetted public IP so a DNS rebind between
  // the app-level SSRF re-check and this fetch cannot land on a private address
  // (F6). resolvePinnedIp refuses (null) private/unresolvable hosts. undici's
  // connector `lookup` callback uses the all-form: cb(null, [{ address, family }]).
  let dispatcher: Agent | undefined;
  if (opts.pinToPublicIp) {
    const pinned = await resolvePinnedIp(url.hostname);
    if (!pinned) return { kind: 'failure', status: 502, error: 'upstream_unreachable' };
    try {
      dispatcher = new Agent({
        connect: {
          lookup: (_hostname, _options, cb) => cb(null, [{ address: pinned.address, family: pinned.family }]),
        },
      });
    } catch {
      // undici unavailable — fall back to the app-level re-resolution guard.
      dispatcher = undefined;
    }
  }

  const init: RequestInit & { dispatcher?: unknown } = {
    method,
    headers,
    body,
    redirect: opts.followRedirects ? 'follow' : 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs),
  };
  if (dispatcher) init.dispatcher = dispatcher;

  try {
    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(url, init);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { kind: 'failure', status: 504, error: 'upstream_timeout' };
      }
      return { kind: 'failure', status: 502, error: 'upstream_unreachable' };
    }

    let bodyBuffer: Buffer | null;
    try {
      bodyBuffer = await readBodyCapped(upstreamRes, MAX_PROXY_BODY_BYTES);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return name === 'TimeoutError' || name === 'AbortError'
        ? { kind: 'failure', status: 504, error: 'upstream_timeout' }
        : { kind: 'failure', status: 502, error: 'upstream_unreachable' };
    }
    if (bodyBuffer === null) {
      return { kind: 'failure', status: 502, error: 'upstream_response_too_large' };
    }

    return {
      kind: 'response',
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get('content-type'),
      body: bodyBuffer,
    };
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => undefined);
  }
}
