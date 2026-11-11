import { createHash } from 'node:crypto';
import {
  AgentGateError,
  formatNear,
  isNearAccountId,
  MIN_PRICE_YOCTO,
  nativeNearOption,
  stripTrailingSlashes,
} from '@agentgate/shared';
import type {
  ActivityEvent,
  AttestationRecord,
  ServiceRecord,
  ServiceScore,
  Yocto,
} from '@agentgate/shared';

// TODO(Task 3): mirror the neargate-registry pay-through rules (pay / payments by
// nonce / storage fee / self-paid) instead of plain value transfers.

/** Activity feed retains at most this many events (oldest dropped). */
export const ACTIVITY_LOG_CAP = 500;
/** Mirrors the on-chain contract: last 100 attestations per service. */
export const ATTESTATIONS_PER_SERVICE_CAP = 100;
/**
 * Transfer-lookup ring buffer cap (oldest tx hash dropped). The mock chain's
 * faucet/transfer are unauthenticated, so bound this map to keep memory finite.
 */
export const TRANSFER_LOG_CAP = 2000;
/**
 * Hard ceiling on registered services. register-service is unauthenticated on
 * the mock chain; cap it so the registry can't grow without bound.
 */
export const MAX_SERVICES = 1000;

export interface TransferRecord {
  txHash: string;
  /** Sender account id. */
  from: string;
  /** Target account id. */
  to: string;
  amountYocto: Yocto;
  transferId: string;
  timestamp: number;
}

export interface TransferInput {
  fromAccountId: string;
  to: string;
  amountYocto: Yocto;
  transferId: string;
}

export interface RegisterInput {
  name: string;
  description: string;
  /** The GATEWAY BASE url; readers compute `<base>/svc/<id>`. */
  gatewayBaseUrl: string;
  priceYocto: Yocto;
  paymentTarget: string;
  attestor: string;
  ownerAccountId: string;
}

export interface AttestationInput {
  serviceId: number;
  nonce: string;
  paymentTxHash: string;
  success: boolean;
  byAccountId: string;
}

interface InternalService {
  id: number;
  name: string;
  description: string;
  gatewayBaseUrl: string;
  priceYocto: Yocto;
  paymentTarget: string;
  owner: string;
  attestor: string;
  active: boolean;
  createdAt: number;
}

function err(httpStatus: number, code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, httpStatus);
}

/**
 * In-memory mock chain: account balances in yocto (keyed by account id), value
 * transfers tagged with a transfer id, the registry contract's state and an
 * activity log. Enforces the registry's attestation rules (attestor-or-owner
 * auth, one attestation per payment nonce, inactive service, owner-only
 * set_active).
 */
export class DevnetState {
  private readonly balances = new Map<string, bigint>();
  private readonly transfers = new Map<string, TransferRecord>();
  /** Insertion order of `transfers` keys, oldest first — drives TRANSFER_LOG_CAP eviction. */
  private readonly transferOrder: string[] = [];
  private readonly services = new Map<number, InternalService>();
  private readonly scores = new Map<number, { total: number; success: number }>();
  /** Newest first, capped at ATTESTATIONS_PER_SERVICE_CAP per service. */
  private readonly attestations = new Map<number, AttestationRecord[]>();
  private readonly seenPayments = new Set<string>();
  /** Newest first, capped at ACTIVITY_LOG_CAP. */
  private readonly activity: ActivityEvent[] = [];
  private txCounter = 0;
  private nextServiceId = 1;

  /** Deterministic-ish 64-char tx hash: sha256(JSON.stringify(payload) + monotonic counter). TODO(Task 3): base58. */
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

  faucet(account: string, amountYocto: Yocto): { balanceYocto: Yocto } {
    const next = this.balanceOf(account) + BigInt(amountYocto);
    this.balances.set(account, next);
    return { balanceYocto: next.toString() };
  }

  getBalance(account: string): Yocto {
    return this.balanceOf(account).toString();
  }

  transfer(input: TransferInput): { txHash: string; timestamp: number } {
    const from = input.fromAccountId;
    const to = input.to;
    const amount = BigInt(input.amountYocto);
    const balance = this.balanceOf(from);
    if (balance < amount) {
      throw err(
        400,
        'insufficient_balance',
        `account ${from} has ${balance} yocto, needs ${amount} yocto`,
      );
    }
    const timestamp = Date.now();
    const txHash = this.txHash({
      kind: 'transfer',
      from,
      to,
      amountYocto: input.amountYocto,
      transferId: input.transferId,
    });
    this.balances.set(from, balance - amount);
    this.balances.set(to, this.balanceOf(to) + amount);
    const record: TransferRecord = {
      txHash,
      from,
      to,
      amountYocto: amount.toString(),
      transferId: input.transferId,
      timestamp,
    };
    this.transfers.set(txHash, record);
    this.transferOrder.push(txHash);
    while (this.transferOrder.length > TRANSFER_LOG_CAP) {
      const evicted = this.transferOrder.shift();
      if (evicted !== undefined) this.transfers.delete(evicted);
    }

    const service = [...this.services.values()].find((s) => s.paymentTarget === to) ?? null;
    this.pushActivity({
      kind: 'payment',
      serviceId: service?.id ?? null,
      account: from,
      txHash,
      blockHeight: this.txCounter,
      amountYocto: amount.toString(),
      nonce: input.transferId,
      timestamp,
      detail: `payment of ${formatNear(amount.toString())} to ${to} (nonce ${input.transferId})`,
    });
    return { txHash, timestamp };
  }

