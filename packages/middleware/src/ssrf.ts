// SSRF host primitives now live in @agentgate/shared/net-guard so the middleware
// proxy and the buyer-agent's pay client share one implementation. This module
// keeps the middleware-specific admin validator and re-exports the primitives so
// existing imports (and tests) keep working.
import {
  isPrivateHost,
  isPrivateIPv4,
  isPrivateIPv6,
  resolvedHostIsPublic,
  resolvePinnedIp,
  validateHttpUrl,
} from '@agentgate/shared/net-guard';

export { isPrivateHost, isPrivateIPv4, isPrivateIPv6, resolvedHostIsPublic, resolvePinnedIp };

export type UpstreamUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; error: 'invalid_upstream_url' | 'forbidden_upstream_host' };

/**
 * Validates an upstream URL for the admin API. Thin wrapper over the shared
 * {@link validateHttpUrl} that maps the generic error codes to the gateway's
 * stable `invalid_upstream_url` / `forbidden_upstream_host` codes.
 */
export function validateUpstreamUrl(
  raw: unknown,
  opts: { rejectPrivateHosts: boolean },
): UpstreamUrlValidation {
  const result = validateHttpUrl(raw, opts);
  if (result.ok) return { ok: true, url: result.url };
  return {
    ok: false,
    error: result.error === 'forbidden_host' ? 'forbidden_upstream_host' : 'invalid_upstream_url',
  };
}
