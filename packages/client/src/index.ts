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
  isNearTxHash,
  isRecord,
  isValidNonce,
  parseGatewayReceipt,
  parseYocto,
} from '@agentgate/shared';
import {
  encodeXPayment, decodeXPaymentResponse,
  X402_ASSET_NEAR, X402_VERSION, X402_SCHEME,
  type NearExactPayload, type PaymentRequirements, type SettlementResponse,
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
  /**
   * What the payment cost: price + registry storage fee (`maxAmountRequired`), attached to `pay` or
   * debited from the escrow by `pay_from_escrow`. Set when paid.
   */
  depositYocto?: Yocto;
  /** Which rail paid: a `pay` deposit or the prepaid escrow. Set when paid. */
  payFrom?: PayFrom;
  /**
   * True when the gateway relayed the buyer's signed `pay_from_escrow` delegate and paid its gas
   * (`gasless: true`); `txHash` is then the relay tx the gateway named in X-PAYMENT-RESPONSE.
   */
  gasless?: boolean;
  /** With `gasless`: the gateway account that relayed the delegate (`extra.relayer`). */
  relayer?: string;
}

/** Where a payment comes from: an attached deposit (`pay`) or the prepaid escrow (`pay_from_escrow`). */
export type PayFrom = 'deposit' | 'escrow';

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
  /**
   * Where the payment comes from. `'deposit'` (default) attaches price + storage fee to the
   * registry's `pay`: the attached deposit is the most the call can cost, enforced on chain, so
   * `maxYocto` against the invoice's total is a real cap. `'escrow'` calls `pay_from_escrow`
   * instead, which attaches nothing and debits the signer's escrow by the ON-CHAIN price +
   * storage fee, whatever the invoice says, so a function-call key restricted to that method can
   * sign it. The invoice is seller data, so in escrow mode the client first reads the service from
   * the registry (prices are immutable per service id) and refuses with PRICE_MISMATCH unless
   * on-chain price + storage fee equals the invoice's total; `maxYocto` and the escrow pre-check
   * (ERR_ESCROW_INSUFFICIENT, before sending, when the escrow holds less) then run on that
   * verified total.
   */
  payFrom?: PayFrom;
  /**
   * The gasless rail (implies `payFrom: 'escrow'`): instead of sending `pay_from_escrow` itself, the
   * client signs it as a NEP-366 delegate (`chain.signPayDelegate`: zero deposit, the key's nonce +
   * 1, valid 100 blocks) and hands it to the gateway in X-PAYMENT `{kind: 'delegate'}`; the gateway
   * relays it and pays the gas, and the escrow pays price + storage fee. The invoice must offer it
   * (`extra.relayer`, `extra.relayMethod: 'pay_from_escrow'`), else RELAYER_UNAVAILABLE before
   * anything is read or signed; escrow mode's checks then run first (PRICE_MISMATCH, the budget,
   * ERR_ESCROW_INSUFFICIENT). The key may be the agent's function-call key.
   *
   * While the gateway answers `settlement_pending` (its relay is in flight, or timed out and may
   * still land), the client keeps presenting the same signed delegate until the gateway answers
   * definitively: served, or a refusal (`delegate_expired` once the delegate can no longer land:
   * it is valid 100 blocks), within `gaslessWaitMs`.
   */
  gasless?: boolean;
  /**
   * Gasless only: how long (ms) to keep presenting the signed delegate while the gateway answers
   * `settlement_pending`, counted from the first presentation. Default GASLESS_WAIT_MS (150 s): past
   * the delegate's 100 blocks the gateway's answer is definitive. Between two presentations the
   * client waits the gateway's Retry-After, clamped to 1-10 s.
   */
  gaslessWaitMs?: number;
  /** Gasless only: called on each `settlement_pending` answer, before the wait (progress). It never fails the call. */
  onGaslessWait?: (wait: GaslessWait) => void;
  /** The chain explorer's base URL (no trailing slash): GASLESS_NOT_SERVED links the relay tx there. */
  explorerUrl?: string;
  /**
   * How a GASLESS_NOT_SERVED message tells the buyer to read its escrow (e.g. "`neargate escrow
   * balance`"). Default: "the escrow balance (escrowOf)".
   */
  escrowBalanceHint?: string;
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
   * nonce and maxAmountRequired attached (or, with `payFrom: 'escrow'`, via
   * chain.payFromEscrow out of the prepaid escrow), then retry with the X-PAYMENT header
   * (base64-encoded proof). With `gasless`, nothing is sent: the client signs the
   * pay_from_escrow as a NEP-366 delegate (chain.signPayDelegate) and the proof carries it
   * for the gateway to relay. While the gateway answers `settlement_pending`, waits
   * Retry-After and retries the same proof, up to 3× (gasless: until a definitive answer, within
   * `gaslessWaitMs`). Non-402 first responses pass through. Exposes `requirements` (parsed entry) and `settlement` (decoded
   * X-PAYMENT-RESPONSE) on success.
   *
   * A redirect is never followed (`redirect: 'manual'`, whatever `init` says): a 3xx on the
   * invoice request throws REDIRECT_REFUSED before anything is paid. Once the payment went
   * through, a call the gateway does not serve (a 402 refusal of the proof, settlement still
   * pending after the retries, a 3xx, a network error or timeout) throws PaidNotServedError
   * (PAID_NOT_SERVED) carrying the proof to re-present; on the gasless rail, a delegate the
   * gateway does not serve throws GaslessNotServedError (GASLESS_NOT_SERVED) carrying it.
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

