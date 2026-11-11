import type { AnySigner, ChainClient, Logger, Yocto } from '@agentgate/shared';
import {
  AgentGateError,
  addYocto,
  compareYocto,
  formatNear,
  formatPriceWithStorage,
  isMockNetwork,
  isNearAccountId,
  isValidNonce,
  parseYocto,
} from '@agentgate/shared';
import {
  encodeXPayment, decodeXPaymentResponse,
  X402_VERSION, X402_SCHEME,
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
   */
  fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult>;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
      `refusing to fetch ${JSON.stringify(String(raw).slice(0, 200))}: ${parsed.error}`,
      400,
    );
  }
  if (opts.rejectPrivateHosts && !(await resolvedHostIsPublic(parsed.url.hostname))) {
    throw new AgentGateError(
      'FORBIDDEN_HOST',
      `refusing to fetch ${raw}: host resolves to a private/unreachable address`,
      400,
    );
  }
  return parsed.url;
}

/**
 * Strict runtime validation of a PaymentRequiredResponse body. Finds the first
 * accepts[] entry matching scheme==="exact" and network===chainNetwork, then
 * validates maxAmountRequired (yocto), payTo (NEAR account id),
 * extra.serviceId (positive safe integer), extra.nonce (u64 decimal),
 * extra.expiresAtMs (future unix ms) and the registry rail: settlement
 * "neargate-registry-pay", method "pay", contractId === payTo, and
 * priceYocto + storageFeeYocto === maxAmountRequired.
 * Throws AgentGateError('BAD_INVOICE') on any violation.
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
  const req = schemeMatches.find((a) => a['network'] === chainNetwork);
  if (!req) throw new AgentGateError('NETWORK_MISMATCH', `invoice offers no payment on network "${chainNetwork}" — refusing to pay`, 502);
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

  /** Adds a per-request timeout unless the caller supplied their own signal. */
  function withTimeout(init?: RequestInit): RequestInit {
    if (init?.signal) return init;
    return { ...init, signal: AbortSignal.timeout(requestTimeoutMs) };
  }

  /** fetch + readBody, mapping abort/timeout to a typed error. */
  async function doFetch(url: string, init?: RequestInit): Promise<FetchedBody> {
    try {
      return await readBody(await fetchImpl(url, init));
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AgentGateError(
          'UPSTREAM_TIMEOUT',
          `request to ${url} timed out after ${requestTimeoutMs}ms`,
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

    const first = await doFetch(url, withTimeout(init));

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
    let pendingRetries = 0;
    for (;;) {
      const res = await doFetch(url, withTimeout(proofInit));
      if (res.status !== 402) {
        logger?.info('fetchPaid: paid request completed', { url, status: res.status });
        return { status: res.status, body: res.body, settlement: res.settlement, ...paidFields };
      }
      if (!isSettlementPending(res.body) || pendingRetries >= MAX_PENDING_RETRIES) {
        logger?.warn('fetchPaid: proof rejected', { url, status: res.status, pendingRetries });
        return { status: res.status, body: res.body, ...paidFields };
      }
      pendingRetries += 1;
      const wait = res.retryAfterMs ?? DEFAULT_PENDING_RETRY_MS;
      logger?.debug('fetchPaid: settlement pending, retrying', { wait, attempt: pendingRetries });
      await sleep(wait);
    }
  }

  return { fetchPaid };
}
