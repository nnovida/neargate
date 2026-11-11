import { AgentGateError } from './errors';
import type { Yocto } from './types';

export const X402_VERSION = 1;
export const X402_SCHEME = 'exact';
export const X402_ASSET_NEAR = 'NEAR';

/**
 * NEAR-specific requirement data. The buyer settles by calling
 * `<contractId>.pay({service_id: serviceId, nonce})` with
 * `priceYocto + storageFeeYocto` attached.
 */
export interface NearPaymentExtra {
  nonce: string;
  serviceId: number;
  expiresAtMs: number;
  settlement: 'neargate-registry-pay';
  contractId: string;
  method: 'pay';
  priceYocto: Yocto;
  storageFeeYocto: Yocto;
  /** The service's payment target (receives exactly `priceYocto`). */
  seller: string;
  /** CAIP-2 id: `near:testnet` | `near:mainnet` | `near:mock`. */
  caip2: string;
  /** Present only when the gateway relays signed delegate actions (gasless rail). */
  relayer?: string;
}

/** One acceptable way to pay (an entry in `accepts[]`). */
export interface PaymentRequirements {
  scheme: string;              // 'exact'
  network: string;             // chain.network: near-testnet | near-mainnet | near-mock
  maxAmountRequired: Yocto;    // price + storage fee
  asset: string;               // 'NEAR'
  payTo: string;               // registry contract id
  resource: string;            // absolute URL of /svc/:id
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra: NearPaymentExtra;
}

export interface PaymentRequiredResponse {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

/**
 * The X-PAYMENT payload:
 * - `tx`: the buyer called `pay` itself; `transaction` is the base58 tx hash.
 * - `delegate`: a base64 borsh NEP-366 `SignedDelegate` the gateway relays.
 */
export type NearExactPayload =
  | { kind: 'tx'; transaction: string; nonce: string; payer: string }
  | { kind: 'delegate'; signedDelegate: string; nonce: string; payer: string };

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: NearExactPayload;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

/** Same rule as the registry contract: `^[0-9]{1,20}$`. */
const NONCE_RE = /^[0-9]{1,20}$/;
/** A NEAR tx hash: base58 of 32 bytes (43–44 chars). */
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** Strict, padded standard base64. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Upper bound on a relayed SignedDelegate (base64 chars); far above a single `pay` action. */
const SIGNED_DELEGATE_MAX = 16_384;
/** One dot-separated part of a NEAR account id. */
const ACCOUNT_PART_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * NEAR account id rules: 2–64 chars, dot-separated parts of lowercase
 * alphanumerics joined by single `-` or `_`. Covers named, sub- and implicit
 * (64-hex) accounts.
 */
export function isNearAccountId(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 2 || s.length > 64) return false;
  return s.split('.').every((part) => ACCOUNT_PART_RE.test(part));
}

/** CAIP-2 id for a chain network: `near-testnet` → `near:testnet`. Idempotent for CAIP-2 input. */
export function caip2For(network: string): string {
  if (network.includes(':')) return network;
  const reference = network.startsWith('near-') ? network.slice('near-'.length) : network;
  return `near:${reference}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badPayment(why: string): AgentGateError {
  return new AgentGateError('INVALID_PAYMENT', `invalid X-PAYMENT: ${why}`, 402);
}

export function encodeXPayment(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

function decodePayload(payload: Record<string, unknown>): NearExactPayload {
  const kind = payload['kind'];
  if (kind !== 'tx' && kind !== 'delegate') throw badPayment('payload.kind must be "tx" or "delegate"');
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw badPayment('payload.nonce must be 1–20 decimal digits');
  const payer = payload['payer'];
  if (!isNearAccountId(payer)) throw badPayment('payload.payer must be a NEAR account id');
  if (kind === 'tx') {
    const transaction = payload['transaction'];
    if (typeof transaction !== 'string' || !TX_HASH_RE.test(transaction)) {
      throw badPayment('payload.transaction must be a base58 tx hash (43–44 chars)');
    }
    return { kind, transaction, nonce, payer };
  }
  const signedDelegate = payload['signedDelegate'];
  if (
    typeof signedDelegate !== 'string' ||
    signedDelegate === '' ||
    signedDelegate.length > SIGNED_DELEGATE_MAX ||
    !BASE64_RE.test(signedDelegate)
  ) {
    throw badPayment('payload.signedDelegate must be a base64 SignedDelegate');
  }
  return { kind, signedDelegate, nonce, payer };
}

export function decodeXPayment(header: string): PaymentPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw badPayment('not base64-encoded JSON');
  }
  if (!isRecord(json)) throw badPayment('not a JSON object');
  if (json['x402Version'] !== X402_VERSION) throw badPayment(`unsupported x402Version (expected ${X402_VERSION})`);
  if (json['scheme'] !== X402_SCHEME) throw badPayment(`unsupported scheme (expected "${X402_SCHEME}")`);
  const network = json['network'];
  if (typeof network !== 'string' || network.trim() === '') throw badPayment('network must be a non-empty string');
  const payload = json['payload'];
  if (!isRecord(payload)) throw badPayment('payload must be an object');
  return {
    x402Version: X402_VERSION,
    scheme: X402_SCHEME,
    network,
    payload: decodePayload(payload),
  };
}

export function encodeXPaymentResponse(s: SettlementResponse): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64');
}

export function decodeXPaymentResponse(header: string): SettlementResponse {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE is not base64-encoded JSON', 402);
  }
  if (!isRecord(json)) throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE is not a JSON object', 402);
  if (typeof json['success'] !== 'boolean') throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE: success must be a boolean', 402);
  if (typeof json['transaction'] !== 'string' || json['transaction'] === '') throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE: transaction must be a non-empty string', 402);
  if (typeof json['network'] !== 'string' || json['network'] === '') throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE: network must be a non-empty string', 402);
  const out: SettlementResponse = {
    success: json['success'],
    transaction: json['transaction'],
    network: json['network'],
  };
  if (typeof json['payer'] === 'string') out.payer = json['payer'];
  if (typeof json['errorReason'] === 'string') out.errorReason = json['errorReason'];
  return out;
}
