import type { AnySigner, ChainClient, GatewayReceipt, Logger, Yocto } from '@agentgate/shared';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  compareYocto,
  formatError,
  formatNear,
  formatPriceWithStorage,
  isMockNetwork,
  isNearAccountId,
  isRecord,
  isValidNonce,
  parseGatewayReceipt,
  parseYocto,
} from '@agentgate/shared';
import {
  encodeXPayment, decodeXPaymentResponse,
  X402_ASSET_NEAR, X402_VERSION, X402_SCHEME,
  type PaymentRequirements, type SettlementResponse,
} from '@agentgate/shared';
import { resolvedHostIsPublic, validateHttpUrl } from '@agentgate/shared/net-guard';

/** Result of a fetchPaid call. */
export interface PayAndFetchResult {
  status: number;
  body: unknown;
  paid: boolean;
  requirements?: PaymentRequirements;
  settlement?: SettlementResponse;
  txHash?: string;
  /** The service price the seller receives (`extra.priceYocto`). Set when paid. */
  priceYocto?: Yocto;
  /** What the payment attached: price + registry storage fee (`maxAmountRequired`). Set when paid. */
  depositYocto?: Yocto;
}

export interface AgentGateClientOpts {
  chain: ChainClient;
  signer: AnySigner;
  /**
   * Budget cap (yocto decimal string): refuse, with BUDGET_EXCEEDED, any invoice whose
   * maxAmountRequired — the total attached, price + storage fee — is above it.
   */
  maxYocto?: Yocto;
  /** Refuse (SERVICE_MISMATCH) an invoice for any other service id than this one. */
  expectedServiceId?: number;
  logger?: Logger;
  /** Wait after the on-chain payment before retrying with proof. Default: 0 (mock) / 3000 (live). */
  settleDelayMs?: number;
  /** Injectable fetch implementation (dependency injection for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout for the upstream GETs (ms). Default 30000. */
  requestTimeoutMs?: number;
  /**
   * Reject private/loopback/link-local upstream hosts (SSRF guard). Defaults to
   * true off-mock (live). The fetched URL comes from seller-controlled on-chain
   * data, so in live mode it must not point at internal infrastructure.
   */
  rejectPrivateHosts?: boolean;
}

export interface AgentGateClient {
  /**
   * GET the URL; on 402 parse+validate the PaymentRequiredResponse (refuse if
   * maxAmountRequired > maxYocto), pay via chain.pay with the invoice's serviceId +
   * nonce and maxAmountRequired attached, then retry with the X-PAYMENT header
   * (base64-encoded proof). While the gateway answers `settlement_pending`, waits
   * Retry-After and retries the same proof, up to 3×. Non-402 first responses pass
   * through. Exposes `requirements` (parsed entry) and `settlement` (decoded
   * X-PAYMENT-RESPONSE) on success.
   *
   * A redirect is never followed (`redirect: 'manual'`, whatever `init` says): a 3xx on the
   * invoice request throws REDIRECT_REFUSED before anything is paid. Once the payment went
   * through, a call the gateway does not serve (a 402 refusal of the proof, settlement still
   * pending after the retries, a 3xx, a network error or timeout) throws PaidNotServedError
   * (PAID_NOT_SERVED) carrying the proof to re-present.
   */
  fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult>;
}

/** Why a paid call was not served; see PaidNotServedError. */
export type PaidNotServedReason = 'refused' | 'settlement_pending' | 'redirect' | 'transport';

/**
 * PAID_NOT_SERVED: the registry `pay` went through, so the deposit is spent, but the gateway did
 * not serve the call. Do not pay a fresh invoice for it: re-present this proof (an X-PAYMENT
 * `{kind: 'tx', transaction: txHash, nonce, payer}` for the same URL) once the gateway is
 * reachable or the payment has settled. The error carries what that takes:
 *
 * - `txHash`: the `pay` transaction (the proof's `transaction`)
 * - `nonce`: the invoice nonce it paid
 * - `serviceId`: the registry service it paid
 * - `depositYocto`: what it attached, price + storage fee (already spent)
 * - `reason`: `refused` (the gateway answered the proof with a 402 refusal, e.g. not_found),
 *   `settlement_pending` (still settling after the last retry), `redirect` (a 3xx, never
 *   followed) or `transport` (a network error or timeout)
 * - `status`: the gateway's HTTP status, when it answered (undefined for `transport`)
 */