/**
 * Whether the escrow paid for a gasless call the gateway did not serve: `no` when the gateway's
 * answer settles it (a refusal before any relay, a relay that definitively failed, or
 * `delegate_expired` once no relay of the delegate can land), else `unknown`: the relay may have
 * landed, so read the escrow before buying again.
 */
export type GaslessEscrowPaid = 'no' | 'unknown';

/** A `settlement_pending` answer to a gasless call, as `onGaslessWait` reports it. */
export interface GaslessWait {
  /** 1 for the first `settlement_pending` answer, then 2, 3, … */
  attempt: number;
  /** The relay tx the gateway named, when it did. */
  transaction?: string;
  /** How long the client waits before presenting the same delegate again (ms). */
  retryInMs: number;
  /** The most the client waits in all (`gaslessWaitMs`). */
  capMs: number;
}

/**
 * GASLESS_NOT_SERVED: the gateway did not serve a gasless call. The buyer sent nothing itself:
 * the escrow paid only if the gateway's relay of the signed delegate landed. The error carries:
 *
 * - `escrowPaid`: `no` when the gateway's answer settles that the escrow did not pay, else
 *   `unknown` (read the escrow and the relay tx before buying again: a new buy is a new payment)
 * - `reason`: `refused` (a 402 refusal, `gatewayError`; after `relay_failed` the chain's
 *   `chainCode`), `settlement_pending` (the relay, `txHash` when the gateway named it, was still
 *   settling when `gaslessWaitMs` ran out), `redirect` (a 3xx, never followed) or `transport` (no
 *   answer: the gateway may have relayed it)
 * - `status`: the gateway's HTTP status, when it answered
 * - `txHash`: the relay tx the gateway named while it settled, if it did
 * - `signedDelegate`, `nonce`, `serviceId`: the proof that was presented (X-PAYMENT `{kind:
 *   'delegate', signedDelegate, nonce, payer}`), for a program that re-presents it itself
 */
export class GaslessNotServedError extends AgentGateError {
  readonly reason: PaidNotServedReason;
  readonly escrowPaid: GaslessEscrowPaid;
  readonly status: number | undefined;
  readonly gatewayError: string | undefined;
  readonly chainCode: string | undefined;
  readonly txHash: string | undefined;
  readonly nonce: string;
  readonly serviceId: number;
  /**
   * The signed delegate (base64): a bearer authorization to pay invoice `nonce` from the buyer's
   * escrow, which anyone holding it can have relayed until it expires (100 blocks). Re-present it
   * only to the gateway that issued the invoice; never log it.
   */
  readonly signedDelegate: string;

