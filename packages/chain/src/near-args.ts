import { AgentGateError, isNearAccountId } from '@agentgate/shared';
import type { AnySigner, NearKeySigner } from '@agentgate/shared';

// Argument and config checks of LiveNearClient, kept apart from the client so it stays about the
// registry. Each throws an AgentGateError before any RPC is touched.

/** The largest `limit` a list read accepts, as on the devnet's REST API. */
export const MAX_QUERY_LIMIT = 1000;

export function configInvalid(message: string): AgentGateError {
  return new AgentGateError('CONFIG_INVALID', message, 500);
}

/** `value` as an http(s) URL string, or CONFIG_INVALID naming the setting. */
export function httpUrl(value: unknown, setting: string): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw configInvalid(`${setting} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw configInvalid(`${setting} must be http(s)`);
  return String(value);
}

/** The mock's code for a malformed account id (the devnet's ERR_INVALID_ACCOUNT_ID). */
export function assertAccountId(value: unknown, field: string): void {
  if (!isNearAccountId(value)) {
    throw new AgentGateError(
      'ERR_INVALID_ACCOUNT_ID',
      `ERR_INVALID_ACCOUNT_ID: ${field} is not a valid NEAR account id`,
      400,
    );
  }
}

export function checkLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new AgentGateError('invalid_limit', `"limit" must be between 1 and ${MAX_QUERY_LIMIT}`, 400);
  }
  return limit;
}

export function requireNearSigner(signer: AnySigner): NearKeySigner {
  if (signer.kind !== 'near') {
    throw new AgentGateError(
      'invalid_signer',
      `LiveNearClient requires a near signer, got "${String((signer as { kind?: unknown }).kind)}"`,
      400,
    );
  }
  assertAccountId(signer.accountId, 'signer');
  return signer;
}
