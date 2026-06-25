import type { AgentGateMode } from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';

/** `account-hash-` + 64 hex chars (SPEC §2 ServiceRecord.paymentTarget). */
const ACCOUNT_HASH_RE = /^account-hash-[0-9a-fA-F]{64}$/;

/** Casper public key hex: ed25519 = "01"+64 hex, secp256k1 = "02"+66 hex. */
const PUBLIC_KEY_RE = /^(?:01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/;

/** Control characters (C0 range + DEL) rejected from on-chain text fields. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** Max length of the on-chain service name. */
export const MAX_NAME_LENGTH = 128;
/** Max length of the on-chain service description. */
export const MAX_DESCRIPTION_LENGTH = 512;

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
 * characters and enforces a max length, then returns the trimmed string. These
 * strings go on-chain unmodified, so keep them printable and bounded.
 */
export function requireSafeText(value: string | undefined, label: string, maxLength: number): string {
  const trimmed = requireNonEmpty(value, label);
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw invalid('INVALID_INPUT', `${label} must not contain control characters`);
  }
  if (trimmed.length > maxLength) {
    throw invalid('INVALID_INPUT', `${label} must be at most ${maxLength} characters, got ${trimmed.length}`);
  }
  return trimmed;
}

/**
 * Validates an optional on-chain text field (e.g. service description): rejects
 * control characters and enforces a max length, returning the trimmed string
 * ('' when omitted/blank). Unlike requireSafeText, blank is allowed.
 */
export function optionalSafeText(value: string | undefined, label: string, maxLength: number): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    return '';
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw invalid('INVALID_INPUT', `${label} must not contain control characters`);
  }
  if (trimmed.length > maxLength) {
    throw invalid('INVALID_INPUT', `${label} must be at most ${maxLength} characters, got ${trimmed.length}`);
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
 * use https:// — the admin Bearer token is POSTed to this base, and cleartext
 * http would expose it on the wire.
 */
export function normalizeBaseUrl(
  value: string,
  label: string,
  opts: { mode?: AgentGateMode; requireHttpsInLiveMode?: boolean } = {},
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
      `${label} must use https:// in live mode for non-localhost hosts (the admin token is sent there in cleartext over http), got ${parsed.protocol.replace(/:$/, '')}://${parsed.hostname}`,
    );
  }
  return value.trim().replace(/\/+$/, '');
}

/** Validates an `account-hash-<64 hex>` string and returns it trimmed. */
export function requireAccountHash(value: string, label: string): string {
  const trimmed = requireNonEmpty(value, label);
  if (!ACCOUNT_HASH_RE.test(trimmed)) {
    throw invalid(
      'INVALID_ACCOUNT_HASH',
      `${label} must look like "account-hash-<64 hex chars>", got ${JSON.stringify(value)}`,
    );
  }
  return trimmed;
}

/** Validates a Casper public key hex ("01…"/"02…") and returns it trimmed. */
export function requirePublicKeyHex(value: string, label: string): string {
  const trimmed = requireNonEmpty(value, label);
  if (!PUBLIC_KEY_RE.test(trimmed)) {
    throw invalid(
      'INVALID_PUBLIC_KEY',
      `${label} must be a Casper public key hex ("01"+64 hex or "02"+66 hex), got ${JSON.stringify(value)}`,
    );
  }
  return trimmed;
}