export class PaidNotServedError extends AgentGateError {
  readonly txHash: string;
  readonly nonce: string;
  readonly serviceId: number;
  readonly depositYocto: Yocto;
  readonly reason: PaidNotServedReason;
  readonly status: number | undefined;

  constructor(
    proof: { txHash: string; nonce: string; serviceId: number; depositYocto: Yocto },
    reason: PaidNotServedReason,
    status: number | undefined,
    detail: string,
  ) {
    super(
      'PAID_NOT_SERVED',
      `paid ${formatNear(proof.depositYocto)} for service ${proof.serviceId} (tx ${proof.txHash}, nonce ${proof.nonce}) ` +
        `but the call was not served: ${detail} — re-present this proof instead of paying a new invoice`,
      502,
    );
    this.name = 'PaidNotServedError';
    this.txHash = proof.txHash;
    this.nonce = proof.nonce;
    this.serviceId = proof.serviceId;
    this.depositYocto = proof.depositYocto;
    this.reason = reason;
    this.status = status;
  }
}

/** REDIRECT_REFUSED: a gateway answered with a redirect, which NearGate never follows. */
export class RedirectRefusedError extends AgentGateError {
  /** The 3xx status (0 for a browser's opaque redirect). */
  readonly status: number;
  /** The Location the gateway named, JSON-quoted and cut to 200 characters ('' when none). */
  readonly location: string;

  constructor(url: string, status: number, location: string | null) {
    const target = location === null ? '' : quoteUrl(location);
    super(
      'REDIRECT_REFUSED',
      `refusing to follow the HTTP ${status} redirect from ${quoteUrl(url)}${target === '' ? '' : ` to ${target}`}: ` +
        'a redirect would send the request past the URL guard, so NearGate never follows one',
      502,
    );
    this.name = 'RedirectRefusedError';
    this.status = status;
    this.location = target;
  }
}

/**
 * Throws RedirectRefusedError when `res` (fetched with `redirect: 'manual'`) is a redirect: any
 * 3xx, or a browser's opaque redirect. Every client→gateway fetch checks its answer with this,
 * so a gateway URL that passed the URL guard cannot bounce the request (or, on the paid retry,
 * the X-PAYMENT proof) to a private or otherwise unchecked address.
 */
export async function refuseRedirect(url: string, res: Response): Promise<void> {
  const opaque = res.type === 'opaqueredirect';
  if (!opaque && (res.status < 300 || res.status > 399)) return;
  await res.body?.cancel().catch(() => undefined);
  throw new RedirectRefusedError(url, opaque ? 0 : res.status, res.headers.get('location'));
}

/** Extra proof attempts while the gateway answers `settlement_pending`. */
const MAX_PENDING_RETRIES = 3;
/** Wait before retrying a `settlement_pending` answer that names no Retry-After. */
const DEFAULT_PENDING_RETRY_MS = 2_000;
/** Never sleep longer than this per pending retry, regardless of what the server asks for. */
const MAX_RETRY_AFTER_MS = 30_000;
/** The 402 error the gateway sends while a payment is still settling (same invoice, retry later). */
const SETTLEMENT_PENDING = 'settlement_pending';
/** The only settlement rail this client pays: the registry's `pay` method. */
const REGISTRY_PAY_SETTLEMENT = 'neargate-registry-pay';

const U64_MAX = 18_446_744_073_709_551_615n; // 2^64 - 1

function badInvoice(why: string): AgentGateError {
  return new AgentGateError('BAD_INVOICE', `invalid 402 invoice: ${why}`, 502);
}

/** A seller-controlled URL as error text: JSON-quoted (no control characters) and cut to 200 characters. */
function quoteUrl(raw: string): string {
  return JSON.stringify(String(raw).slice(0, 200));
}

