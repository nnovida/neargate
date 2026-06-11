import { AgentGateError } from '@agentgate/shared';

/** `account-hash-` + 64 hex chars (SPEC §2 ServiceRecord.paymentTarget). */
const ACCOUNT_HASH_RE = /^account-hash-[0-9a-fA-F]{64}$/;

/** Casper public key hex: ed25519 = "01"+64 hex, secp256k1 = "02"+66 hex. */
const PUBLIC_KEY_RE = /^(?:01[0-9a-fA-F]{64}|02[0-9a-fA-F]{66})$/;

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

/**
 * Validates a http(s) base URL (no query string / fragment) and returns it
 * trimmed with any trailing slashes stripped, ready for `${base}/svc/${id}` joins.
 */
export function normalizeBaseUrl(value: string, label: string): string {
  const parsed = requireHttpUrl(value, label);
  if (parsed.search !== '' || parsed.hash !== '') {
    throw invalid('INVALID_URL', `${label} must not contain a query string or fragment`);
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
