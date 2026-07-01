/** All money values are motes of native CSPR as decimal strings (1 CSPR = 1_000_000_000 motes). U512-safe via bigint. */
export type Motes = string;

export interface ServiceRecord {
  id: number;
  name: string;
  description: string;
  endpointUrl: string;       // PUBLIC gateway URL (middleware /svc/:id) — never the upstream
  priceMotes: Motes;
  paymentTarget: string;     // "account-hash-<64hex>"
  owner: string;             // live: "account-hash-<64hex>" (from the contract); mock: public key hex
  attestor: string;          // public key hex allowed to record attestations
  active: boolean;
  createdAt: number;         // unix ms
}

export interface ServiceScore { totalCalls: number; successCalls: number; }

export interface AttestationRecord {
  serviceId: number;
  paymentDeployHash: string;
  success: boolean;
  timestamp: number;         // unix ms
  recordTxHash: string;      // the attestation tx itself
}

export interface ActivityEvent {
  kind: 'service_registered' | 'payment' | 'attestation';
  txHash: string;
  serviceId: number | null;
  amountMotes?: Motes;
  success?: boolean;
  timestamp: number;
  detail: string;            // human-readable one-liner for the dashboard feed
}

export interface RegisterServiceInput {
  name: string;
  description: string;
  endpointUrl: string;
  priceMotes: Motes;
  paymentTarget: string;
  attestor: string;
}

export interface VerifyTransferQuery {
  deployHash: string;
  expectedTarget: string;    // account-hash
  minAmountMotes: Motes;
  expectedTransferId: string;
  maxAgeMs: number;
}
export type VerifyResult =
  | { ok: true; amountMotes: Motes; from: string; timestamp: number }
  | { ok: false; reason: 'not_found' | 'wrong_target' | 'amount_too_low' | 'wrong_transfer_id' | 'expired' | 'pending' };

export interface SignerRef { kind: 'mock'; publicKey: string } // mock
export interface PemSignerRef { kind: 'pem'; pemPath: string } // live
export type AnySigner = SignerRef | PemSignerRef;

export interface ChainClient {
  readonly network: string;
  /**
   * Cheap, bounded reachability check for readiness probes (mock: ping devnet;
   * live: node-RPC status). Resolves when the backing chain is reachable, throws
   * otherwise. Optional so injected/test clients need not implement it.
   */
  ping?(): Promise<void>;
  getService(id: number): Promise<ServiceRecord | null>;
  listServices(): Promise<ServiceRecord[]>;
  getScore(id: number): Promise<ServiceScore>;
  listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]>;
  listRecentActivity(limit?: number): Promise<ActivityEvent[]>;
  getBalance(account: string): Promise<Motes>;
  verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult>;
  registerService(input: RegisterServiceInput, signer: AnySigner): Promise<{ serviceId: number; txHash: string }>;
  recordAttestation(input: { serviceId: number; paymentDeployHash: string; success: boolean }, signer: AnySigner): Promise<{ txHash: string }>;
  setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }>;
  transfer(input: { to: string; amountMotes: Motes; transferId: string }, signer: AnySigner): Promise<{ deployHash: string }>;
}