function isYocto(v: unknown): v is Yocto {
  if (typeof v !== 'string') return false;
  try {
    parseYocto(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a URL taken from the registry (a seller-controlled `endpointUrl`) before
 * anything fetches it: http(s) only, and with `rejectPrivateHosts` (live mode) no
 * private/loopback/link-local host, including DNS names that resolve to one.
 * Throws BAD_URL or FORBIDDEN_HOST; returns the parsed URL.
 */
export async function assertFetchableUrl(raw: string, opts: { rejectPrivateHosts: boolean }): Promise<URL> {
  const parsed = validateHttpUrl(raw, { rejectPrivateHosts: opts.rejectPrivateHosts });
  if (!parsed.ok) {
    throw new AgentGateError(
      parsed.error === 'forbidden_host' ? 'FORBIDDEN_HOST' : 'BAD_URL',
      `refusing to fetch ${quoteUrl(raw)}: ${parsed.error}`,
      400,
    );
  }
  if (opts.rejectPrivateHosts && !(await resolvedHostIsPublic(parsed.url.hostname))) {
    throw new AgentGateError(
      'FORBIDDEN_HOST',
      `refusing to fetch ${quoteUrl(raw)}: host resolves to a private/unreachable address`,
      400,
    );
  }
  return parsed.url;
}

/**
 * Strict runtime validation of a PaymentRequiredResponse body. Finds the first
 * accepts[] entry with scheme "exact", network === chainNetwork and asset "NEAR"
 * (entries in other assets are skipped), then validates maxAmountRequired (yocto),
 * payTo (NEAR account id), extra.serviceId (positive safe integer), extra.nonce
 * (u64 decimal), extra.expiresAtMs (future unix ms) and the registry rail:
 * settlement "neargate-registry-pay", method "pay", contractId === payTo,
 * storageFeeYocto === the registry's PAYMENT_STORAGE_FEE_YOCTO, and
 * priceYocto + storageFeeYocto === maxAmountRequired.
 * Throws NETWORK_MISMATCH when nothing is offered on chainNetwork and
 * AgentGateError('BAD_INVOICE') on any other violation.
 */
export function parsePaymentRequired(
  raw: unknown, chainNetwork: string, now: number = Date.now(),
): PaymentRequirements {
  if (!isRecord(raw)) throw badInvoice('body is not a JSON object');
  if (raw['x402Version'] !== X402_VERSION) throw badInvoice(`unsupported x402Version (expected ${X402_VERSION})`);
  const accepts = raw['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) throw badInvoice('accepts must be a non-empty array');
  const schemeMatches = accepts.filter(
    (a): a is PaymentRequirements => isRecord(a) && a['scheme'] === X402_SCHEME,
  );
  if (schemeMatches.length === 0) throw badInvoice(`no accepts entry for scheme "${X402_SCHEME}"`);
  const onNetwork = schemeMatches.filter((a) => a['network'] === chainNetwork);
  if (onNetwork.length === 0) {
    throw new AgentGateError('NETWORK_MISMATCH', `invoice offers no payment on network "${chainNetwork}" — refusing to pay`, 502);
  }
  // This client pays one rail: native NEAR through the registry `pay`.
  const req = onNetwork.find((a) => a['asset'] === X402_ASSET_NEAR);
  if (!req) throw badInvoice(`no accepts entry pays in ${X402_ASSET_NEAR} on network "${chainNetwork}"`);
  if (typeof req.maxAmountRequired !== 'string') throw badInvoice('maxAmountRequired must be a string');
  try {
    parseYocto(req.maxAmountRequired);
  } catch {
    throw badInvoice(`maxAmountRequired ${JSON.stringify(req.maxAmountRequired)} is not a yocto decimal string`);
  }
  if (!isNearAccountId(req.payTo)) {
    throw badInvoice('payTo must be a NEAR account id');
  }
  // `serviceId` goes straight into the registry `pay` call; registry ids start at 1.
  const serviceId: unknown = req.extra?.serviceId;
  if (typeof serviceId !== 'number' || !Number.isSafeInteger(serviceId) || serviceId < 1) {
    throw badInvoice('extra.serviceId must be a positive integer');
  }
  const nonce = req.extra?.nonce;
  if (typeof nonce !== 'string' || !isValidNonce(nonce) || BigInt(nonce) > U64_MAX) {
    throw badInvoice('extra.nonce must be a u64 decimal string');
  }
  if (typeof req.extra?.expiresAtMs !== 'number' || !Number.isFinite(req.extra.expiresAtMs) || req.extra.expiresAtMs <= now) {
    throw badInvoice('invoice is expired — refusing to pay');
  }
  // The registry rail: pay(service_id, nonce) on the contract the invoice names.
  if (req.extra.settlement !== REGISTRY_PAY_SETTLEMENT) {
    throw badInvoice(`extra.settlement must be "${REGISTRY_PAY_SETTLEMENT}"`);
  }
  if (req.extra.method !== 'pay') throw badInvoice('extra.method must be "pay"');
  if (req.extra.contractId !== req.payTo) throw badInvoice('extra.contractId must equal payTo');
  if (!isYocto(req.extra.priceYocto)) throw badInvoice('extra.priceYocto must be a yocto decimal string');
  if (!isYocto(req.extra.storageFeeYocto)) throw badInvoice('extra.storageFeeYocto must be a yocto decimal string');
  // The registry keeps exactly this fee from every `pay`: an invoice that splits the same
  // total differently misstates what the seller receives.
  if (req.extra.storageFeeYocto !== PAYMENT_STORAGE_FEE_YOCTO) {
    throw badInvoice(
      `extra.storageFeeYocto must be the registry storage fee ${PAYMENT_STORAGE_FEE_YOCTO} (${formatNear(PAYMENT_STORAGE_FEE_YOCTO)}), ` +
        `got ${JSON.stringify(req.extra.storageFeeYocto.slice(0, 40))}`,
    );
  }
  if (compareYocto(addYocto(req.extra.priceYocto, req.extra.storageFeeYocto), req.maxAmountRequired) !== 0) {
    throw badInvoice('maxAmountRequired must equal extra.priceYocto + extra.storageFeeYocto');
  }
  return req;
}

/** True for the gateway's "still settling" 402 body (same invoice; retry the same proof later). */
function isSettlementPending(body: unknown): boolean {
  return isRecord(body) && body['error'] === SETTLEMENT_PENDING;
}

interface FetchedBody {
  status: number;
  body: unknown;
  isJson: boolean;
  retryAfterMs?: number;
  settlement?: SettlementResponse;
}

async function readBody(res: Response): Promise<FetchedBody> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';

  // Body parsing — try JSON first regardless of content-type
  let body: unknown = text === '' ? null : text;
  let isJson = false;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
      isJson = true;
    } catch {
      if (contentType.includes('json')) {
        // Declared JSON but unparseable — surface raw text, flagged as non-JSON
        body = text;
        isJson = false;
      }
    }
  }

  // Retry-After response header (seconds → ms, capped at MAX_RETRY_AFTER_MS)
  const ra = res.headers.get('retry-after');
  const retryAfterMs = ra !== null && /^\d+$/.test(ra)
    ? Math.min(Number(ra) * 1000, MAX_RETRY_AFTER_MS)
    : undefined;

  // X-PAYMENT-RESPONSE header → settlement proof
  let settlement: SettlementResponse | undefined;
  const sp = res.headers.get('x-payment-response');
  if (sp !== null) {
    try { settlement = decodeXPaymentResponse(sp); } catch { settlement = undefined; }
  }

  return { status: res.status, body, isJson, retryAfterMs, settlement };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Agent-side pay helper: parse 402 → validate PaymentRequirements →
 * pay (registry `pay` with the invoice nonce) → retry with X-PAYMENT header.
 */
export function createAgentGateClient(opts: AgentGateClientOpts): AgentGateClient {
  if (!opts || typeof opts !== 'object') {
    throw new AgentGateError('BAD_OPTS', 'createAgentGateClient requires an options object', 500);
  }
  const { chain, signer, maxYocto, expectedServiceId, logger } = opts;
  if (!chain || typeof chain.pay !== 'function') {
    throw new AgentGateError('BAD_OPTS', 'opts.chain must be a ChainClient', 500);
  }
  if (!signer || (signer.kind !== 'mock' && signer.kind !== 'near')) {
    throw new AgentGateError('BAD_OPTS', 'opts.signer must be a mock or near signer', 500);
  }
  // The signer's account id is the payer named in every X-PAYMENT proof.
  if (!isNearAccountId(signer.accountId)) {
    throw new AgentGateError('BAD_OPTS', 'opts.signer.accountId must be a NEAR account id', 500);
  }
  if (maxYocto !== undefined) {
    parseYocto(maxYocto); // throws AgentGateError('INVALID_AMOUNT') on garbage
  }
  if (expectedServiceId !== undefined && (!Number.isSafeInteger(expectedServiceId) || expectedServiceId < 1)) {
    throw new AgentGateError('BAD_OPTS', 'opts.expectedServiceId must be a positive integer', 500);
  }
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const settleDelayMs = opts.settleDelayMs ?? (isMockNetwork(chain.network) ? 0 : 3000);
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const rejectPrivateHosts = opts.rejectPrivateHosts ?? !isMockNetwork(chain.network);

  /**
   * The init of every client→gateway fetch: a per-request timeout unless the caller supplied
   * their own signal, and `redirect: 'manual'` whatever the caller asked for, so fetch never
   * follows a 3xx past the URL guard (`refuseRedirect` then turns it into an error).
   */
  function gatewayInit(init?: RequestInit): RequestInit {
    return {
      ...init,
      ...(init?.signal ? {} : { signal: AbortSignal.timeout(requestTimeoutMs) }),
      redirect: 'manual',
    };
  }

  /** fetch + readBody: refuses a redirect (REDIRECT_REFUSED), maps abort/timeout to UPSTREAM_TIMEOUT. */
  async function doFetch(url: string, init?: RequestInit): Promise<FetchedBody> {
    try {
      const res = await fetchImpl(url, gatewayInit(init));
      await refuseRedirect(url, res);
      return await readBody(res);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AgentGateError(
          'UPSTREAM_TIMEOUT',
          `request to ${quoteUrl(url)} timed out after ${requestTimeoutMs}ms`,
          504,
        );
      }
      throw err;
    }
  }

  async function fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult> {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new AgentGateError('BAD_URL', 'fetchPaid requires a non-empty url', 400);
    }

    // SSRF guard: the URL is seller-controlled (on-chain endpointUrl). Require
    // http(s) and, in live mode, refuse private/loopback/link-local hosts —
    // including DNS names that resolve to them (rebinding) — before connecting.
    await assertFetchableUrl(url, { rejectPrivateHosts });

    const first = await doFetch(url, init);

    // Non-402 first responses pass straight through, unpaid.
    if (first.status !== 402) {
      logger?.debug('fetchPaid: non-402 passthrough', { url, status: first.status });
      return { status: first.status, body: first.body, paid: false };
    }

    if (!first.isJson) throw badInvoice('402 response body is not JSON');

    // Parse and validate the PaymentRequiredResponse; network match is inside parsePaymentRequired.
    const req = parsePaymentRequired(first.body, chain.network);

    logger?.info('fetchPaid: received 402 requirements', {
      url,
      serviceId: req.extra.serviceId,
      maxAmountRequired: req.maxAmountRequired,
      nonce: req.extra.nonce,
    });

    // `chain.pay` always calls this client's registry: an invoice naming another one would
    // pay a service the gateway never sees.
    if (req.payTo !== chain.registryId) {
      throw new AgentGateError(
        'REGISTRY_MISMATCH',
        `invoice pays registry ${req.payTo}, this client settles on ${chain.registryId} — refusing to pay`,
        502,
      );
    }
    if (expectedServiceId !== undefined && req.extra.serviceId !== expectedServiceId) {
      throw new AgentGateError(
        'SERVICE_MISMATCH',
        `invoice is for service ${req.extra.serviceId}, not service ${expectedServiceId} — refusing to pay`,
        502,
      );
    }

    // Budget cap on the total attached (price + storage fee) — never pay above it.
    if (maxYocto !== undefined && compareYocto(req.maxAmountRequired, maxYocto) > 0) {
      throw new AgentGateError(
        'BUDGET_EXCEEDED',
        `invoice asks ${formatPriceWithStorage(req.extra.priceYocto, req.extra.storageFeeYocto)} ` +
          `(${formatNear(req.maxAmountRequired)} attached), above the ${formatNear(maxYocto)} cap`,
        402,
      );
    }

    // Pay through the registry: `pay(service_id, nonce)` with price + storage fee attached.
    const { txHash } = await chain.pay(
      { serviceId: req.extra.serviceId, nonce: req.extra.nonce, depositYocto: req.maxAmountRequired },
      signer,
    );
    logger?.info('fetchPaid: payment sent', { txHash, amountYocto: req.maxAmountRequired });

    await sleep(settleDelayMs);

    // Retry with the x402 proof header; while the gateway answers settlement_pending, wait
    // Retry-After and resend the same proof, up to MAX_PENDING_RETRIES times.
    const headers = new Headers(init?.headers);
    headers.set('X-PAYMENT', encodeXPayment({
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: chain.network,
      payload: { kind: 'tx', transaction: txHash, nonce: req.extra.nonce, payer: signer.accountId },
    }));
    const proofInit: RequestInit = { ...init, headers };

    const paidFields = {
      paid: true,
      requirements: req,
      txHash,
      priceYocto: req.extra.priceYocto,
      depositYocto: req.maxAmountRequired,
    };
    // From here on the deposit is spent: a call that is not served throws PAID_NOT_SERVED with
    // the proof, so the caller re-presents it instead of paying a fresh invoice.
    const proof = {
      txHash,
      nonce: req.extra.nonce,
      serviceId: req.extra.serviceId,
      depositYocto: req.maxAmountRequired,
    };
    let pendingRetries = 0;
    for (;;) {
      let res: FetchedBody;
      try {
        res = await doFetch(url, proofInit);
      } catch (err) {
        if (err instanceof RedirectRefusedError) {
          logger?.warn('fetchPaid: paid request redirected, not followed', { url, status: err.status, txHash });
          throw new PaidNotServedError(
            proof,
            'redirect',
            err.status,
            `the gateway answered HTTP ${err.status}, a redirect${err.location === '' ? '' : ` to ${err.location}`} (never followed)`,
          );
        }
        logger?.warn('fetchPaid: paid request failed', { url, txHash, error: formatError(err) });
        throw new PaidNotServedError(proof, 'transport', undefined, `the paid request failed: ${formatError(err)}`);
      }
      if (res.status !== 402) {
        logger?.info('fetchPaid: paid request completed', { url, status: res.status });
        return { status: res.status, body: res.body, settlement: res.settlement, ...paidFields };
      }
      if (!isSettlementPending(res.body)) {
        const verdict = isRecord(res.body) && typeof res.body['error'] === 'string' ? res.body['error'] : 'no reason given';
        logger?.warn('fetchPaid: gateway refused the proof', { url, status: res.status, txHash });
        throw new PaidNotServedError(
          proof,
          'refused',
          res.status,
          `the gateway refused the proof (HTTP ${res.status} ${JSON.stringify(verdict.slice(0, 80))})`,
        );
      }
      if (pendingRetries >= MAX_PENDING_RETRIES) {
        logger?.warn('fetchPaid: settlement still pending after the last retry, giving up', {
          url,
          status: res.status,
          pendingRetries,
          txHash,
        });
        throw new PaidNotServedError(
          proof,
          'settlement_pending',
          res.status,
          `the payment was still settling after ${MAX_PENDING_RETRIES} retries (HTTP ${res.status} ${SETTLEMENT_PENDING})`,
        );
      }
      pendingRetries += 1;
      const wait = res.retryAfterMs ?? DEFAULT_PENDING_RETRY_MS;
      logger?.debug('fetchPaid: settlement pending, retrying', { wait, attempt: pendingRetries });
      await sleep(wait);
    }
  }

  return { fetchPaid };
}

