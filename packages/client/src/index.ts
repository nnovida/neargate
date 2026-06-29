import type { AnySigner, ChainClient, Logger, Motes } from '@agentgate/shared';
import { AgentGateError, compareMotes, parseMotes } from '@agentgate/shared';
import {
  encodeXPayment, decodeXPaymentResponse,
  X402_VERSION, X402_SCHEME,
  type PaymentRequirements, type PaymentRequiredResponse, type SettlementResponse,
} from '@agentgate/shared';
import { resolvedHostIsPublic, validateHttpUrl } from '@agentgate/shared/net-guard';

/** Result of a fetchPaid call (SPEC §6). */
export interface PayAndFetchResult {
  status: number;
  body: unknown;
  paid: boolean;
  requirements?: PaymentRequirements;
  settlement?: SettlementResponse;
  deployHash?: string;
  priceMotes?: Motes;
}

export interface AgentGateClientOpts {
  chain: ChainClient;
  signer: AnySigner;
  /** Refuse to pay any invoice priced above this (motes decimal string). */
  maxPriceMotes?: Motes;
  logger?: Logger;
  /** Wait after the on-chain transfer before retrying with proof. Default: 0 (mock) / 3000 (live). */
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
   * maxAmountRequired > maxPriceMotes), pay via chain.transfer with transferId =
   * extra.nonce, then retry with the X-PAYMENT header (base64-encoded proof).
   * Retries on 402 + Retry-After (seconds) up to 5×. Non-402 first responses
   * pass through. Exposes `requirements` (parsed entry) and `settlement` (decoded
   * X-PAYMENT-RESPONSE) on success.
   */
  fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult>;
}

/** Maximum number of extra retries when the middleware answers 402 + Retry-After (pending). */
const MAX_PENDING_RETRIES = 5;
/** Never sleep longer than this per pending retry, regardless of what the server asks for. */
const MAX_RETRY_AFTER_MS = 30_000;

const ACCOUNT_HASH_RE = /^account-hash-[0-9a-fA-F]{64}$/;
const NONCE_RE = /^\d{1,20}$/;
const U64_MAX = 18_446_744_073_709_551_615n; // 2^64 - 1

function badInvoice(why: string): AgentGateError {
  return new AgentGateError('BAD_INVOICE', `invalid 402 invoice: ${why}`, 502);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strict runtime validation of a PaymentRequiredResponse body. Finds the first
 * accepts[] entry matching scheme==="exact" and network===chainNetwork, then
 * validates maxAmountRequired (motes), payTo (account-hash-<64hex>),
 * extra.nonce (u64 decimal) and extra.expiresAtMs (future unix ms).
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
    parseMotes(req.maxAmountRequired);
  } catch {
    throw badInvoice(`maxAmountRequired ${JSON.stringify(req.maxAmountRequired)} is not a motes decimal string`);
  }
  if (typeof req.payTo !== 'string' || !ACCOUNT_HASH_RE.test(req.payTo)) {
    throw badInvoice('payTo must be "account-hash-<64 hex>"');
  }
  const nonce = req.extra?.nonce;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || BigInt(nonce) > U64_MAX) {
    throw badInvoice('extra.nonce must be a u64 decimal string');
  }
  if (typeof req.extra?.expiresAtMs !== 'number' || !Number.isFinite(req.extra.expiresAtMs) || req.extra.expiresAtMs <= now) {
    throw badInvoice('invoice is expired — refusing to pay');
  }
  return req;
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
 * Agent-side pay helper (SPEC §6): parse 402 → validate PaymentRequirements →
 * pay (native transfer with transfer_id = extra.nonce) → retry with X-PAYMENT header.
 */
export function createAgentGateClient(opts: AgentGateClientOpts): AgentGateClient {
  if (!opts || typeof opts !== 'object') {
    throw new AgentGateError('BAD_OPTS', 'createAgentGateClient requires an options object', 500);
  }
  const { chain, signer, maxPriceMotes, logger } = opts;
  if (!chain || typeof chain.transfer !== 'function') {
    throw new AgentGateError('BAD_OPTS', 'opts.chain must be a ChainClient', 500);
  }
  if (!signer || (signer.kind !== 'mock' && signer.kind !== 'pem')) {
    throw new AgentGateError('BAD_OPTS', 'opts.signer must be a mock or pem signer', 500);
  }
  if (maxPriceMotes !== undefined) {
    parseMotes(maxPriceMotes); // throws AgentGateError('INVALID_AMOUNT') on garbage
  }
  const fetchImpl: typeof fetch = opts.fetchImpl ?? fetch;
  const settleDelayMs = opts.settleDelayMs ?? (chain.network === 'mock' ? 0 : 3000);
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const rejectPrivateHosts = opts.rejectPrivateHosts ?? chain.network !== 'mock';

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
    const parsed = validateHttpUrl(url, { rejectPrivateHosts });
    if (!parsed.ok) {
      throw new AgentGateError(
        parsed.error === 'forbidden_host' ? 'FORBIDDEN_HOST' : 'BAD_URL',
        `fetchPaid refused url ${url}: ${parsed.error}`,
        400,
      );
    }
    if (rejectPrivateHosts && !(await resolvedHostIsPublic(parsed.url.hostname))) {
      throw new AgentGateError(
        'FORBIDDEN_HOST',
        `fetchPaid refused url ${url}: host resolves to a private/unreachable address`,
        400,
      );
    }

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

    // Price guard — never pay above the caller's cap.
    if (maxPriceMotes !== undefined && compareMotes(req.maxAmountRequired, maxPriceMotes) > 0) {
      throw new AgentGateError(
        'PRICE_EXCEEDED',
        `invoice price ${req.maxAmountRequired} motes exceeds maxPriceMotes ${maxPriceMotes}`,
        402,
      );
    }

    // Pay: native transfer carrying extra.nonce as transfer_id.
    const { deployHash } = await chain.transfer(
      { to: req.payTo, amountMotes: req.maxAmountRequired, transferId: req.extra.nonce },
      signer,
    );
    logger?.info('fetchPaid: payment sent', { deployHash, amountMotes: req.maxAmountRequired });

    await sleep(settleDelayMs);

    // Retry with x402 proof header; on 402 + Retry-After (verification pending) retry up to 5×.
    const headers = new Headers(init?.headers);
    headers.set('X-PAYMENT', encodeXPayment({
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: chain.network,
      payload: { transaction: deployHash, transferId: req.extra.nonce },
    }));
    const proofInit: RequestInit = { ...init, headers };

    let pendingRetries = 0;
    for (;;) {
      const res = await doFetch(url, withTimeout(proofInit));
      if (res.status !== 402) {
        logger?.info('fetchPaid: paid request completed', { url, status: res.status });
        return {
          status: res.status,
          body: res.body,
          paid: true,
          requirements: req,
          settlement: res.settlement,
          deployHash,
          priceMotes: req.maxAmountRequired,
        };
      }
      const wait = res.retryAfterMs;
      if (wait === undefined || pendingRetries >= MAX_PENDING_RETRIES) {
        logger?.warn('fetchPaid: proof rejected', { url, status: res.status, pendingRetries });
        return {
          status: res.status,
          body: res.body,
          paid: true,
          requirements: req,
          deployHash,
          priceMotes: req.maxAmountRequired,
        };
      }
      pendingRetries += 1;
      logger?.debug('fetchPaid: verification pending, retrying', { wait, attempt: pendingRetries });
      await sleep(wait);
    }
  }

  return { fetchPaid };
}
