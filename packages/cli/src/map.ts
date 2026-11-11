import { RedirectRefusedError, refuseRedirect } from '@agentgate/client';
import type { AgentGateMode, AnySigner, ChainClient, NearNetwork } from '@agentgate/shared';
import { AgentGateError, buildSelfMapMessage, formatError, isNearAccountId } from '@agentgate/shared';
import { loadNearSigner, type LoadedNearSigner } from './identity';
import type { FetchLike } from './types';
import { normalizeBaseUrl, requireHttpUrl } from './validate';

/**
 * The gateway upstream mapping, shared by `neargate wrap` (its step 2, right after the
 * on-chain registration) and `neargate map` (that step alone, for a service that is already
 * registered — e.g. when `wrap` registered it but could not reach the gateway).
 */

/** Timeout of one mapping POST when none is supplied (ms). */
export const DEFAULT_MAPPING_TIMEOUT_MS = 15_000;

/** Single-quote a string for POSIX shells (embedded quotes become '\''). */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exact curl to (re)create the gateway upstream mapping through the admin route (mock).
 * References $AGENTGATE_ADMIN_TOKEN instead of inlining the token so no secret is printed.
 */
export function adminRetryCurl(adminUrl: string, serviceId: number, upstreamUrl: string): string {
  return [
    `curl -X POST ${shellSingleQuote(adminUrl)}`,
    `-H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN"`,
    `-H 'Content-Type: application/json'`,
    `-d ${shellSingleQuote(JSON.stringify({ serviceId, upstreamUrl }))}`,
  ].join(' ');
}

/**
 * The exact `neargate map` that retries a failed self-map, ready to paste: the key file is
 * named when the key came from one (a *_PRIVATE_KEY in the environment is picked up again on
 * its own) and the registry when the chain client names one.
 */
export function selfMapRetryCommand(opts: {
  serviceId: number;
  upstreamUrl: string;
  accountId: string;
  keyPath?: string;
  registryId?: string;
}): string {
  return [
    'neargate map',
    String(opts.serviceId),
    shellSingleQuote(opts.upstreamUrl),
    `--account ${opts.accountId}`,
    ...(opts.keyPath !== undefined ? [`--key-file ${shellSingleQuote(opts.keyPath)}`] : []),
    ...(opts.registryId !== undefined && isNearAccountId(opts.registryId) ? [`--registry ${opts.registryId}`] : []),
  ].join(' ');
}

/**
 * POSTs one mapping request. Returns undefined when the gateway mapped it (2xx), else what
 * failed. A redirect is never followed: the request carries the private upstream URL (and an
 * admin token or a signed challenge), so it only ever goes to the gateway URL itself.
 */
async function postMapping(url: string, init: RequestInit, timeoutMs: number, fetchImpl: FetchLike): Promise<string | undefined> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await refuseRedirect(url, res);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      return `gateway answered HTTP ${res.status}${body ? ` — ${body}` : ''}`;
    }
    return undefined;
  } catch (err) {
    if (err instanceof RedirectRefusedError) {
      return `gateway answered HTTP ${err.status}, a redirect (never followed: the mapping goes to the gateway URL itself only)`;
    }
    const name = err instanceof Error ? err.name : '';
    return name === 'TimeoutError' || name === 'AbortError'
      ? `request timed out after ${timeoutMs}ms`
      : `request failed — ${formatError(err)}`;
  }
}

export interface SelfMapPostOpts {
  /** Normalized gateway base URL (no trailing slash). */
  gatewayBase: string;
  serviceId: number;
  /** The trimmed, validated upstream URL; signed and sent byte for byte. */
  upstreamUrl: string;
  /** The owner's resolved NEAR key. */
  key: LoadedNearSigner;
  /** The chain network bound into the signature (`chain.network`). */
  network: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}

/**
 * The NEAR-key self-map, the one request `wrap` (live) and `map` send: POST
 * `<gateway>/services/<id>/map` with `{upstreamUrl, accountId, publicKey, signature,
 * timestamp}`, where the signature (base64 ed25519 from the owner's full-access key) covers
 * `buildSelfMapMessage` for this network, service, upstream URL and timestamp. No admin token.
 * Returns undefined when the gateway mapped it, else what failed.
 */
export async function postSelfMap(opts: SelfMapPostOpts): Promise<string | undefined> {
  const { gatewayBase, serviceId, upstreamUrl, key } = opts;
  const timestamp = Date.now();
  const message = buildSelfMapMessage({ network: opts.network, serviceId, upstreamUrl, timestamp });
  return postMapping(
    `${gatewayBase}/services/${serviceId}/map`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upstreamUrl,
        accountId: key.signer.accountId,
        publicKey: key.publicKey,
        signature: key.sign(message),
        timestamp,
      }),
    },
    opts.timeoutMs,
    opts.fetchImpl,
  );
}

/**
 * The admin-token mapping (mock mode): POST `<gateway>/admin/services` with `{serviceId,
 * upstreamUrl}` and the admin Bearer token. Returns undefined when mapped, else what failed.
 */
export async function postAdminMap(opts: {
  gatewayBase: string;
  serviceId: number;
  upstreamUrl: string;
  adminToken: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
}): Promise<string | undefined> {
  return postMapping(
    `${opts.gatewayBase}/admin/services`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serviceId: opts.serviceId, upstreamUrl: opts.upstreamUrl }),
    },
    opts.timeoutMs,
    opts.fetchImpl,
  );
}