// ---------------------------------------------------------------------------
// Gateway receipts: where a buyer learns its attestation's tx hash on a live chain
// ---------------------------------------------------------------------------

export interface ReceiptFetchOpts {
  /** Injectable fetch implementation (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Refuse private/loopback/link-local gateway hosts (SSRF guard). Default true. */
  rejectPrivateHosts?: boolean;
  /** Per-request timeout (ms). Default 10000. */
  requestTimeoutMs?: number;
}

export interface WaitForReceiptOpts extends ReceiptFetchOpts {
  /** How long to wait for the attestation to leave `pending` (ms). Default 10000. */
  timeoutMs?: number;
  /** Pause between polls (ms). Default 500. */
  pollIntervalMs?: number;
}

/** Failures that retrying cannot fix: `waitForReceipt` rethrows these at once. */
const FATAL_RECEIPT_CODES = new Set([
  'BAD_URL',
  'FORBIDDEN_HOST',
  'REDIRECT_REFUSED',
  'INVALID_NONCE',
  'BAD_RECEIPT',
  'BODY_TOO_LARGE',
]);

/**
 * The most a gateway may send back in an answer that is not the paid response itself (a 402
 * invoice, a receipt): both are well under 4 KiB. The gateway is seller-controlled, so what it
 * streams is not trusted to end.
 */
