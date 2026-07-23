import { AgentGateError } from './errors';
import type { PaymentOption } from './types';

export const X402_VERSION = 1;
export const X402_SCHEME = 'exact';
export const X402_ASSET_CSPR = 'CSPR';

/** Casper-specific requirement data. `nonce` MUST be used as the native transfer_id. */
export interface CasperPaymentExtra {
  nonce: string;
  serviceId: number;
  expiresAtMs: number;
  settlement: 'casper-native-transfer';
  transferIdEncoding: 'u64-decimal';
}

/** One acceptable way to pay (an entry in `accepts[]`). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string; // motes (atomic), decimal string
  asset: string;             // 'CSPR'
  payTo: string;             // account-hash-<64hex>
  resource: string;          // absolute URL of /svc/:id
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra: CasperPaymentExtra;
}

export interface PaymentRequiredResponse {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface CasperExactPayload {
  transaction: string; // deploy hash of the settled native transfer
  transferId: string;  // = the issued nonce
  from?: string;       // payer account-hash
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: CasperExactPayload;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

const NONCE_RE = /^\d{1,20}$/;
const DEPLOY_HASH_RE = /^[0-9a-fA-F]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badPayment(why: string): AgentGateError {
  return new AgentGateError('INVALID_PAYMENT', `invalid X-PAYMENT: ${why}`, 402);
}

export function encodeXPayment(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
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
  if (typeof json['network'] !== 'string' || json['network'].trim() === '') throw badPayment('network must be a non-empty string');
  const payload = json['payload'];
  if (!isRecord(payload)) throw badPayment('payload must be an object');
  const transaction = payload['transaction'];
  const transferId = payload['transferId'];
  if (typeof transaction !== 'string' || !DEPLOY_HASH_RE.test(transaction)) throw badPayment('payload.transaction must be a 64-hex deploy hash');
  if (typeof transferId !== 'string' || !NONCE_RE.test(transferId)) throw badPayment('payload.transferId must be a u64 decimal string');
  if (BigInt(transferId) > 18446744073709551615n) throw badPayment('payload.transferId exceeds u64 max');
  const out: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: X402_SCHEME,
    network: json['network'],
    payload: { transaction, transferId },
  };
  if (typeof payload['from'] === 'string') out.payload.from = payload['from'];
  return out;
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

// ───────────────────────────────────────────────────────────────────────────
// x402 v2 — the OFFICIAL Casper facilitator rail (CEP-18 + EIP-712).
//
// Coexists with the native v1 rail above. A service is EITHER native or
// facilitator-enabled; both sides discriminate on the top-level `x402Version`
// (2 → facilitator, 1 → native), never by sniffing fields. The PAYMENT-SIGNATURE
// header itself is encoded/decoded with @x402/core/http in the client/middleware
// (spec-compliant); shared only owns the dependency-free types + helpers.
// ───────────────────────────────────────────────────────────────────────────

export const X402_VERSION_V2 = 2;

/** Header the buyer sends on the paid retry for the facilitator rail. */
export const HEADER_PAYMENT_SIGNATURE = 'payment-signature';

/** EIP-712 token domain descriptor for a CEP-18 facilitator asset. */
export interface FacilitatorTokenMeta {
  name: string;
  version: string;
  decimals: number;
  symbol: string;
  /** x402 `extra` is an open bag; keep it assignable to Record<string, unknown>. */
  [key: string]: unknown;
}

/** Per-service facilitator config (from FACILITATOR_SERVICES), keyed by service id. */
export interface FacilitatorServiceConfig {
  /** CEP-18 contract package hash (64 hex, no prefix). */
  asset: string;
  /** Price per call in the token's atomic units (decimal string). */
  amount: string;
  token: FacilitatorTokenMeta;
}

const CEP18_ASSET_RE = /^hash-([0-9a-f]{64})$/;

/**
 * Derives the facilitator-rail config from a service's on-chain registry-v2
 * `accepts[]`: the first CEP-18 option (asset `hash-<64hex>`) becomes the
 * facilitator price; native-only (or absent/legacy) accepts → undefined, i.e.
 * the native-transfer rail. The env `FACILITATOR_SERVICES` map stays as an
 * operator override — callers check it first.
 */
export function facilitatorConfigFromAccepts(
  accepts: readonly PaymentOption[] | undefined,
): FacilitatorServiceConfig | undefined {
  for (const option of accepts ?? []) {
    const match = CEP18_ASSET_RE.exec(option.asset);
    if (match?.[1] !== undefined) {
      return {
        asset: match[1],
        amount: option.amount,
        token: {
          name: option.name,
          version: option.version,
          decimals: option.decimals,
          symbol: option.symbol,
        },
      };
    }
  }
  return undefined;
}

/** CAIP-2 network identifier, e.g. `casper:casper-test`. */
export type Caip2Network = `${string}:${string}`;

/** Official x402 v2 PaymentRequirements — the shape @x402/core + the facilitator expect. */
export interface X402V2Requirements {
  scheme: string; // 'exact'
  network: Caip2Network; // CAIP-2, e.g. 'casper:casper-test'
  asset: string; // CEP-18 package hash (64 hex)
  amount: string; // token atomic units
  payTo: string; // '00' + account-hash (66 hex)
  resource?: string;
  maxTimeoutSeconds: number;
  extra: FacilitatorTokenMeta;
}

/** The 402 body a facilitator-enabled service returns. */
export interface X402V2Required {
  x402Version: 2;
  error?: string;
  accepts: X402V2Requirements[];
}

const ACCOUNT_HASH_RE = /^(?:account-hash-)?[0-9a-f]{64}$/i;

/** casper-test → casper:casper-test (CAIP-2). Idempotent if already CAIP-2. */
export function toCaip2Network(casperNetwork: string): Caip2Network {
  return (casperNetwork.includes(':') ? casperNetwork : `casper:${casperNetwork}`) as Caip2Network;
}

/** account-hash-<64hex> → 00<64hex> (the 66-hex address the x402 v2 payload uses). */
export function payToFromAccountHash(paymentTarget: string): string {
  if (!ACCOUNT_HASH_RE.test(paymentTarget)) {
    throw new AgentGateError('INVALID_ACCOUNT_HASH', `not an account-hash: ${paymentTarget}`, 400);
  }
  return `00${paymentTarget.replace(/^account-hash-/i, '').toLowerCase()}`;
}
