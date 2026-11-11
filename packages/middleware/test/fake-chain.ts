import { createHash } from 'node:crypto';
import {
  compareYocto,
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

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 of a 32-byte digest — the shape of a NEAR tx hash (43–44 chars). */
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

interface FakePayment {
  txHash: string;
  serviceId: number;
  nonce: string;
  /** The full attached deposit (the fake keeps no storage fee). */
  amountYocto: Yocto;
  payer: string;
  timestamp: number;
  /** While > 0, verifyPayment returns 'pending' and decrements. */
  pendingReads: number;
}

/**
 * Minimal in-memory ChainClient fake for middleware tests.
 * Depends ONLY on the ChainClient interface from @agentgate/shared —
 * no devnet, no chain impl details.
 * TODO(Task 4): mirror the registry rules (fee kept, `already_attested`, `selfPaid` from the contract).
 */
export class FakeChainClient implements ChainClient {
  readonly network = 'mock';
  readonly registryId = 'registry.mock';
  readonly services = new Map<number, ServiceRecord>();
  readonly attestations: AttestationRecord[] = [];
  /** Payments keyed by tx hash. */
  readonly payments = new Map<string, FakePayment>();
  /** When > 0, recordAttestation throws and decrements (retry testing). */
  failAttestations = 0;
  private counter = 0;

  private nextHash(seed: string): string {
    this.counter += 1;
    return base58(createHash('sha256').update(`${seed}:${this.counter}`).digest());
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
      accepts: [{ asset: 'near', amount: priceYocto, decimals: 24, symbol: 'NEAR' }],
      ...partial,
    };
    this.services.set(record.id, record);
    return record;
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
      selfPaid: service !== undefined && (p.payer === service.owner || p.payer === service.paymentTarget),
      attested: this.attestations.some((a) => a.nonce === p.nonce),
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
    const service = this.services.get(p.serviceId);
    return Promise.resolve({
      ok: true,
      amountYocto: p.amountYocto,
      payer: p.payer,
      timestamp: p.timestamp,
      selfPaid: service !== undefined && (p.payer === service.owner || p.payer === service.paymentTarget),
    });
  }

  isFullAccessKey(): Promise<boolean> {
    return Promise.resolve(false);
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
    this.payments.set(txHash, {
      txHash,
      serviceId: input.serviceId,
      nonce: input.nonce,
      amountYocto: input.depositYocto,
      payer: signer.accountId,
      timestamp: Date.now(),
      pendingReads: 0,
    });
    return Promise.resolve({ txHash });
  }

  recordAttestation(
    input: { serviceId: number; nonce: string; paymentTxHash: string; success: boolean },
    _signer: AnySigner,
  ): Promise<{ txHash: string }> {
    if (this.failAttestations > 0) {
      this.failAttestations -= 1;
      return Promise.reject(new Error('injected attestation failure'));
    }
    this.attestations.push({ ...input, timestamp: Date.now() });
    return Promise.resolve({ txHash: this.nextHash('attest') });
  }

  setActive(serviceId: number, active: boolean, _signer: AnySigner): Promise<{ txHash: string }> {
    const service = this.services.get(serviceId);
    if (service) service.active = active;
    return Promise.resolve({ txHash: this.nextHash('active') });
  }
}