/**
 * LIVE_ONLY for `map` with a mock signer or outside live mode: the mock gateway maps an
 * upstream through its admin route, which `wrap` does itself. `retryCurl`, when the caller
 * knows the gateway, is that admin POST ready to paste.
 */
export function mapLiveOnlyError(retryCurl?: string): AgentGateError {
  return new AgentGateError(
    'LIVE_ONLY',
    '`neargate map` signs the mapping with your NEAR key, so it runs in live mode only. In mock mode the gateway ' +
      'maps an upstream through its admin route (POST <gateway>/admin/services with AGENTGATE_ADMIN_TOKEN), which ' +
      '`neargate wrap` does for you' +
      (retryCurl !== undefined ? `; to retry it:\n  ${retryCurl}` : '.'),
    400,
  );
}

export interface MapServiceOpts {
  /** The registered service to map (1-based). */
  serviceId: number;
  /** Upstream API URL. Kept private: only ever sent to the gateway. */
  upstreamUrl: string;
  chain: ChainClient;
  /** The service owner. A NEAR key signer; a mock signer is refused with LIVE_ONLY. */
  signer: AnySigner;
  /** Runtime mode; in 'live' (the default) a non-localhost gateway must use https://. */
  mode?: AgentGateMode;
  /** NEAR network whose `~/.near-credentials` holds the owner's key file. Default 'testnet'. */
  nearNetwork?: NearNetwork;
  /** Network bound into the self-map signature. Defaults to `chain.network`. */
  network?: string;
  /** Timeout (ms) of the mapping POST. Defaults to DEFAULT_MAPPING_TIMEOUT_MS. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface MapServiceResult {
  serviceId: number;
  /** The gateway that mapped it: the base URL the registry records for the service. */
  gateway: string;
  /** The service's public endpoint, `<gateway>/svc/<id>`, which now serves. */
  publicUrl: string;
}

/**
 * Programmatic `neargate map <id> <upstream>`: re-runs ONLY the gateway mapping step of `wrap`
 * (the same `postSelfMap` request) for a service that is already registered. Never registers.
 *
 * Validates the id, the upstream URL and the owner's NEAR key first (INVALID_SERVICE_ID,
 * INVALID_URL, SIGNER_*), then reads the service on chain (SERVICE_NOT_FOUND), checks the
 * signer owns it (NOT_SERVICE_OWNER) and maps it at the gateway the registry records for it:
 * `endpointUrl` is `<gateway>/svc/<id>`. A mock signer → LIVE_ONLY; a gateway that does not
 * map it (non-2xx, redirect, network error, timeout) → MAPPING_FAILED.
 */
export async function mapService(opts: MapServiceOpts): Promise<MapServiceResult> {
  const { serviceId, chain } = opts;
  if (!Number.isSafeInteger(serviceId) || serviceId < 1) {
    throw new AgentGateError('INVALID_SERVICE_ID', `service id must be a positive integer, got ${String(serviceId)}`, 400);
  }
  requireHttpUrl(opts.upstreamUrl, 'upstreamUrl');
  const upstreamUrl = opts.upstreamUrl.trim();
  if (opts.signer.kind !== 'near') {
    throw mapLiveOnlyError();
  }
  const key = await loadNearSigner({
    accountId: opts.signer.accountId,
    network: opts.nearNetwork ?? 'testnet',
    ...(opts.signer.secretKey !== undefined ? { secretKey: opts.signer.secretKey } : {}),
    ...(opts.signer.keyPath !== undefined ? { keyPath: opts.signer.keyPath } : {}),
  });

  const service = await chain.getService(serviceId);
  if (service === null) {
    throw new AgentGateError('SERVICE_NOT_FOUND', `service ${serviceId} not found on ${chain.network}`, 404);
  }
  if (service.owner !== key.signer.accountId) {
    throw new AgentGateError(
      'NOT_SERVICE_OWNER',
      `service ${serviceId} is owned by ${service.owner}, not ${key.signer.accountId} — only the owner's full-access key can map it`,
      403,
    );
  }
  const suffix = `/svc/${serviceId}`;
  if (!service.endpointUrl.endsWith(suffix)) {
    throw new AgentGateError(
      'INVALID_URL',
      `service ${serviceId} has no <gateway>${suffix} endpoint on chain: ${JSON.stringify(service.endpointUrl.slice(0, 200))}`,
      502,
    );
  }
  // The upstream URL and a signed challenge go to this gateway: https:// off localhost in live mode.
  const gatewayBase = normalizeBaseUrl(service.endpointUrl.slice(0, -suffix.length), 'the registered gateway', {
    mode: opts.mode ?? 'live',
    requireHttpsInLiveMode: true,
  });

  const failure = await postSelfMap({
    gatewayBase,
    serviceId,
    upstreamUrl,
    key,
    network: opts.network ?? chain.network,
    timeoutMs: opts.timeoutMs ?? DEFAULT_MAPPING_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl ?? ((u, i) => fetch(u, i)),
  });
  if (failure !== undefined) {
    throw new AgentGateError('MAPPING_FAILED', `gateway upstream mapping for service ${serviceId} failed: ${failure}`, 502);
  }
  return { serviceId, gateway: gatewayBase, publicUrl: `${gatewayBase}${suffix}` };
}
