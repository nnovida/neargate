import { isIP } from 'node:net';

/** Max accepted length for an upstream URL string. */
const MAX_URL_LENGTH = 2048;

export type UpstreamUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; error: 'invalid_upstream_url' | 'forbidden_upstream_host' };

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
 * True when a URL hostname must be rejected by the live-mode SSRF guard:
 * localhost names, loopback, RFC1918/ULA/link-local/CGNAT IP literals, etc.
 * Public DNS names pass (we do not resolve DNS at registration time).
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
 * Validates an upstream URL for the admin API:
 * - must parse as a URL with protocol http: or https: (no embedded credentials)
 * - when `rejectPrivateHosts` (live mode) the host must not be private/loopback.
 *
 * Note: the WHATWG URL parser canonicalises exotic IPv4 spellings
 * (e.g. `http://2130706433` → host `127.0.0.1`), so decimal/hex bypass
 * tricks are caught by the literal-IP checks.
 */
export function validateUpstreamUrl(
  raw: unknown,
  opts: { rejectPrivateHosts: boolean },
): UpstreamUrlValidation {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, error: 'invalid_upstream_url' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid_upstream_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'invalid_upstream_url' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'invalid_upstream_url' };
  }
  if (url.hostname === '') return { ok: false, error: 'invalid_upstream_url' };
  if (opts.rejectPrivateHosts && isPrivateHost(url.hostname)) {
    return { ok: false, error: 'forbidden_upstream_host' };
  }
  return { ok: true, url };
}