export const MAX_GATEWAY_BODY_BYTES = 64 * 1024;

/**
 * Reads a response body as text, refusing (BODY_TOO_LARGE) one over `maxBytes`: a declared
 * content-length over the cap fails before any byte is read, and a stream is cancelled the
 * moment it passes the cap, so an endless body costs at most the cap in memory.
 */
export async function readCappedText(res: Response, maxBytes: number = MAX_GATEWAY_BODY_BYTES): Promise<string> {
  const tooLarge = (): AgentGateError =>
    new AgentGateError('BODY_TOO_LARGE', `the gateway's answer is over ${maxBytes} bytes: not reading it`, 502);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The gateway's receipts URL for a paid call: `<gateway>/receipts/<nonce>`, taken from the
 * service's public endpoint `<gateway>/svc/<id>` (the form the registry records).
 */
export function receiptUrl(endpointUrl: string, nonce: string): string {
  if (!isValidNonce(nonce)) {
    throw new AgentGateError('INVALID_NONCE', `nonce must be 1-20 decimal digits, got ${quoteUrl(nonce)}`, 400);
  }
  const match = /^(.*)\/svc\/[0-9]+\/?$/.exec(endpointUrl);
  if (match?.[1] === undefined) {
    throw new AgentGateError('BAD_URL', `${quoteUrl(endpointUrl)} is not a <gateway>/svc/<id> endpoint`, 400);
  }
  return `${match[1]}/receipts/${nonce}`;
}

/**
 * GET `<gateway>/receipts/<nonce>`: the gateway's record of one paid call, including the
 * attestation tx once it has one. Resolves null when the gateway does not know the nonce (404).
 * The gateway URL comes from seller-controlled on-chain data, so it passes the same guard as
 * `fetchPaid` (http(s) only, no private host unless `rejectPrivateHosts: false`) and a
 * redirect is never followed. Throws BAD_RECEIPT for a body that is not a receipt for this
 * nonce and RECEIPT_UNAVAILABLE for any other failure to get one.
 */
export async function fetchReceipt(
  endpointUrl: string,
  nonce: string,
  opts: ReceiptFetchOpts = {},
): Promise<GatewayReceipt | null> {
  const url = receiptUrl(endpointUrl, nonce);
  await assertFetchableUrl(url, { rejectPrivateHosts: opts.rejectPrivateHosts ?? true });
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000) });
  } catch (err) {
    throw new AgentGateError('RECEIPT_UNAVAILABLE', `could not get ${quoteUrl(url)}: ${formatError(err)}`, 502);
  }
  await refuseRedirect(url, res);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new AgentGateError('RECEIPT_UNAVAILABLE', `the gateway answered HTTP ${res.status} for ${quoteUrl(url)}`, 502);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readCappedText(res)) as unknown;
  } catch (err) {
    if (err instanceof AgentGateError) throw err; // BODY_TOO_LARGE
    throw new AgentGateError('BAD_RECEIPT', `invalid gateway receipt: ${quoteUrl(url)} did not answer JSON`, 502);
  }
  const receipt = parseGatewayReceipt(raw);
  if (receipt.nonce !== nonce) {
    throw new AgentGateError('BAD_RECEIPT', `invalid gateway receipt: it is for nonce ${receipt.nonce}, not ${nonce}`, 502);
  }
  return receipt;
}

/**
 * Polls the receipt until its attestation leaves `pending` (recorded, skipped or failed) or
 * `timeoutMs` passes. Resolves with the final receipt, or with the last one it saw (still
 * pending) on timeout, or null when the gateway does not know the nonce. Transient failures
 * (network, 429, 5xx) are ridden out; if no receipt was ever read before the timeout the last
 * failure is thrown. A failure retrying cannot fix (forbidden host, redirect, malformed
 * receipt) is thrown at once.
 */
export async function waitForReceipt(
  endpointUrl: string,
  nonce: string,
  opts: WaitForReceiptOpts = {},
): Promise<GatewayReceipt | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const pollMs = opts.pollIntervalMs ?? 500;
  let last: GatewayReceipt | null = null;
  let lastError: unknown;
  for (;;) {
    try {
      const got = await fetchReceipt(endpointUrl, nonce, opts);
      if (got === null) return last;
      last = got;
      lastError = undefined;
      if (got.attestation.status !== 'pending') return got;
    } catch (err) {
      if (err instanceof AgentGateError && FATAL_RECEIPT_CODES.has(err.code)) throw err;
      lastError = err;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(pollMs, left));
  }
  if (last !== null) return last;
  if (lastError !== undefined) throw lastError;
  return null;
}
