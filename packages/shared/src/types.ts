/**
 * All NEAR amounts are yoctoNEAR as decimal strings (1 NEAR = 10^24 yocto).
 * u128-safe via bigint; never go through Number.
 */
export type Yocto = string;

/**
 * One accepted payment option for a service, as stored by the
 * `neargate-registry` contract (`accepts[]`). `asset` is `'near'` for native
 * NEAR (the only option the registry `pay` rail settles); `amount` is in the
 * asset's atomic units (yocto for NEAR).
 */
export interface PaymentOption {
  asset: string;
  amount: Yocto;
  decimals: number;
  symbol: string;
}

export interface ServiceRecord {
  id: number;
  name: string;
  description: string;
  endpointUrl: string;       // PUBLIC gateway URL (`<gateway base>/svc/<id>`) — never the upstream
  priceYocto: Yocto;         // the native NEAR option's amount
  paymentTarget: string;     // NEAR account that receives the price
  owner: string;             // NEAR account that registered the service
  attestor: string;          // NEAR account allowed to record attestations (besides the owner)
  active: boolean;
  createdAt: number;         // unix ms
  accepts: PaymentOption[];
}

export interface ServiceScore { totalCalls: number; successCalls: number; }

export interface AttestationRecord {
  serviceId: number;
  nonce: string;             // the payment's invoice nonce
  paymentTxHash: string;     // hash of the `pay` transaction being attested
  success: boolean;
  timestamp: number;         // unix ms
}

/** A payment held by the registry (`get_payment(nonce)`). */
export interface PaymentRecord {
  nonce: string;
  serviceId: number;
  payer: string;
  amountYocto: Yocto;        // the price forwarded to the payment target
  timestamp: number;         // unix ms
  blockHeight: number;
  /** The payer is the service owner or payment target: served, never attested. */
  selfPaid: boolean;
  attested: boolean;
}

export interface ActivityEvent {
  kind: 'service_registered' | 'payment' | 'attestation';
  serviceId: number | null;
  account: string;           // the acting account (owner, payer or attestor)
  txHash: string | null;     // null when the source cannot attribute a tx hash
  blockHeight: number;
  amountYocto?: Yocto;
  success?: boolean;
  nonce?: string;
  timestamp: number;         // unix ms
  detail: string;            // human-readable one-liner for the dashboard feed
}

export interface RegisterServiceInput {
  name: string;
  description: string;
  /** Gateway base URL; readers derive `endpointUrl = <base>/svc/<id>`. */
  gatewayBaseUrl: string;
  priceYocto: Yocto;
  paymentTarget: string;
  attestor: string;
}

export interface VerifyPaymentQuery {
  nonce: string;
  serviceId: number;
  minAmountYocto: Yocto;
  maxAgeMs: number;
  /** When given, live mode also checks the tx is a `pay` call on the registry with this nonce. */
  txHash?: string;
  payer?: string;
}

export type VerifyResult =
  | { ok: true; amountYocto: Yocto; payer: string; timestamp: number; selfPaid: boolean }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'wrong_service'
        | 'amount_too_low'
        | 'expired'
        | 'pending'
        | 'already_attested'
        | 'tx_mismatch';
    };

/** Mock-mode signer: the devnet trusts the named account. */
export interface MockSigner { kind: 'mock'; accountId: string }

/**
 * Live signer for a NEAR account. Key resolution order: `secretKey`
 * (`ed25519:…`), then `keyPath` (near-cli JSON), then
 * `~/.near-credentials/<network>/<accountId>.json`.
 */
export interface NearKeySigner { kind: 'near'; accountId: string; keyPath?: string; secretKey?: string }

export type AnySigner = MockSigner | NearKeySigner;

export interface ChainClient {
  /** `near-testnet` | `near-mainnet` | `near-mock`. */
  readonly network: string;
  /** Account id of the `neargate-registry` contract. */
  readonly registryId: string;
  /**
   * Cheap, bounded reachability check for readiness probes (mock: ping devnet;
   * live: RPC status). Resolves when the backing chain is reachable, throws
   * otherwise. Optional so injected/test clients need not implement it.
   */
  ping?(): Promise<void>;
  getService(id: number): Promise<ServiceRecord | null>;
  listServices(): Promise<ServiceRecord[]>;
  getScore(id: number): Promise<ServiceScore>;
  listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]>;
  listRecentActivity(limit?: number): Promise<ActivityEvent[]>;
  getBalance(accountId: string): Promise<Yocto>;
  getPayment(nonce: string): Promise<PaymentRecord | null>;
  verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult>;
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
  registerService(input: RegisterServiceInput, signer: AnySigner): Promise<{ serviceId: number; txHash: string }>;
  pay(input: { serviceId: number; nonce: string; depositYocto: Yocto }, signer: AnySigner): Promise<{ txHash: string }>;
  recordAttestation(
    input: { serviceId: number; nonce: string; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }>;
  setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }>;
}
