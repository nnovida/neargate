import { createHash } from 'node:crypto';
import {
  AgentGateError,
  base58Encode,
  compareYocto,
  isSelfPaid,
  nativeNearOption,
  PAYMENT_STORAGE_FEE_YOCTO,
  type ActivityEvent,
  type AnySigner,
  type AttestationRecord,
  type ChainClient,
  type PaymentRecord,
  type RegisterServiceInput,
  type ServiceRecord,
  type ServiceScore,
  type VerifyPaymentQuery,
  type VerifyResult,
  type Yocto,
} from '@agentgate/shared';

interface FakePayment {
  txHash: string;
  serviceId: number;
  nonce: string;
  /** The price forwarded to the seller: the attached deposit minus the storage fee the registry keeps. */
  amountYocto: Yocto;
  payer: string;
  timestamp: number;
  /** Fixed at pay time by the registry rule: the payer is the service owner or payment target. */
  selfPaid: boolean;
  attested: boolean;
  /** While > 0, verifyPayment returns 'pending' and decrements. */
  pendingReads: number;
}

/** A contract panic as the chain clients surface it: `code` is the ERR_* code and the message starts with it. */
export function contractError(code: string, text: string): AgentGateError {
  return new AgentGateError(code, `${code}: ${text}`, 400);
}

/**
 * In-memory ChainClient fake for middleware tests.
 * Depends ONLY on the ChainClient interface from @agentgate/shared (no devnet, no chain
 * client), and mirrors the registry's rules where the gateway relies on them: the storage fee
 * is kept out of the forwarded amount, `selfPaid` comes from the registry, a payment is
 * attested once (`ERR_ALREADY_ATTESTED`), and only the service's attestor or owner may attest.
 * It stays lenient on `pay` (no ERR_DEPOSIT_TOO_LOW) so a test can produce an `amount_too_low`
 * verdict.
 */
export class FakeChainClient implements ChainClient {
  readonly network = 'near-mock';
  readonly registryId = 'registry.mock';
  readonly services = new Map<number, ServiceRecord>();
  readonly attestations: AttestationRecord[] = [];
  /** Payments keyed by tx hash. */
  readonly payments = new Map<string, FakePayment>();
  /** Full-access keys per account (`isFullAccessKey`); any other key counts as function-call-only. */
  readonly fullAccessKeys = new Map<string, Set<string>>();
  /** When > 0, recordAttestation throws a plain Error and decrements (retry testing). */
  failAttestations = 0;
  /** When set, every recordAttestation rejects with this error (e.g. a contract ERR_* panic). */
  attestationFailure: Error | null = null;
  /** Number of recordAttestation calls received, failed or not. */
  attestationCalls = 0;
  /** When set, isFullAccessKey rejects with this error (chain unreachable). */
  keyLookupFailure: Error | null = null;
  private counter = 0;

  private nextHash(seed: string): string {
    this.counter += 1;
    return base58Encode(createHash('sha256').update(`${seed}:${this.counter}`).digest());
  }

  addService(partial: Partial<ServiceRecord> & { id: number }): ServiceRecord {
    const priceYocto = partial.priceYocto ?? '500000000000000000000000';
    const record: ServiceRecord = {
      name: `service-${partial.id}`,
      description: 'test service',
      endpointUrl: `http://gateway.test/svc/${partial.id}`,
      priceYocto,
      paymentTarget: 'seller.mock',
      owner: 'owner.mock',
      attestor: 'attestor.mock',
      active: true,
      createdAt: Date.now(),
      accepts: [nativeNearOption(priceYocto)],
      ...partial,
    };
    this.services.set(record.id, record);
    return record;
  }

  /** Grants `publicKey` full access on `accountId`. */
  addFullAccessKey(accountId: string, publicKey: string): void {
    const keys = this.fullAccessKeys.get(accountId) ?? new Set<string>();
    keys.add(publicKey);
    this.fullAccessKeys.set(accountId, keys);
  }

  /** Marks an existing payment as settling for the next `reads` verify calls. */
  setPending(txHash: string, reads: number): void {
    const payment = this.payments.get(txHash);
    if (!payment) throw new Error(`no such payment: ${txHash}`);
    payment.pendingReads = reads;
  }

  getService(id: number): Promise<ServiceRecord | null> {
    return Promise.resolve(this.services.get(id) ?? null);
  }

  listServices(): Promise<ServiceRecord[]> {
    return Promise.resolve([...this.services.values()]);
  }

  getScore(id: number): Promise<ServiceScore> {
    const mine = this.attestations.filter((a) => a.serviceId === id);
    return Promise.resolve({
      totalCalls: mine.length,
      successCalls: mine.filter((a) => a.success).length,
    });
  }

  listAttestations(serviceId: number, limit = 50): Promise<AttestationRecord[]> {
    return Promise.resolve(
      this.attestations
        .filter((a) => a.serviceId === serviceId)
        .slice(-limit)
        .reverse(),
    );
  }

  listRecentActivity(): Promise<ActivityEvent[]> {
    return Promise.resolve([]);
  }

  getBalance(): Promise<Yocto> {
    return Promise.resolve('0');
  }

  getPayment(nonce: string): Promise<PaymentRecord | null> {
    const p = [...this.payments.values()].find((x) => x.nonce === nonce);
    if (!p) return Promise.resolve(null);
    const service = this.services.get(p.serviceId);
    return Promise.resolve({
      nonce: p.nonce,
      serviceId: p.serviceId,
      payer: p.payer,
      amountYocto: p.amountYocto,
      timestamp: p.timestamp,
      blockHeight: 0,
      selfPaid: p.selfPaid,
      attested: p.attested,
    });
  }

  verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    const p =
      q.txHash !== undefined
        ? this.payments.get(q.txHash)
        : [...this.payments.values()].find((x) => x.nonce === q.nonce);
    if (!p) return Promise.resolve({ ok: false, reason: 'not_found' });
    if (p.pendingReads > 0) {
      p.pendingReads -= 1;
      return Promise.resolve({ ok: false, reason: 'pending' });
    }
    if (p.nonce !== q.nonce) return Promise.resolve({ ok: false, reason: 'tx_mismatch' });
    if (p.serviceId !== q.serviceId) return Promise.resolve({ ok: false, reason: 'wrong_service' });
    if (compareYocto(p.amountYocto, q.minAmountYocto) < 0) {
      return Promise.resolve({ ok: false, reason: 'amount_too_low' });
    }
    if (Date.now() - p.timestamp > q.maxAgeMs) return Promise.resolve({ ok: false, reason: 'expired' });
    if (p.attested) return Promise.resolve({ ok: false, reason: 'already_attested' });
    return Promise.resolve({
      ok: true,
      amountYocto: p.amountYocto,
      payer: p.payer,
      timestamp: p.timestamp,
      selfPaid: p.selfPaid,
    });
  }

  // The gateway only reads payments: the escrow surface is not part of what it does.
  escrowOf(): Promise<string> {
    return Promise.resolve('0');
  }

  depositEscrow(): Promise<{ txHash: string }> {
    return Promise.reject(new Error('FakeChainClient: the gateway never deposits to an escrow'));
  }

  withdrawEscrow(): Promise<{ txHash: string }> {
    return Promise.reject(new Error('FakeChainClient: the gateway never withdraws from an escrow'));
  }

  payFromEscrow(): Promise<{ txHash: string }> {
    return Promise.reject(new Error('FakeChainClient: the gateway never pays'));
  }

  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    if (this.keyLookupFailure) return Promise.reject(this.keyLookupFailure);
    return Promise.resolve(this.fullAccessKeys.get(accountId)?.has(publicKey) ?? false);
  }

  /** Accounts that exist: any added to `knownAccounts`, plus every account holding a full-access key. */
  readonly knownAccounts = new Set<string>();

  accountExists(accountId: string): Promise<boolean> {
    return Promise.resolve(this.knownAccounts.has(accountId) || this.fullAccessKeys.has(accountId));
  }

  registerService(input: RegisterServiceInput, signer: AnySigner): Promise<{ serviceId: number; txHash: string }> {
    const serviceId = this.services.size + 1;
    this.addService({
      id: serviceId,
      name: input.name,
      description: input.description,
      endpointUrl: `${input.gatewayBaseUrl}/svc/${serviceId}`,
      priceYocto: input.priceYocto,
      paymentTarget: input.paymentTarget,
      attestor: input.attestor,
      owner: signer.accountId,
    });
    return Promise.resolve({ serviceId, txHash: this.nextHash('register') });
  }

  pay(
    input: { serviceId: number; nonce: string; depositYocto: Yocto },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const txHash = this.nextHash('pay');
    const service = this.services.get(input.serviceId);
    const deposit = BigInt(input.depositYocto);
    const fee = BigInt(PAYMENT_STORAGE_FEE_YOCTO);
    this.payments.set(txHash, {
      txHash,
      serviceId: input.serviceId,
      nonce: input.nonce,
      amountYocto: (deposit > fee ? deposit - fee : 0n).toString(),
      payer: signer.accountId,
      timestamp: Date.now(),
      selfPaid: service !== undefined && isSelfPaid(signer.accountId, service),
      attested: false,
      pendingReads: 0,
    });
    return Promise.resolve({ txHash });
  }

  recordAttestation(
    input: { serviceId: number; nonce: string; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    this.attestationCalls += 1;
    if (this.attestationFailure) return Promise.reject(this.attestationFailure);
    if (this.failAttestations > 0) {
      this.failAttestations -= 1;
      return Promise.reject(new Error('injected attestation failure'));
    }
    // The registry's checks, in its order.
    const service = this.services.get(input.serviceId);
    if (!service) return Promise.reject(contractError('ERR_SERVICE_NOT_FOUND', 'no such service'));
    if (signer.accountId !== service.attestor && signer.accountId !== service.owner) {
      return Promise.reject(contractError('ERR_NOT_AUTHORIZED', 'only the attestor or the owner may attest'));
    }
    const payment = [...this.payments.values()].find((p) => p.nonce === input.nonce);
    if (!payment) return Promise.reject(contractError('ERR_PAYMENT_NOT_FOUND', 'no payment with this nonce'));
    if (payment.serviceId !== input.serviceId) {
      return Promise.reject(contractError('ERR_PAYMENT_WRONG_SERVICE', 'the payment belongs to another service'));
    }
    if (payment.attested) {
      return Promise.reject(contractError('ERR_ALREADY_ATTESTED', 'this payment is already attested'));
    }
    if (payment.selfPaid) {
      return Promise.reject(
        contractError('ERR_SELF_PAYMENT', 'the owner or payment target paid; it cannot be attested'),
      );
    }
    payment.attested = true;
    this.attestations.push({ ...input, timestamp: Date.now() });
    return Promise.resolve({ txHash: this.nextHash('attest') });
  }

  setActive(serviceId: number, active: boolean, _signer: AnySigner): Promise<{ txHash: string }> {
    const service = this.services.get(serviceId);
    if (service) service.active = active;
    return Promise.resolve({ txHash: this.nextHash('active') });
  }
}