  getTransfer(txHash: string): TransferRecord {
    const record = this.transfers.get(txHash);
    if (!record) throw err(404, 'transfer_not_found', `no transfer with tx hash ${txHash}`);
    return record;
  }

  // ---- registry (mirrors the registry contract) -----------------------------

  registerService(input: RegisterInput): { serviceId: number; txHash: string } {
    if (this.services.size >= MAX_SERVICES) {
      throw err(429, 'service_limit_reached', `mock chain caps the registry at ${MAX_SERVICES} services`);
    }
    if (input.name.trim() === '') throw err(400, 'empty_name', 'service name must not be empty');
    if (BigInt(input.priceYocto) < BigInt(MIN_PRICE_YOCTO)) {
      throw err(400, 'invalid_price', `priceYocto must be ≥ ${MIN_PRICE_YOCTO} yocto`);
    }
    const paymentTarget = input.paymentTarget;
    if (!isNearAccountId(paymentTarget)) {
      throw err(400, 'invalid_payment_target', 'paymentTarget must be a NEAR account id');
    }

    const serviceId = this.nextServiceId;
    this.nextServiceId += 1;
    const createdAt = Date.now();
    const txHash = this.txHash({ kind: 'register_service', serviceId, name: input.name });
    const service: InternalService = {
      id: serviceId,
      name: input.name,
      description: input.description,
      gatewayBaseUrl: stripTrailingSlashes(input.gatewayBaseUrl),
      priceYocto: BigInt(input.priceYocto).toString(),
      paymentTarget,
      owner: input.ownerAccountId,
      attestor: input.attestor,
      active: true,
      createdAt,
    };
    this.services.set(serviceId, service);
    this.scores.set(serviceId, { total: 0, success: 0 });
    this.attestations.set(serviceId, []);

    this.pushActivity({
      kind: 'service_registered',
      serviceId,
      account: service.owner,
      txHash,
      blockHeight: this.txCounter,
      timestamp: createdAt,
      detail: `service "${input.name}" registered (id ${serviceId}) at ${formatNear(service.priceYocto)}/call`,
    });
    return { serviceId, txHash };
  }

  recordAttestation(input: AttestationInput): { txHash: string } {
    const service = this.services.get(input.serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${input.serviceId}`);
    if (input.byAccountId !== service.attestor && input.byAccountId !== service.owner) {
      throw err(
        403,
        'not_authorized',
        'attestations may only be recorded by the service attestor or owner',
      );
    }
    if (!service.active) {
      throw err(400, 'service_inactive', `service ${service.id} is inactive`);
    }
    const dupKey = `${service.id}:${input.nonce}`;
    if (this.seenPayments.has(dupKey)) {
      throw err(
        409,
        'duplicate_attestation',
        `payment ${input.nonce} already attested for service ${service.id}`,
      );
    }
    this.seenPayments.add(dupKey);

    const timestamp = Date.now();
    const txHash = this.txHash({
      kind: 'record_attestation',
      serviceId: service.id,
      nonce: input.nonce,
      paymentTxHash: input.paymentTxHash,
      success: input.success,
    });
    const score = this.scores.get(service.id) ?? { total: 0, success: 0 };
    score.total += 1;
    if (input.success) score.success += 1;
    this.scores.set(service.id, score);

    const list = this.attestations.get(service.id) ?? [];
    list.unshift({
      serviceId: service.id,
      nonce: input.nonce,
      paymentTxHash: input.paymentTxHash,
      success: input.success,
      timestamp,
    });
    if (list.length > ATTESTATIONS_PER_SERVICE_CAP) list.length = ATTESTATIONS_PER_SERVICE_CAP;
    this.attestations.set(service.id, list);

    this.pushActivity({
      kind: 'attestation',
      serviceId: service.id,
      account: input.byAccountId,
      txHash,
      blockHeight: this.txCounter,
      success: input.success,
      nonce: input.nonce,
      timestamp,
      detail: `attestation ${input.success ? 'success' : 'failure'} for service ${service.id} (payment ${input.paymentTxHash.slice(0, 10)}…)`,
    });
    return { txHash };
  }

  setActive(serviceId: number, active: boolean, byAccountId: string): { txHash: string } {
    const service = this.services.get(serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${serviceId}`);
    if (byAccountId !== service.owner) {
      throw err(403, 'not_authorized', 'only the service owner may change the active flag');
    }
    service.active = active;
    const txHash = this.txHash({ kind: 'set_active', serviceId, active });
    return { txHash };
  }

  // ---- reads ----------------------------------------------------------------

  /** Every reader computes endpointUrl = `<gateway base>/svc/<id>`. */
  private toRecord(service: InternalService): ServiceRecord {
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      endpointUrl: `${service.gatewayBaseUrl}/svc/${service.id}`,
      priceYocto: service.priceYocto,
      paymentTarget: service.paymentTarget,
      owner: service.owner,
      attestor: service.attestor,
      active: service.active,
      createdAt: service.createdAt,
      accepts: [nativeNearOption(service.priceYocto)],
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
