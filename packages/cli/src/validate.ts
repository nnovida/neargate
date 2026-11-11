import type { AgentGateMode } from '@agentgate/shared';
import { AgentGateError, isNearAccountId, stripTrailingSlashes } from '@agentgate/shared';

/** Control characters (C0 range + DEL) rejected from on-chain text fields. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** The registry's limits, in UTF-8 bytes as the contract counts them. Service name: */
export const MAX_NAME_BYTES = 64;
/** Service description: */
export const MAX_DESCRIPTION_BYTES = 280;
/** Gateway base URL: */
export const MAX_GATEWAY_URL_BYTES = 200;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function invalid(code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, 400);
}

/** Returns the trimmed string; throws AgentGateError('INVALID_INPUT') when empty/blank. */
export function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    throw invalid('INVALID_INPUT', `${label} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Validates a non-empty on-chain text field (e.g. service name): rejects control
 * characters and enforces the registry's UTF-8 byte limit, then returns the trimmed
 * string. These strings go on-chain unmodified, so keep them printable and bounded.
 */
export function requireSafeText(value: string | undefined, label: string, maxBytes: number): string {
  const trimmed = requireNonEmpty(value, label);
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw invalid('INVALID_INPUT', `${label} must not contain control characters`);
  }
  if (utf8Bytes(trimmed) > maxBytes) {
    throw invalid('INVALID_INPUT', `${label} must be at most ${maxBytes} bytes (UTF-8), got ${utf8Bytes(trimmed)}`);
  }
  return trimmed;
}

/**
 * Validates an optional on-chain text field (e.g. service description): rejects
 * control characters and enforces the registry's UTF-8 byte limit, returning the
 * trimmed string ('' when omitted/blank). Unlike requireSafeText, blank is allowed.
 */
export function optionalSafeText(value: string | undefined, label: string, maxBytes: number): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    return '';
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw invalid('INVALID_INPUT', `${label} must not contain control characters`);
  }
  if (utf8Bytes(trimmed) > maxBytes) {
    throw invalid('INVALID_INPUT', `${label} must be at most ${maxBytes} bytes (UTF-8), got ${utf8Bytes(trimmed)}`);
  }
  return trimmed;
}

/** Parses and returns a http(s) URL; throws AgentGateError('INVALID_URL') otherwise. */
export function requireHttpUrl(value: string, label: string): URL {
  const raw = requireNonEmpty(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid('INVALID_URL', `${label} must be a valid URL, got ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid(
      'INVALID_URL',
      `${label} must use http:// or https://, got ${parsed.protocol.replace(/:$/, '')}://`,
    );
  }
  return parsed;
}

/** Hostnames treated as loopback (a cleartext token never leaves the machine). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Validates a http(s) base URL (no query string / fragment) and returns it
 * trimmed with any trailing slashes stripped, ready for `${base}/svc/${id}` joins.
 *
 * `opts.requireHttpsInLiveMode`: when set, in live mode a non-loopback host MUST
 * use https:// — the upstream URL and the mapping credentials are POSTed to this
 * base, and cleartext http would expose them on the wire.
 * `opts.maxBytes`: the normalized URL's UTF-8 byte limit (INVALID_URL above it).
 */
export function normalizeBaseUrl(
  value: string,
  label: string,
  opts: { mode?: AgentGateMode; requireHttpsInLiveMode?: boolean; maxBytes?: number } = {},
): string {
  const parsed = requireHttpUrl(value, label);
  if (parsed.search !== '' || parsed.hash !== '') {
    throw invalid('INVALID_URL', `${label} must not contain a query string or fragment`);
  }
  if (
    opts.requireHttpsInLiveMode &&
    opts.mode === 'live' &&
    parsed.protocol !== 'https:' &&
    !isLoopbackHost(parsed.hostname)
  ) {
    throw invalid(
      'INSECURE_URL',
      `${label} must use https:// in live mode for non-localhost hosts (the mapping request is sent there in cleartext over http), got ${parsed.protocol.replace(/:$/, '')}://${parsed.hostname}`,
    );
  }
  const normalized = stripTrailingSlashes(value.trim());
  if (opts.maxBytes !== undefined && utf8Bytes(normalized) > opts.maxBytes) {
    throw invalid('INVALID_URL', `${label} must be at most ${opts.maxBytes} bytes, got ${utf8Bytes(normalized)}`);
  }
  return normalized;
}

/** Validates a NEAR account id (e.g. `seller.testnet`) and returns it trimmed. */
export function requireAccountId(value: string, label: string): string {
  const trimmed = requireNonEmpty(value, label);
  if (!isNearAccountId(trimmed)) {
    throw invalid(
      'INVALID_ACCOUNT_ID',
      `${label} must be a NEAR account id (e.g. "seller.testnet"), got ${JSON.stringify(value)}`,
    );
  }
  return trimmed;
}
