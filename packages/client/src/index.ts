import type { AnySigner, ChainClient, Invoice402, Logger, Motes } from '@agentgate/shared';
import { AgentGateError, compareMotes, parseMotes } from '@agentgate/shared';
import { resolvedHostIsPublic, validateHttpUrl } from '@agentgate/shared/net-guard';

/** Result of a fetchPaid call (SPEC §6). */
export interface PayAndFetchResult {
  status: number;
  body: unknown;
  paid: boolean;
  invoice?: Invoice402;
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
   * GET the URL; on 402 parse+validate the Invoice402 (refuse if priceMotes > maxPriceMotes),
   * pay via chain.transfer with transferId = nonce, then retry with proof headers
   * (X-Payment-Deploy-Hash + X-Payment-Nonce).
   * Retries `retry_after_ms` 402-pending up to 5×. Non-402 first responses pass through.
   */
  fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult>;
}

/** Proof header names (must match middleware SPEC §5). */
export const HEADER_DEPLOY_HASH = 'X-Payment-Deploy-Hash';
export const HEADER_NONCE = 'X-Payment-Nonce';

/** Maximum number of extra retries when the middleware answers 402 + retry_after_ms (pending). */
const MAX_PENDING_RETRIES = 5;
/** Never sleep longer than this per pending retry, regardless of what the server asks for. */
const MAX_RETRY_AFTER_MS = 30_000;

const INVOICE_VERSION = 'agentgate-402/1';
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
 * Strict runtime validation of an Invoice402 body. Every field is checked:
 * version (exact match), network, serviceId, serviceName, priceMotes (bigint-parseable),
 * paymentTarget (account-hash-<64hex>), nonce (u64 decimal), expiresAt (future unix ms),
 * instructions. Throws AgentGateError('BAD_INVOICE') on any violation.
 */
export function parseInvoice402(raw: unknown, now: number = Date.now()): Invoice402 {
  if (!isRecord(raw)) throw badInvoice('body is not a JSON object');

  const version = raw['version'];
  if (version !== INVOICE_VERSION) {
    throw badInvoice(
      `unsupported version ${JSON.stringify(version)} (expected "${INVOICE_VERSION}")`,
    );
  }

  const network = raw['network'];
  if (typeof network !== 'string' || network.trim() === '') {
    throw badInvoice('network must be a non-empty string');
  }

  const serviceId = raw['serviceId'];
  if (typeof serviceId !== 'number' || !Number.isSafeInteger(serviceId) || serviceId < 0) {
    throw badInvoice('serviceId must be a non-negative integer');
  }

  const serviceName = raw['serviceName'];
  if (typeof serviceName !== 'string' || serviceName.trim() === '') {
    throw badInvoice('serviceName must be a non-empty string');
  }

  const priceMotes = raw['priceMotes'];
  if (typeof priceMotes !== 'string') throw badInvoice('priceMotes must be a string');
  try {
    parseMotes(priceMotes);
  } catch {
    throw badInvoice(`priceMotes ${JSON.stringify(priceMotes)} is not a motes decimal string`);
  }

  const paymentTarget = raw['paymentTarget'];
  if (typeof paymentTarget !== 'string' || !ACCOUNT_HASH_RE.test(paymentTarget)) {
    throw badInvoice('paymentTarget must be "account-hash-<64 hex>"');
  }

  const nonce = raw['nonce'];
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || BigInt(nonce) > U64_MAX) {
    throw badInvoice('nonce must be a u64 decimal string');
  }

  const expiresAt = raw['expiresAt'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw badInvoice('expiresAt must be a positive unix-ms timestamp');
  }
  if (expiresAt <= now) {
    throw badInvoice('invoice is already expired — refusing to pay');
  }

  const instructions = raw['instructions'];
  if (typeof instructions !== 'string') {
    throw badInvoice('instructions must be a string');
  }

  return {
    version: INVOICE_VERSION,
    network,
    serviceId,
    serviceName,
    priceMotes,
    paymentTarget,
    nonce,
    expiresAt,
    instructions,
  };
}

interface FetchedBody {
  status: number;
  body: unknown;
  isJson: boolean;
}

async function readBody(res: Response): Promise<FetchedBody> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (text.length > 0) {
    // Try JSON regardless of content-type (some upstreams mislabel); prefer it when it parses.
    try {
      return { status: res.status, body: JSON.parse(text) as unknown, isJson: true };
    } catch {
      if (contentType.includes('json')) {
        // Declared JSON but unparseable — surface the raw text, flagged as non-JSON.
        return { status: res.status, body: text, isJson: false };
      }
    }
  }
  return { status: res.status, body: text === '' ? null : text, isJson: false };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const v = body['retry_after_ms'];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.min(v, MAX_RETRY_AFTER_MS);
}

/**
 * Agent-side pay helper (SPEC §6): parse 402 → validate invoice → pay (native transfer
 * with transfer_id = nonce) → retry with proof headers.
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
    const invoice = parseInvoice402(first.body);
    // Never pay on a different chain than the one we transfer on.
    if (invoice.network !== chain.network) {
      throw new AgentGateError(
        'NETWORK_MISMATCH',
        `invoice network ${invoice.network} != chain network ${chain.network} — refusing to pay`,
        502,
      );
    }
    logger?.info('fetchPaid: received 402 invoice', {
      url,
      serviceId: invoice.serviceId,
      priceMotes: invoice.priceMotes,
      nonce: invoice.nonce,
    });

    // Price guard — never pay above the caller's cap.
    if (maxPriceMotes !== undefined && compareMotes(invoice.priceMotes, maxPriceMotes) > 0) {
      throw new AgentGateError(
        'PRICE_EXCEEDED',
        `invoice price ${invoice.priceMotes} motes exceeds maxPriceMotes ${maxPriceMotes}`,
        402,
      );
    }

    // Pay: native transfer carrying the invoice nonce as transfer_id.
    const { deployHash } = await chain.transfer(
      { to: invoice.paymentTarget, amountMotes: invoice.priceMotes, transferId: invoice.nonce },
      signer,
    );
    logger?.info('fetchPaid: payment sent', { deployHash, amountMotes: invoice.priceMotes });

    await sleep(settleDelayMs);

    // Retry with proof headers; on 402+retry_after_ms (verification pending) retry up to 5×.
    const headers = new Headers(init?.headers);
    headers.set(HEADER_DEPLOY_HASH, deployHash);
    headers.set(HEADER_NONCE, invoice.nonce);
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
          invoice,
          deployHash,
          priceMotes: invoice.priceMotes,
        };
      }
      const wait = retryAfterMs(res.body);
      if (wait === undefined || pendingRetries >= MAX_PENDING_RETRIES) {
        logger?.warn('fetchPaid: proof rejected', {
          url,
          status: res.status,
          pendingRetries,
        });
        return {
          status: res.status,
          body: res.body,
          paid: true,
          invoice,
          deployHash,
          priceMotes: invoice.priceMotes,
        };
      }
      pendingRetries += 1;
      logger?.debug('fetchPaid: verification pending, retrying', {
        wait,
        attempt: pendingRetries,
      });
      await sleep(wait);
    }
  }

  return { fetchPaid };
}
