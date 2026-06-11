import { createHash } from 'node:crypto';
import { AgentGateError, formatCspr } from '@agentgate/shared';
import type {
  ActivityEvent,
  AttestationRecord,
  Motes,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';

/** Activity feed retains at most this many events (oldest dropped). SPEC §3. */
export const ACTIVITY_LOG_CAP = 500;
/** Mirrors the on-chain contract: last 100 attestations per service. SPEC §10. */
export const ATTESTATIONS_PER_SERVICE_CAP = 100;
/** Mirrors the on-chain contract: price must be ≥ 1000 motes. SPEC §10. */
export const MIN_PRICE_MOTES = 1000n;

const ACCOUNT_HASH_RE = /^account-hash-[0-9a-f]{64}$/;

/** Mock account-hash derivation: `account-hash-<sha256(pubkey) hex>`. SPEC §3/§4. */
export function deriveAccountHash(publicKey: string): string {
  return `account-hash-${createHash('sha256').update(publicKey).digest('hex')}`;
}

/**
 * Normalizes any account identifier to the balance-map key:
 * already an account-hash → lowercased as-is; otherwise treated as a public key
 * and derived (mirrors how Casper addresses funds by account hash).
 */
export function normalizeAccount(account: string): string {
  const lower = account.toLowerCase();
  return ACCOUNT_HASH_RE.test(lower) ? lower : deriveAccountHash(account);
}

export interface TransferRecord {
  deployHash: string;
  fromPublicKey: string;
  /** Sender account-hash (derived from fromPublicKey). */
  from: string;
  /** Target account-hash. */
  to: string;
  amountMotes: Motes;
  transferId: string;
  timestamp: number;
}

export interface TransferInput {
  fromPublicKey: string;
  to: string;
  amountMotes: Motes;
  transferId: string;
}

export interface RegisterInput {
  name: string;
  description: string;
  /** The GATEWAY BASE url; readers compute `<base>/svc/<id>` (SPEC §9 final decision). */
  endpointUrl: string;
  priceMotes: Motes;
  paymentTarget: string;
  attestor: string;
  ownerPublicKey: string;
}

export interface AttestationInput {
  serviceId: number;
  paymentDeployHash: string;
  success: boolean;
  byPublicKey: string;
}

interface InternalService {
  id: number;
  name: string;
  description: string;
  gatewayBaseUrl: string;
  priceMotes: Motes;
  paymentTarget: string;
  owner: string;
  attestor: string;
  active: boolean;
  createdAt: number;
}

function err(httpStatus: number, code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, httpStatus);
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * In-memory mock of exactly what AgentGate uses on Casper: account balances in
 * motes, native transfers with transfer_id, the registry contract's state and
 * an activity log. Enforces the same rules as the Odra contract (attestor-or-owner
 * auth, duplicate payment hash, inactive service, owner-only set_active).
 */
export class DevnetState {
  private readonly balances = new Map<string, bigint>();
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly services = new Map<number, InternalService>();
  private readonly scores = new Map<number, { total: number; success: number }>();
  /** Newest first, capped at ATTESTATIONS_PER_SERVICE_CAP per service. */
  private readonly attestations = new Map<number, AttestationRecord[]>();
  private readonly seenPayments = new Set<string>();
  /** Newest first, capped at ACTIVITY_LOG_CAP. */
  private readonly activity: ActivityEvent[] = [];
  private txCounter = 0;
  private nextServiceId = 1;

  /** Deterministic-ish 64-char tx hash: sha256(JSON.stringify(payload) + monotonic counter). */
  private txHash(payload: unknown): string {
    this.txCounter += 1;
    return createHash('sha256')
      .update(JSON.stringify(payload) + String(this.txCounter))
      .digest('hex');
  }

  private pushActivity(event: ActivityEvent): void {
    this.activity.unshift(event);
    if (this.activity.length > ACTIVITY_LOG_CAP) this.activity.length = ACTIVITY_LOG_CAP;
  }

  private balanceOf(accountKey: string): bigint {
    return this.balances.get(accountKey) ?? 0n;
  }

  // ---- balances & transfers -------------------------------------------------

  faucet(account: string, amountMotes: Motes): { balanceMotes: Motes } {
    const key = normalizeAccount(account);
    const next = this.balanceOf(key) + BigInt(amountMotes);
    this.balances.set(key, next);
    return { balanceMotes: next.toString() };
  }

  getBalance(account: string): Motes {
    return this.balanceOf(normalizeAccount(account)).toString();
  }

  transfer(input: TransferInput): { deployHash: string; timestamp: number } {
    const from = deriveAccountHash(input.fromPublicKey);
    const to = normalizeAccount(input.to);
    const amount = BigInt(input.amountMotes);
    const balance = this.balanceOf(from);
    if (balance < amount) {
      throw err(
        400,
        'insufficient_balance',
        `account ${from} has ${balance} motes, needs ${amount} motes`,
      );
    }
    const timestamp = Date.now();
    const deployHash = this.txHash({
      kind: 'transfer',
      from,
      to,
      amountMotes: input.amountMotes,
      transferId: input.transferId,
    });
    this.balances.set(from, balance - amount);
    this.balances.set(to, this.balanceOf(to) + amount);
    const record: TransferRecord = {
      deployHash,
      fromPublicKey: input.fromPublicKey,
      from,
      to,
      amountMotes: amount.toString(),
      transferId: input.transferId,
      timestamp,
    };
    this.transfers.set(deployHash, record);

    const service = [...this.services.values()].find((s) => s.paymentTarget === to) ?? null;
    this.pushActivity({
      kind: 'payment',
      txHash: deployHash,
      serviceId: service?.id ?? null,
      amountMotes: amount.toString(),
      timestamp,
      detail: `payment of ${formatCspr(amount.toString())} to ${to} (transfer_id ${input.transferId})`,
    });
    return { deployHash, timestamp };
  }

  getTransfer(deployHash: string): TransferRecord {
    const record = this.transfers.get(deployHash);
    if (!record) throw err(404, 'transfer_not_found', `no transfer with deploy hash ${deployHash}`);
    return record;
  }

  // ---- registry (mirrors the Odra contract) ---------------------------------

  registerService(input: RegisterInput): { serviceId: number; txHash: string } {
    if (input.name.trim() === '') throw err(400, 'empty_name', 'service name must not be empty');
    if (BigInt(input.priceMotes) < MIN_PRICE_MOTES) {
      throw err(400, 'invalid_price', `priceMotes must be ≥ ${MIN_PRICE_MOTES} motes`);
    }
    const paymentTarget = input.paymentTarget.toLowerCase();
    if (!ACCOUNT_HASH_RE.test(paymentTarget)) {
      throw err(
        400,
        'invalid_payment_target',
        'paymentTarget must be "account-hash-<64 hex chars>"',
      );
    }

    const serviceId = this.nextServiceId;
    this.nextServiceId += 1;
    const createdAt = Date.now();
    const txHash = this.txHash({ kind: 'register_service', serviceId, name: input.name });
    const service: InternalService = {
      id: serviceId,
      name: input.name,
      description: input.description,
      gatewayBaseUrl: stripTrailingSlashes(input.endpointUrl),
      priceMotes: BigInt(input.priceMotes).toString(),
      paymentTarget,
      owner: input.ownerPublicKey,
      attestor: input.attestor,
      active: true,
      createdAt,
    };
    this.services.set(serviceId, service);
    this.scores.set(serviceId, { total: 0, success: 0 });
    this.attestations.set(serviceId, []);

    this.pushActivity({
      kind: 'service_registered',
      txHash,
      serviceId,
      timestamp: createdAt,
      detail: `service "${input.name}" registered (id ${serviceId}) at ${formatCspr(service.priceMotes)}/call`,
    });
    return { serviceId, txHash };
  }

  recordAttestation(input: AttestationInput): { txHash: string } {
    const service = this.services.get(input.serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${input.serviceId}`);
    if (input.byPublicKey !== service.attestor && input.byPublicKey !== service.owner) {
      throw err(
        403,
        'not_authorized',
        'attestations may only be recorded by the service attestor or owner',
      );
    }
    if (!service.active) {
      throw err(400, 'service_inactive', `service ${service.id} is inactive`);
    }
    const dupKey = `${service.id}:${input.paymentDeployHash}`;
    if (this.seenPayments.has(dupKey)) {
      throw err(
        409,
        'duplicate_attestation',
        `payment ${input.paymentDeployHash} already attested for service ${service.id}`,
      );
    }
    this.seenPayments.add(dupKey);

    const timestamp = Date.now();
    const txHash = this.txHash({
      kind: 'record_attestation',
      serviceId: service.id,
      paymentDeployHash: input.paymentDeployHash,
      success: input.success,
    });
    const score = this.scores.get(service.id) ?? { total: 0, success: 0 };
    score.total += 1;
    if (input.success) score.success += 1;
    this.scores.set(service.id, score);

    const list = this.attestations.get(service.id) ?? [];
    list.unshift({
      serviceId: service.id,
      paymentDeployHash: input.paymentDeployHash,
      success: input.success,
      timestamp,
      recordTxHash: txHash,
    });
    if (list.length > ATTESTATIONS_PER_SERVICE_CAP) list.length = ATTESTATIONS_PER_SERVICE_CAP;
    this.attestations.set(service.id, list);

    this.pushActivity({
      kind: 'attestation',
      txHash,
      serviceId: service.id,
      success: input.success,
      timestamp,
      detail: `attestation ${input.success ? 'success' : 'failure'} for service ${service.id} (payment ${input.paymentDeployHash.slice(0, 10)}…)`,
    });
    return { txHash };
  }

  setActive(serviceId: number, active: boolean, byPublicKey: string): { txHash: string } {
    const service = this.services.get(serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${serviceId}`);
    if (byPublicKey !== service.owner) {
      throw err(403, 'not_authorized', 'only the service owner may change the active flag');
    }
    service.active = active;
    const txHash = this.txHash({ kind: 'set_active', serviceId, active });
    return { txHash };
  }

  // ---- reads ----------------------------------------------------------------

  /** SPEC §9 final decision: every reader computes endpointUrl = `<gateway base>/svc/<id>`. */
  private toRecord(service: InternalService): ServiceRecord {
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      endpointUrl: `${service.gatewayBaseUrl}/svc/${service.id}`,
      priceMotes: service.priceMotes,
      paymentTarget: service.paymentTarget,
      owner: service.owner,
      attestor: service.attestor,
      active: service.active,
      createdAt: service.createdAt,
    };
  }

  getService(serviceId: number): ServiceRecord {
    const service = this.services.get(serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${serviceId}`);
    return this.toRecord(service);
  }

  listServices(): ServiceRecord[] {
    return [...this.services.values()].map((s) => this.toRecord(s));
  }

  getScore(serviceId: number): ServiceScore {
    const score = this.scores.get(serviceId);
    return { totalCalls: score?.total ?? 0, successCalls: score?.success ?? 0 };
  }

  listAttestations(serviceId: number, limit?: number): AttestationRecord[] {
    const list = this.attestations.get(serviceId) ?? [];
    return list.slice(0, limit ?? list.length);
  }

  listActivity(limit: number): ActivityEvent[] {
    return this.activity.slice(0, limit);
  }
}
