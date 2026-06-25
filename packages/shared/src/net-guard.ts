/**
 * SSRF host guards shared by every component that makes an outbound request to
 * a user/seller-controlled URL (the middleware proxy, the buyer-agent's pay
 * client). Kept in a SUBPATH module (`@agentgate/shared/net-guard`) — NOT
 * re-exported from the package index — because it imports `node:dns`/`node:net`
 * and must never be pulled into a browser bundle (the dashboard imports the
 * package index from client components).
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Max accepted length for an upstream URL string. */
export const MAX_URL_LENGTH = 2048;

export type HttpUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; error: 'invalid_url' | 'forbidden_host' };

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes as [number, number, number, number];
}

/** True for IPv4 literals in loopback/private/link-local/CGNAT/reserved ranges. */
export function isPrivateIPv4(host: string): boolean {
  const bytes = parseIpv4(host);
  if (!bytes) return false;
  const [o0, o1] = bytes;
  if (o0 === 0 || o0 === 10 || o0 === 127) return true; // "this", private, loopback
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true; // 100.64.0.0/10 CGNAT
  if (o0 === 169 && o1 === 254) return true; // link-local (cloud metadata)
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true; // 172.16.0.0/12
  if (o0 === 192 && o1 === 168) return true; // 192.168.0.0/16
  if (o0 === 192 && o1 === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24 (doc)
  if (o0 === 198 && (o1 === 18 || o1 === 19)) return true; // benchmark
  if (o0 >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** True for IPv6 literals that are loopback/unspecified/ULA/link-local/v4-mapped-private. */
export function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (h.startsWith('::ffff:')) {
    // IPv4-mapped: either "::ffff:1.2.3.4" or canonical "::ffff:102:304".
    const rest = h.slice('::ffff:'.length);
    if (rest.includes('.')) return isPrivateIPv4(rest);
    const groups = rest.split(':');
    if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const hi = parseInt(groups[0] ?? '0', 16);
      const lo = parseInt(groups[1] ?? '0', 16);
      return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return true; // unparseable mapped form — be conservative
  }
  return false;
}

/**
 * True when a URL hostname must be rejected by the SSRF guard: localhost names,
 * loopback, RFC1918/ULA/link-local/CGNAT IP literals, etc. Public DNS names pass
 * (DNS is not resolved here — see {@link resolvedHostIsPublic} for fetch-time).
 */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 brackets
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIPv4(host);
  if (ipVersion === 6) return isPrivateIPv6(host);
  return false;
}

/**
 * Fetch-time SSRF re-check that defeats DNS rebinding / TOCTOU: a hostname that
 * was public when it was registered can later be re-pointed at a private address
 * (169.254.169.254, 127.0.0.1, RFC1918, ...). We resolve the hostname here,
 * immediately before connecting, and refuse if ANY resolved address is private.
 * IP literals are decided synchronously (no DNS query). Returns false (refuse)
 * on resolution failure.
 *
 * Note: Node's global fetch resolves DNS again internally, so a sub-millisecond
 * re-resolution race remains; closing it fully needs connection-level IP pinning
 * (a custom undici dispatcher). This still closes the practical "rebind after
 * registration" attack.
 */
export async function resolvedHostIsPublic(hostname: string): Promise<boolean> {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return false;
  const literal = isIP(host);
  if (literal === 4) return !isPrivateIPv4(host);
  if (literal === 6) return !isPrivateIPv6(host);
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return false; // unresolvable → refuse
  }
  if (addresses.length === 0) return false;
  for (const { address, family } of addresses) {
    const isPrivate = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
    if (isPrivate) return false;
  }
  return true;
}

/**
 * Validates an arbitrary http(s) URL string:
 * - parses as a URL with protocol http:/https: and no embedded credentials,
 * - when `rejectPrivateHosts`, the literal hostname must not be private/loopback.
 *
 * The WHATWG URL parser canonicalises exotic IPv4 spellings (e.g.
 * `http://2130706433` → `127.0.0.1`), so decimal/hex bypass tricks are caught by
 * the literal-IP checks.
 */
export function validateHttpUrl(
  raw: unknown,
  opts: { rejectPrivateHosts: boolean },
): HttpUrlValidation {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, error: 'invalid_url' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.hostname === '') return { ok: false, error: 'invalid_url' };
  if (opts.rejectPrivateHosts && isPrivateHost(url.hostname)) {
    return { ok: false, error: 'forbidden_host' };
  }
  return { ok: true, url };
}