  constructor(
    sent: { signedDelegate: string; nonce: string; serviceId: number },
    reason: PaidNotServedReason,
    status: number | undefined,
    detail: string,
    answer: { escrowPaid: GaslessEscrowPaid; gatewayError?: string; chainCode?: string; txHash?: string },
  ) {
    super(
      'GASLESS_NOT_SERVED',
      `the gasless call to service ${sent.serviceId} (nonce ${sent.nonce}) was not served: ${detail}`,
      502,
    );
    this.name = 'GaslessNotServedError';
    this.reason = reason;
    this.escrowPaid = answer.escrowPaid;
    this.status = status;
    this.gatewayError = answer.gatewayError;
    this.chainCode = answer.chainCode;
    this.txHash = answer.txHash;
    this.nonce = sent.nonce;
    this.serviceId = sent.serviceId;
    this.signedDelegate = sent.signedDelegate;
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

/** Extra proof attempts while the gateway answers `settlement_pending` (the tx rails). */
const MAX_PENDING_RETRIES = 3;
/**
 * How long a gasless call keeps presenting its delegate while the gateway answers
 * `settlement_pending`, by default (ms): past the delegate's 100 blocks, the answer is definitive.
 */
export const GASLESS_WAIT_MS = 150_000;
/** The gateway's Retry-After between two presentations of a gasless delegate, clamped to this range (ms). */
const GASLESS_RETRY_MIN_MS = 1_000;
const GASLESS_RETRY_MAX_MS = 10_000;
/**
 * The gateway's refusals of a delegate on its first presentation that leave the escrow unpaid:
 * decided before any relay (the rail off, the proof, the delegate, its key and nonce, the escrow,
 * the invoice), or a relay that definitively failed.
 */
const UNPAID_REFUSALS = new Set([
  'relayer_disabled',
  'invalid_payment_header',
  'unknown_nonce',
  'invoice_expired',
  'bad_signature',
  'unknown_key',
  'key_not_allowed',
  'stale_nonce',
  'escrow_insufficient',
  'relay_failed',
]);
/** The refusal that settles a relay the gateway reported pending: it can no longer land, and did not. */
const DELEGATE_EXPIRED = 'delegate_expired';
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

/** A gateway 402's `error`, cut to 80 characters (seller data), or undefined. */
function gatewayErrorOf(body: unknown): string | undefined {
  return isRecord(body) && typeof body['error'] === 'string' ? body['error'].slice(0, 80) : undefined;
}

/**
 * The gasless offer of an invoice: the relayer account, when `extra.relayer` is a NEAR account
 * id and `extra.relayMethod` is `pay_from_escrow`. Throws RELAYER_UNAVAILABLE otherwise.
 */
function offeredRelayer(req: PaymentRequirements): string {
  const { relayer, relayMethod } = req.extra;
  if (!isNearAccountId(relayer) || relayMethod !== 'pay_from_escrow') {
    throw new AgentGateError(
      'RELAYER_UNAVAILABLE',
      `the gateway offers no gasless rail for service ${req.extra.serviceId} (its 402 names no relayer of ` +
        'pay_from_escrow) — nothing was read or signed; pay without gasless',
      402,
    );
  }
  return relayer;
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

/**
 * Escrow mode: the registry debits the service's ON-CHAIN native price + storage fee, so the
 * invoice's `maxAmountRequired` (seller data) must equal that. Reads the service from the registry
 * (prices never change for a service id) and throws SERVICE_NOT_FOUND / SERVICE_INACTIVE the way
 * `neargate buy` does, or PRICE_MISMATCH when the totals differ. Nothing is sent by then.
 */
async function assertInvoiceMatchesRegistry(chain: ChainClient, req: PaymentRequirements): Promise<void> {
  const id = req.extra.serviceId;
  const service = await chain.getService(id);
  if (service === null) {
    throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found on ${chain.registryId} — refusing to pay`, 404);
  }
  if (!service.active) {
    throw new AgentGateError(
      'SERVICE_INACTIVE',
      `service ${id} (${service.name}) is paused by its owner — not paying`,
      403,
    );
  }
  const onChainTotal = addYocto(service.priceYocto, PAYMENT_STORAGE_FEE_YOCTO);
  if (compareYocto(onChainTotal, req.maxAmountRequired) !== 0) {
    throw new AgentGateError(
      'PRICE_MISMATCH',
      `the invoice asks ${formatNear(req.maxAmountRequired)} for service ${id}, but the registry prices it at ` +
        `${formatPriceWithStorage(service.priceYocto)} (${formatNear(onChainTotal)}) and pay_from_escrow debits that ` +
        '— refusing to pay from the escrow',
      502,
    );
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Why the gateway did not serve a presented proof, as the proof loop saw it: its last answer, and
 * the `settlement_pending` answers before it (`pendings`, the last relay tx one named, how long the
 * loop waited).
 */
type Unserved = (
  | { reason: 'redirect'; status: number; location: string }
  | { reason: 'transport'; error: unknown }
  | { reason: 'refused' | 'settlement_pending'; status: number; body: unknown }
) & { pendings: number; relayTx?: string; waitedMs: number };

/** One payment rail's proof, as `presentProof` presents it. */
interface ProofRail {
  payload: NearExactPayload;
  /** The result of a served call. */
  served(res: FetchedBody): PayAndFetchResult;
  /** The error for a call the gateway did not serve. */
  notServed(what: Unserved): AgentGateError;
  /**
   * After the `attempt`-th `settlement_pending` answer `res`, `waitedMs` into the loop: how long to
   * wait before presenting the proof again (ms), or null to give up.
   */
  retryIn(res: FetchedBody, attempt: number, waitedMs: number): number | null;
  /** What the log lines name: the paid tx, or the invoice nonce of a delegate. */
  logFields: Record<string, string>;
}

/** The tx rails: the same proof again after Retry-After (2 s when none), up to MAX_PENDING_RETRIES times. */
function txRetryIn(res: FetchedBody, attempt: number): number | null {
  return attempt > MAX_PENDING_RETRIES ? null : (res.retryAfterMs ?? DEFAULT_PENDING_RETRY_MS);
}

/** PAID_NOT_SERVED for the tx rails (`pay`, `pay_from_escrow`): the deposit or the escrow is spent. */
function paidNotServed(
  proof: { txHash: string; nonce: string; serviceId: number; depositYocto: Yocto },
  what: Unserved,
): PaidNotServedError {
  switch (what.reason) {
    case 'redirect':
      return new PaidNotServedError(
        proof,
        'redirect',
        what.status,
        `the gateway answered HTTP ${what.status}, a redirect${what.location === '' ? '' : ` to ${what.location}`} (never followed)`,
      );
    case 'transport':
      return new PaidNotServedError(proof, 'transport', undefined, `the paid request failed: ${formatError(what.error)}`);
    case 'refused':
      return new PaidNotServedError(
        proof,
        'refused',
        what.status,
        `the gateway refused the proof (HTTP ${what.status} ${JSON.stringify(gatewayErrorOf(what.body) ?? 'no reason given')})`,
      );
    case 'settlement_pending':
      return new PaidNotServedError(
        proof,
        'settlement_pending',
        what.status,
        `the payment was still settling after ${MAX_PENDING_RETRIES} retries (HTTP ${what.status} ${SETTLEMENT_PENDING})`,
      );
  }
}

/** The relay tx a `settlement_pending` body names, if it names a well-formed one. */
function relayTxOf(body: unknown): string | undefined {
  const relayTx = isRecord(body) ? body['transaction'] : undefined;
  return isNearTxHash(relayTx) ? relayTx : undefined;
}

/**
 * Whether the escrow paid, as far as the gateway's answer settles it. On the first presentation, a
 * refusal of UNPAID_REFUSALS (or `delegate_*`) was decided before any relay or after one that
 * definitively failed. Once the gateway reported a relay pending, only `delegate_expired` settles
 * it: the gateway answers it once that relay can no longer land and did not.
 */
function escrowPaidAfter(what: Unserved): GaslessEscrowPaid {
  if (what.reason !== 'refused') return 'unknown';
  const error = gatewayErrorOf(what.body);
  if (error === undefined) return 'unknown';
  if (what.pendings > 0) return error === DELEGATE_EXPIRED ? 'no' : 'unknown';
  return error.startsWith('delegate_') || UNPAID_REFUSALS.has(error) ? 'no' : 'unknown';
}

/** What a GASLESS_NOT_SERVED message advises: only what the buyer can do (read the relay tx and the escrow; a new buy is a new payment). */
function gaslessAdvice(
  escrowPaid: GaslessEscrowPaid,
  relayTx: string | undefined,
  hints: { explorerUrl?: string; escrowBalanceHint: string },
): string {
  if (escrowPaid === 'no') return 'the escrow did not pay for it; buying again signs a new payment';
  const tx =
    relayTx === undefined
      ? ''
      : `the relay tx ${relayTx}${hints.explorerUrl === undefined ? '' : ` (${hints.explorerUrl}/txns/${relayTx})`} and `;
  return `the escrow may have paid: check ${tx}${hints.escrowBalanceHint} before buying again, since buying again signs a NEW payment`;
}

/** GASLESS_NOT_SERVED: the gateway's answer to a signed delegate it did not serve. */
function gaslessNotServed(
  sent: { signedDelegate: string; nonce: string; serviceId: number },
  what: Unserved,
  hints: { explorerUrl?: string; escrowBalanceHint: string },
): GaslessNotServedError {
  const escrowPaid = escrowPaidAfter(what);
  const relayTx = what.reason === 'settlement_pending' ? (relayTxOf(what.body) ?? what.relayTx) : what.relayTx;
  const known = { escrowPaid, ...(relayTx !== undefined ? { txHash: relayTx } : {}) };
  const advice = gaslessAdvice(escrowPaid, relayTx, hints);
  switch (what.reason) {
    case 'redirect':
      return new GaslessNotServedError(
        sent,
        'redirect',
        what.status,
        `the gateway answered HTTP ${what.status}, a redirect${what.location === '' ? '' : ` to ${what.location}`} ` +
          `(never followed), after the signed delegate reached it; ${advice}`,
        known,
      );
    case 'transport':
      return new GaslessNotServedError(
        sent,
        'transport',
        undefined,
        `the request failed after the signed delegate went out (${formatError(what.error)}); ${advice}`,
        known,
      );
    case 'refused': {
      const gatewayError = gatewayErrorOf(what.body) ?? 'no reason given';
      const code = isRecord(what.body) ? what.body['code'] : undefined;
      const chainCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : undefined;
      const used = gatewayError === 'invoice_used' ? ': the registry holds a payment for it the gateway did not relay, or no longer remembers relaying (a restart)' : '';
      return new GaslessNotServedError(
        sent,
        'refused',
        what.status,
        `the gateway refused the signed pay_from_escrow delegate (HTTP ${what.status} ${JSON.stringify(gatewayError)}` +
          `${chainCode === undefined ? '' : `, chain code ${chainCode}`})${used}; ${advice}`,
        { ...known, gatewayError, ...(chainCode !== undefined ? { chainCode } : {}) },
      );
    }
    case 'settlement_pending':
      return new GaslessNotServedError(
        sent,
        'settlement_pending',
        what.status,
        `the gateway's relay was still settling after ${Math.round(what.waitedMs / 1000)} s ` +
          `(HTTP ${what.status} ${SETTLEMENT_PENDING}); ${advice}`,
        { ...known, gatewayError: SETTLEMENT_PENDING },
      );
  }
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
  if (opts.gasless !== undefined && typeof opts.gasless !== 'boolean') {
    throw new AgentGateError('BAD_OPTS', 'opts.gasless must be a boolean', 500);
  }
  const gasless = opts.gasless === true;
  // Gasless pays from the escrow; null is garbage, not the default.
  const payFrom: PayFrom = opts.payFrom === undefined ? (gasless ? 'escrow' : 'deposit') : opts.payFrom;
  if (payFrom !== 'deposit' && payFrom !== 'escrow') {
    throw new AgentGateError('BAD_OPTS', 'opts.payFrom must be "deposit" or "escrow"', 500);
  }
  if (gasless && payFrom !== 'escrow') {
    throw new AgentGateError('BAD_OPTS', 'opts.gasless pays from the escrow (a relayed pay_from_escrow): payFrom must be "escrow" or unset', 500);
  }
  if (gasless && (typeof chain.escrowOf !== 'function' || typeof chain.signPayDelegate !== 'function')) {
    throw new AgentGateError('BAD_OPTS', 'opts.chain cannot sign a pay_from_escrow delegate (escrowOf, signPayDelegate): it cannot pay gasless', 500);
  }
  if (!gasless && payFrom === 'escrow' && (typeof chain.escrowOf !== 'function' || typeof chain.payFromEscrow !== 'function')) {
    throw new AgentGateError('BAD_OPTS', 'opts.chain has no escrow methods (escrowOf, payFromEscrow): it cannot pay from the escrow', 500);
  }
  const gaslessWaitMs = opts.gaslessWaitMs ?? GASLESS_WAIT_MS;
  if (typeof gaslessWaitMs !== 'number' || !Number.isFinite(gaslessWaitMs) || gaslessWaitMs < 0) {
    throw new AgentGateError('BAD_OPTS', 'opts.gaslessWaitMs must be a duration in ms (a finite number, 0 or more)', 500);
  }
  if (opts.onGaslessWait !== undefined && typeof opts.onGaslessWait !== 'function') {
    throw new AgentGateError('BAD_OPTS', 'opts.onGaslessWait must be a function', 500);
  }
  for (const key of ['explorerUrl', 'escrowBalanceHint'] as const) {
    const value = opts[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      throw new AgentGateError('BAD_OPTS', `opts.${key} must be a non-empty string`, 500);
    }
  }
  const hints = {
    ...(opts.explorerUrl !== undefined ? { explorerUrl: opts.explorerUrl.replace(/\/+$/, '') } : {}),
    escrowBalanceHint: opts.escrowBalanceHint ?? 'the escrow balance (escrowOf)',
  };
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

    // Gasless: the gateway must offer to relay a pay_from_escrow delegate; checked before anything
    // is read from the chain or signed.
    const relayer = gasless ? offeredRelayer(req) : undefined;

    // `pay_from_escrow` carries no amount: the registry debits the on-chain price + storage fee.
    // The invoice's total is the seller's word, so in escrow mode the budget and the escrow
    // pre-check run on the total the registry will actually debit, and an invoice that differs is
    // refused. (`pay` needs no such check: its attached deposit is what the call can cost.)
    if (payFrom === 'escrow') await assertInvoiceMatchesRegistry(chain, req);

    // Budget cap on the total (price + storage fee) — never pay above it.
    if (maxYocto !== undefined && compareYocto(req.maxAmountRequired, maxYocto) > 0) {
      throw new AgentGateError(
        'BUDGET_EXCEEDED',
        `invoice asks ${formatPriceWithStorage(req.extra.priceYocto, req.extra.storageFeeYocto)} ` +
          `(${formatNear(req.maxAmountRequired)} attached), above the ${formatNear(maxYocto)} cap`,
        402,
      );
    }

    // Refuse before sending (or signing) when the escrow cannot cover the total: the contract would
    // reject the call too, but only after someone paid gas for it.
    if (payFrom === 'escrow') {
      const held = await chain.escrowOf(signer.accountId);
      if (compareYocto(held, req.maxAmountRequired) < 0) {
        throw new AgentGateError(
          'ERR_ESCROW_INSUFFICIENT',
          `ERR_ESCROW_INSUFFICIENT: the escrow holds ${held} yocto, the payment needs ${req.maxAmountRequired} ` +
            '(price + storage fee); nothing was sent',
          402,
        );
      }
    }

    const paid = {
      paid: true,
      requirements: req,
      priceYocto: req.extra.priceYocto,
      depositYocto: req.maxAmountRequired,
      payFrom,
    };

    if (relayer !== undefined) {
      // The gasless rail: sign the pay_from_escrow delegate (nothing is sent from the account) and
      // let the gateway relay it. Its relay tx comes back in X-PAYMENT-RESPONSE.
      const signedDelegate = await chain.signPayDelegate({ serviceId: req.extra.serviceId, nonce: req.extra.nonce }, signer);
      logger?.info('fetchPaid: pay_from_escrow delegate signed for the gateway to relay', {
        serviceId: req.extra.serviceId,
        nonce: req.extra.nonce,
        relayer,
      });
      const sent = { signedDelegate, nonce: req.extra.nonce, serviceId: req.extra.serviceId };
      return await presentProof(url, init, {
        payload: { kind: 'delegate', signedDelegate, nonce: req.extra.nonce, payer: signer.accountId },
        served: (res) => {
          const relayTx = res.settlement?.transaction;
          return {
            status: res.status,
            body: res.body,
            settlement: res.settlement,
            ...paid,
            ...(isNearTxHash(relayTx) ? { txHash: relayTx } : {}),
            gasless: true,
            relayer,
          };
        },
        notServed: (what) => gaslessNotServed(sent, what, hints),
        retryIn: (res, attempt, waitedMs) => {
          // Until the gateway answers definitively, within the cap: never re-signed.
          const left = gaslessWaitMs - waitedMs;
          if (left <= 0) return null;
          const asked = res.retryAfterMs ?? DEFAULT_PENDING_RETRY_MS;
          const wait = Math.min(Math.max(asked, GASLESS_RETRY_MIN_MS), GASLESS_RETRY_MAX_MS, left);
          const transaction = relayTxOf(res.body);
          try {
            opts.onGaslessWait?.({ attempt, ...(transaction !== undefined ? { transaction } : {}), retryInMs: wait, capMs: gaslessWaitMs });
          } catch {
            // progress reporting never fails the call
          }
          return wait;
        },
        logFields: { nonce: req.extra.nonce },
      });
    }

    // Pay through the registry: `pay(service_id, nonce)` with price + storage fee attached, or
    // `pay_from_escrow(service_id, nonce)` with nothing attached. One rail per client, never both.
    let txHash: string;
    if (payFrom === 'escrow') {
      ({ txHash } = await chain.payFromEscrow({ serviceId: req.extra.serviceId, nonce: req.extra.nonce }, signer));
    } else {
      ({ txHash } = await chain.pay(
        { serviceId: req.extra.serviceId, nonce: req.extra.nonce, depositYocto: req.maxAmountRequired },
        signer,
      ));
    }
    logger?.info('fetchPaid: payment sent', { txHash, amountYocto: req.maxAmountRequired, payFrom });

    await sleep(settleDelayMs);

    // From here on the deposit is spent: a call that is not served throws PAID_NOT_SERVED with
    // the proof, so the caller re-presents it instead of paying a fresh invoice.
    const proof = {
      txHash,
      nonce: req.extra.nonce,
      serviceId: req.extra.serviceId,
      depositYocto: req.maxAmountRequired,
    };
    return await presentProof(url, init, {
      payload: { kind: 'tx', transaction: txHash, nonce: req.extra.nonce, payer: signer.accountId },
      served: (res) => ({ status: res.status, body: res.body, settlement: res.settlement, ...paid, txHash }),
      notServed: (what) => paidNotServed(proof, what),
      retryIn: txRetryIn,
      logFields: { txHash },
    });
  }

  /**
   * Presents the X-PAYMENT proof (a paid tx or a signed delegate) and returns the served call;
   * while the gateway answers `settlement_pending`, waits and presents the same proof again for as
   * long as the rail says (`retryIn`). A call the gateway does not serve throws the rail's error
   * (`notServed`).
   */
  async function presentProof(url: string, init: RequestInit | undefined, rail: ProofRail): Promise<PayAndFetchResult> {
    const headers = new Headers(init?.headers);
    headers.set('X-PAYMENT', encodeXPayment({
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: chain.network,
      payload: rail.payload,
    }));
    const proofInit: RequestInit = { ...init, headers };

    const startedAt = Date.now();
    let pendings = 0;
    let relayTx: string | undefined;
    const trail = (): { pendings: number; relayTx?: string; waitedMs: number } => ({
      pendings,
      ...(relayTx !== undefined ? { relayTx } : {}),
      waitedMs: Date.now() - startedAt,
    });
    for (;;) {
      let res: FetchedBody;
      try {
        res = await doFetch(url, proofInit);
      } catch (err) {
        if (err instanceof RedirectRefusedError) {
          logger?.warn('fetchPaid: paid request redirected, not followed', { url, status: err.status, ...rail.logFields });
          throw rail.notServed({ reason: 'redirect', status: err.status, location: err.location, ...trail() });
        }
        logger?.warn('fetchPaid: paid request failed', { url, ...rail.logFields, error: formatError(err) });
        throw rail.notServed({ reason: 'transport', error: err, ...trail() });
      }
      if (res.status !== 402) {
        logger?.info('fetchPaid: paid request completed', { url, status: res.status });
        return rail.served(res);
      }
      if (!isSettlementPending(res.body)) {
        logger?.warn('fetchPaid: gateway refused the proof', { url, status: res.status, ...rail.logFields });
        throw rail.notServed({ reason: 'refused', status: res.status, body: res.body, ...trail() });
      }
      pendings += 1;
      relayTx = relayTxOf(res.body) ?? relayTx;
      const wait = rail.retryIn(res, pendings, Date.now() - startedAt);
      if (wait === null) {
        logger?.warn('fetchPaid: settlement still pending, giving up', { url, status: res.status, pendings, ...rail.logFields });
        throw rail.notServed({ reason: 'settlement_pending', status: res.status, body: res.body, ...trail() });
      }
      logger?.debug('fetchPaid: settlement pending, retrying', { wait, attempt: pendings });
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
