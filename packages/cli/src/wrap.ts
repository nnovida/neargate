import type {
  AgentGateMode,
  AnySigner,
  ChainClient,
  NearNetwork,
  RegisterServiceInput,
  Yocto,
} from '@agentgate/shared';
import {
  AgentGateError,
  MIN_PRICE_YOCTO,
  compareYocto,
  formatNear,
  nearToYocto,
} from '@agentgate/shared';
import { loadNearSigner, signerAccountId, type LoadedNearSigner } from './identity';
import {
  DEFAULT_MAPPING_TIMEOUT_MS,
  adminRetryCurl,
  postAdminMap,
  postSelfMap,
  selfMapRetryCommand,
} from './map';
import type { FetchLike } from './types';
import {
  MAX_DESCRIPTION_BYTES,
  MAX_GATEWAY_URL_BYTES,
  MAX_NAME_BYTES,
  normalizeBaseUrl,
  optionalSafeText,
  requireAccountId,
  requireHttpUrl,
  requireNonEmpty,
  requireSafeText,
} from './validate';

/** Where the dashboard detail link points when not overridden. */
export const DEFAULT_DASHBOARD_BASE_URL = 'http://localhost:3000';

export interface WrapServiceOpts {
  /** Upstream API URL to wrap. Kept private — only ever sent to the gateway admin API. */
  upstreamUrl: string;
  /** Price per call in NEAR (decimal string, max 24 dp, at least the registry minimum 0.000001). */
  priceNear: string;
  name: string;
  description?: string;
  /** Gateway base URL; the canonical public endpoint becomes `<gateway>/svc/<id>`. */
  gateway: string;
  /** NEAR account id that receives the price; defaults to the signer's account. */
  paymentTarget?: string;
  /** NEAR account id allowed to record attestations; defaults to the signer's account. */
  attestor?: string;
  /** Base URL for the printed dashboard link (default http://localhost:3000). */
  dashboardBaseUrl?: string;
  chain: ChainClient;
  /**
   * The seller. A NEAR key signer (live) maps the upstream through the gateway's self-map route
   * with a signature from its key; a mock signer uses the admin-token route.
   */
  signer: AnySigner;
  /** Bearer token for `POST <gateway>/admin/services` — required with a mock signer only. */
  adminToken?: string;
  /** Runtime mode; in 'live' a non-localhost gateway must use https://. */
  mode?: AgentGateMode;
  /** Network bound into the self-map signature. Defaults to `chain.network`. */
  network?: string;
  /** NEAR network whose `~/.near-credentials` holds the seller key file. Default 'testnet'. */
  nearNetwork?: NearNetwork;
  /** Timeout (ms) for the mapping POST. Defaults to DEFAULT_MAPPING_TIMEOUT_MS (15 s). */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface WrapServiceResult {
  serviceId: number;
  /** Hash of the on-chain `register_service` tx. */
  txHash: string;
  /** Canonical public endpoint: `<gateway>/svc/<serviceId>`. */
  publicUrl: string;
  /** Dashboard detail page, e.g. http://localhost:3000/services/<id>. */
  dashboardUrl: string;
  /** false when the gateway upstream mapping failed (registration is still live on-chain). */
  adminOk: boolean;
  /** Present when adminOk is false: what failed + the exact retry (`neargate map`, or the admin curl in mock). */
  adminWarning?: string;
}

/**
 * Programmatic `neargate wrap` (used by scripts/demo.ts and the bin):
 *
 * 1. Validates everything and, with a NEAR key signer, resolves the seller key and
 *    checks the payment target exists on chain — all before any side effect.
 * 2. Registers the service on-chain. The registry stores the **gateway base URL**
 *    (`gatewayBaseUrl`) and every reader computes `endpointUrl = <gateway>/svc/<id>`.
 * 3. Maps the upstream at the gateway (map.ts): a NEAR key signer POSTs a signed
 *    `{upstreamUrl, accountId, publicKey, signature, timestamp}` to
 *    `<gateway>/services/<id>/map` (`postSelfMap`, the request `neargate map` re-sends);
 *    a mock signer POSTs `{serviceId, upstreamUrl}` to `<gateway>/admin/services` with
 *    the admin Bearer token. A redirect is never followed. If this step fails the
 *    on-chain registration is NOT rolled back: a precise warning naming the retry
 *    (`neargate map …`, or the admin curl) is printed to stderr and returned as
 *    `adminWarning`.
 */
export async function wrapService(opts: WrapServiceOpts): Promise<WrapServiceResult> {
  // -- validation (fail fast, before any side effect) ------------------------
  const name = requireSafeText(opts.name, 'name', MAX_NAME_BYTES);
  const description = optionalSafeText(opts.description, 'description', MAX_DESCRIPTION_BYTES);
  requireHttpUrl(opts.upstreamUrl, 'upstreamUrl');
  const upstreamUrl = opts.upstreamUrl.trim();
  // The upstream URL (and, on the admin route, the admin token) is POSTed to the
  // gateway, so reject cleartext http to a non-localhost gateway in live mode.
  const gatewayBase = normalizeBaseUrl(opts.gateway, 'gateway', {
    mode: opts.mode,
    requireHttpsInLiveMode: true,
    maxBytes: MAX_GATEWAY_URL_BYTES,
  });
  const dashboardBase = normalizeBaseUrl(
    opts.dashboardBaseUrl ?? DEFAULT_DASHBOARD_BASE_URL,
    'dashboardBaseUrl',
  );
  // near signer → owner-signature self-map (no admin token); mock signer → admin token.
  // (In production near ⟺ live and mock ⟺ mock; keying off the signer keeps a mock
  //  signer out of the self-map path even when mode is forced to 'live'.)
  const useSelfMap = opts.signer.kind === 'near';
  const adminToken = useSelfMap ? '' : requireNonEmpty(opts.adminToken, 'adminToken');

  const priceYocto: Yocto = nearToYocto(opts.priceNear);
  if (compareYocto(priceYocto, MIN_PRICE_YOCTO) < 0) {
    throw new AgentGateError(
      'INVALID_PRICE',
      `price must be at least ${formatNear(MIN_PRICE_YOCTO)} (the registry minimum), got ${JSON.stringify(opts.priceNear)}`,
      400,
    );
  }

  const paymentTarget =
    opts.paymentTarget !== undefined
      ? requireAccountId(opts.paymentTarget, 'paymentTarget')
      : signerAccountId(opts.signer);
  const attestor =
    opts.attestor !== undefined
      ? requireAccountId(opts.attestor, 'attestor')
      : signerAccountId(opts.signer);

  // Live: prove we can sign the mapping, and that the payment target exists, BEFORE
  // registering — the registry forwards every price to that account, and a missing one
  // would strand the funds.
  let nearKey: LoadedNearSigner | undefined;
  if (opts.signer.kind === 'near') {
    nearKey = await loadNearSigner({
      accountId: opts.signer.accountId,
      network: opts.nearNetwork ?? 'testnet',
      ...(opts.signer.secretKey !== undefined ? { secretKey: opts.signer.secretKey } : {}),
      ...(opts.signer.keyPath !== undefined ? { keyPath: opts.signer.keyPath } : {}),
    });
    if (!(await opts.chain.accountExists(paymentTarget))) {
      throw new AgentGateError(
        'ACCOUNT_NOT_FOUND',
        `payment target ${paymentTarget} does not exist on ${opts.chain.network} — create it (or pass --payment-target <existing account>) before wrapping`,
        400,
      );
    }
  }

  // -- step 1: on-chain registration -----------------------------------------
  const input: RegisterServiceInput = {
    name,
    description,
    gatewayBaseUrl: gatewayBase, // readers compute <base>/svc/<id>
    priceYocto,
    paymentTarget,
    attestor,
  };
  const { serviceId, txHash } = await opts.chain.registerService(input, nearKey?.signer ?? opts.signer);

  const publicUrl = `${gatewayBase}/svc/${serviceId}`;
  const dashboardUrl = `${dashboardBase}/services/${serviceId}`;

  // -- step 2: gateway upstream mapping ---------------------------------------
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MAPPING_TIMEOUT_MS;
  const adminFailure =
    nearKey !== undefined
      ? await postSelfMap({
          gatewayBase,
          serviceId,
          upstreamUrl,
          key: nearKey,
          network: opts.network ?? opts.chain.network,
          timeoutMs,
          fetchImpl,
        })
      : await postAdminMap({ gatewayBase, serviceId, upstreamUrl, adminToken, timeoutMs, fetchImpl });

  if (adminFailure === undefined) {
    return { serviceId, txHash, publicUrl, dashboardUrl, adminOk: true };
  }

  const retryHint =
    nearKey !== undefined
      ? 'The service is already registered: retry ONLY the mapping once the gateway is reachable ' +
        '(do NOT re-run `wrap`, that registers a duplicate):\n  ' +
        selfMapRetryCommand({
          serviceId,
          upstreamUrl,
          accountId: nearKey.signer.accountId,
          ...(nearKey.signer.keyPath !== undefined ? { keyPath: nearKey.signer.keyPath } : {}),
          registryId: opts.chain.registryId,
        })
      : `Retry the mapping with (expects AGENTGATE_ADMIN_TOKEN in your environment):\n  ${adminRetryCurl(`${gatewayBase}/admin/services`, serviceId, upstreamUrl)}`;
  const adminWarning = [
    `gateway upstream mapping for service ${serviceId} failed: ${adminFailure}.`,
    `The on-chain registration (tx ${txHash}) was NOT rolled back — ${publicUrl} answers 503 until the mapping exists.`,
    retryHint,
  ].join('\n');
  console.error(`warning: ${adminWarning}`);
  return { serviceId, txHash, publicUrl, dashboardUrl, adminOk: false, adminWarning };
}
