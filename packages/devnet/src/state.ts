import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  AgentGateError,
  ESCROW_STORAGE_FEE_YOCTO,
  MIN_PRICE_YOCTO,
  MOCK_REGISTRY_ID,
  PAYMENT_STORAGE_FEE_YOCTO,
  REGISTRATION_DEPOSIT_YOCTO,
  addYocto,
  base58Encode,
  formatNear,
  isNearAccountId,
  isSelfPaid,
  isValidNonce,
  nativeNearOption,
  parseYocto,
  stripTrailingSlashes,
} from '@agentgate/shared';
import { rustTrim } from './trim';
import type {
  ActivityEvent,
  AttestationRecord,
  PaymentRecord,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
  Yocto,
} from '@agentgate/shared';

// The rules below copy contracts/registry/src/lib.rs: same checks, same order, same ERR_* codes
// and texts. Outside the contract sit two mock-only errors (ERR_INSUFFICIENT_BALANCE,
// ERR_INVALID_ACCOUNT_ID) and the MAX_SERVICES memory guard. The contract's ERR_STORAGE_EXCEEDED
// is not simulated: the devnet keeps no storage accounting.

/** Attestations kept per service, newest first (lib.rs MAX_ATTESTATIONS). */
export const MAX_ATTESTATIONS = 100;
/** Events the activity feed keeps, newest first (lib.rs ACTIVITY_CAP). */
export const ACTIVITY_CAP = 200;
/**
 * Memory guard for the in-process devnet, NOT a protocol rule: the contract has no cap.
 * register is unauthenticated here, so bound the registry to keep memory finite.
 */
export const MAX_SERVICES = 1000;

/**
 * Memory guard for the in-process devnet, NOT a protocol rule: the contract stores payments
 * forever. `pay` is unauthenticated here, so bound the payment table. Past the cap `pay` answers
 * 429 `devnet_capacity`; payments are never evicted, because dropping one would reopen its nonce.
 */
export const MAX_PAYMENTS = 100_000;

/** u128::MAX: the contract saturates `price + fee` here instead of overflowing. */
const U128_MAX = (1n << 128n) - 1n;

// Field limits in UTF-8 bytes, as lib.rs counts them (NAME_MAX, DESC_MAX, URL_MAX, TX_HASH_MAX).
const NAME_MAX = 64;
const DESC_MAX = 280;
const URL_MAX = 200;
const TX_HASH_MAX = 64;

/** The devnet's one full-access key for an account, as near-cli strings. */
export interface DevnetKey {
  /** `ed25519:<base58 of the 32-byte public key>` */
  publicKey: string;
  /** `ed25519:<base58 of seed || public key>` (64 bytes, the near-cli format) */
  secretKey: string;
}

/** PKCS#8 DER header for an ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The key pair every devnet account owns: an ed25519 key whose 32-byte seed is
 * `sha256('neargate-devnet-key/v1:' + accountId)`. Computed on demand, never stored, so the
 * repo holds no key material.
 */
export function deriveDevnetKey(accountId: string): DevnetKey {
  const seed = createHash('sha256').update(`neargate-devnet-key/v1:${accountId}`).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('node:crypto exported an ed25519 public key without its x coordinate');
  const publicBytes = Buffer.from(x, 'base64url');
  return {
    publicKey: `ed25519:${base58Encode(publicBytes)}`,
    secretKey: `ed25519:${base58Encode(Buffer.concat([seed, publicBytes]))}`,
  };
}

interface InternalService {
  id: number;
  name: string;
  description: string;
  /** Stored as given; readers compute `<base>/svc/<id>`. */
  gatewayBaseUrl: string;
  /** The service's one option, the native NEAR price (`accepts` is derived from it). */
  priceYocto: Yocto;
  paymentTarget: string;
  owner: string;
  attestor: string;
  active: boolean;
  createdAt: number;
}

/** A contract panic: HTTP 400 with the stable `ERR_*` code the contract panics with. */
function contractError(code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, 400);
}

/** The mock counterpart of the runtime failing to deserialize a malformed `AccountId` argument. */
function assertAccountId(value: string, field: string): void {
  if (!isNearAccountId(value)) {
    throw contractError('ERR_INVALID_ACCOUNT_ID', `${field} is not a valid NEAR account id`);
  }
}

/** lib.rs check_len: limits count UTF-8 bytes, not characters. */
function checkLen(field: string, value: string, max: number): void {
  if (Buffer.byteLength(value, 'utf8') > max) {
    throw contractError('ERR_FIELD_TOO_LONG', `${field} is longer than ${max} bytes`);
  }
}

export interface DevnetStateOptions {
  /** Stored-payment cap (default MAX_PAYMENTS); tests pass a small one. */
  maxPayments?: number;
}

/**
 * In-memory mock chain: account balances in yoctoNEAR and the registry contract's state
 * (services, payments by nonce, scores, attestations, activity ring). Every write is atomic: it
 * checks everything first, then moves balances, stores state and takes a block, so a rejected
 * call changes nothing.
 */
export class DevnetState {
  private readonly maxPayments: number;
  private readonly balances = new Map<string, bigint>();
  private readonly services = new Map<number, InternalService>();
  private readonly scores = new Map<number, { total: number; success: number }>();
  /** Newest first, capped at MAX_ATTESTATIONS per service. */
  private readonly attestations = new Map<number, AttestationRecord[]>();
  /** Keyed by nonce. Never deleted: that is what makes a nonce single-use. */
  private readonly payments = new Map<string, PaymentRecord>();
  /**
   * Prepaid escrow per account (lib.rs `escrow`). An account's first `deposit_escrow` creates its
   * entry and entries are never deleted, so a drained escrow still counts as "has an entry".
   * The registry account's balance holds every escrowed yocto.
   */
  private readonly escrow = new Map<string, bigint>();
  /** Newest first, capped at ACTIVITY_CAP. */
  private readonly activity: ActivityEvent[] = [];
  private txCounter = 0;
  private blockHeight = 0;
  private nextServiceId = 1;

  constructor(options: DevnetStateOptions = {}) {
    this.maxPayments = options.maxPayments ?? MAX_PAYMENTS;
  }

  /** Starts a block for a successful mutating call and names its transaction. */
  private nextTx(payload: unknown): { txHash: string; blockHeight: number; timestamp: number } {
    this.blockHeight += 1;
    this.txCounter += 1;
    const digest = createHash('sha256')
      .update(JSON.stringify(payload) + String(this.txCounter))
      .digest();
    // Setting the top bit makes the 32-byte value >= 2^255, which base58-encodes to exactly 44 chars.
    digest.writeUInt8(digest.readUInt8(0) | 0x80, 0);
    return { txHash: base58Encode(digest), blockHeight: this.blockHeight, timestamp: Date.now() };
  }

  private pushActivity(event: ActivityEvent): void {
    this.activity.unshift(event);
    if (this.activity.length > ACTIVITY_CAP) this.activity.length = ACTIVITY_CAP;
  }

  private balanceOf(accountId: string): bigint {
    return this.balances.get(accountId) ?? 0n;
  }

  /**
   * ERR_INSUFFICIENT_BALANCE (mock-only): NEAR rejects a transaction whose signer cannot fund the
   * attached deposit before the contract runs, so this check precedes every contract check.
   */
  private assertCanFund(accountId: string, attached: bigint): void {
    const balance = this.balanceOf(accountId);
    if (balance < attached) {
      throw contractError(
        'ERR_INSUFFICIENT_BALANCE',
        `${accountId} has ${balance} yocto, the attached deposit is ${attached} yocto`,
      );
    }
  }

  private move(from: string, to: string, amount: bigint): void {
    this.balances.set(from, this.balanceOf(from) - amount);
    this.balances.set(to, this.balanceOf(to) + amount);
  }

  private service(serviceId: number): InternalService {
    const service = this.services.get(serviceId);
    if (!service) throw contractError('ERR_SERVICE_NOT_FOUND', 'no such service');
    return service;
  }

  // ---- accounts -------------------------------------------------------------

  /** Credits an account (creating it) and returns its balance and its devnet key. */
  faucet(accountId: string, amountYocto: Yocto): { accountId: string; balanceYocto: Yocto } & DevnetKey {
    assertAccountId(accountId, 'accountId');
    const balanceYocto = addYocto(this.balanceOf(accountId).toString(), amountYocto);
    this.balances.set(accountId, BigInt(balanceYocto));
    this.blockHeight += 1;
    return { accountId, balanceYocto, ...deriveDevnetKey(accountId) };
  }

  getBalance(accountId: string): Yocto {
    assertAccountId(accountId, 'accountId');
    return this.balanceOf(accountId).toString();
  }

  /** An account exists once it has a balance record: the faucet created it or it received funds. */
  accountExists(accountId: string): boolean {
    assertAccountId(accountId, 'accountId');
    return this.balances.has(accountId);
  }

  /** True iff the devnet knows the account (it has a balance record) and `publicKey` is its key. */
  hasFullAccessKey(accountId: string, publicKey: string): boolean {
    assertAccountId(accountId, 'accountId');
    return this.balances.has(accountId) && deriveDevnetKey(accountId).publicKey === publicKey;
  }

  // ---- registry writes (lib.rs change methods) -----------------------------------

  /** lib.rs `register_service`. The registry keeps REGISTRATION_DEPOSIT_YOCTO and refunds the rest. */
  registerService(
    signer: string,
    input: RegisterServiceInput,
    depositYocto: Yocto,
  ): { serviceId: number; txHash: string } {
    assertAccountId(signer, 'signer');
    const attached = parseYocto(depositYocto);
    this.assertCanFund(signer, attached);
    assertAccountId(input.paymentTarget, 'paymentTarget');
    assertAccountId(input.attestor, 'attestor');
    const priceYocto = parseYocto(input.priceYocto);

    const name = rustTrim(input.name); // Rust's trim, not JS's: see trim.ts
    if (name === '') throw contractError('ERR_EMPTY_NAME', 'the service name must not be blank');
    checkLen('name', name, NAME_MAX);
    checkLen('description', input.description, DESC_MAX);
    checkLen('gateway_base_url', input.gatewayBaseUrl, URL_MAX);
    // validate_accepts: the devnet registers exactly one option, the native price, so only the
    // native floor can fail (and ERR_NO_NATIVE_PRICE in `pay` cannot happen).
    if (priceYocto < parseYocto(MIN_PRICE_YOCTO)) {
      throw contractError(
        'ERR_INVALID_PRICE',
        `the near amount must be at least ${MIN_PRICE_YOCTO} yocto`,
      );
    }
    if (attached < parseYocto(REGISTRATION_DEPOSIT_YOCTO)) {
      throw contractError(
        'ERR_DEPOSIT_TOO_LOW',
        `attach at least ${REGISTRATION_DEPOSIT_YOCTO} yocto (${formatNear(REGISTRATION_DEPOSIT_YOCTO)})`,
      );
    }
    if (this.services.size >= MAX_SERVICES) {
      throw new AgentGateError(
        'service_limit_reached',
        `the devnet caps the registry at ${MAX_SERVICES} services`,
        429,
      );
    }

    const serviceId = this.nextServiceId;
    this.nextServiceId += 1;
    const { txHash, blockHeight, timestamp } = this.nextTx({ kind: 'register_service', serviceId, name });
    this.move(signer, MOCK_REGISTRY_ID, parseYocto(REGISTRATION_DEPOSIT_YOCTO));
    this.services.set(serviceId, {
      id: serviceId,
      name,
      description: input.description,
      gatewayBaseUrl: input.gatewayBaseUrl,
      priceYocto: priceYocto.toString(),
      paymentTarget: input.paymentTarget,
      owner: signer,
      attestor: input.attestor,
      active: true,
      createdAt: timestamp,
    });
    this.pushActivity({
      kind: 'service_registered',
      serviceId,
      account: signer,
      txHash,
      blockHeight,
      timestamp,
      detail: `service #${serviceId} registered by ${signer}`,
    });
    return { serviceId, txHash };
  }

  /**
   * lib.rs `pay`. Debits exactly price + PAYMENT_STORAGE_FEE_YOCTO from the payer (the excess of
   * the attached deposit is never taken), credits the price to the payment target and the fee to
   * the registry.
   */
  pay(
    signer: string,
    serviceId: number,
    nonce: string,
    depositYocto: Yocto,
  ): { txHash: string } {
    assertAccountId(signer, 'signer');
    const attached = parseYocto(depositYocto);
    this.assertCanFund(signer, attached);
    return this.settlePayment(signer, serviceId, nonce, { kind: 'deposit', attached });
  }

  /**
   * lib.rs `pay_from_escrow`: `pay` funded by the signer's escrow instead of an attached deposit.
   * It takes no deposit (checked first, after the mock-only funding check), then runs the same
   * checks and settlement as `pay`; the escrow is debited price + fee, the price goes to the
   * payment target and nothing is refunded.
   */
  payFromEscrow(
    signer: string,
    serviceId: number,
    nonce: string,
    depositYocto: Yocto,
  ): { txHash: string } {
    assertAccountId(signer, 'signer');
    const attached = parseYocto(depositYocto);
    this.assertCanFund(signer, attached);
    if (attached !== 0n) {
      throw contractError(
        'ERR_DEPOSIT_NOT_ALLOWED',
        'pay_from_escrow takes no deposit, it spends the escrow',
      );
    }
    return this.settlePayment(signer, serviceId, nonce, { kind: 'escrow' });
  }

  /**
   * lib.rs `settle_payment`, shared by `pay` and `pay_from_escrow`, in the contract's order: the
   * service exists and is active; the funding covers price + fee; the nonce is valid and unused.
   * Then the escrow debit (if any), the payment record, its activity entry and the price to the
   * payment target. (ERR_NO_NATIVE_PRICE cannot happen: the devnet registers only a native price.)
   */
  private settlePayment(
    signer: string,
    serviceId: number,
    nonce: string,
    funding: { kind: 'deposit'; attached: bigint } | { kind: 'escrow' },
  ): { txHash: string } {
    const service = this.service(serviceId);
    if (!service.active) throw contractError('ERR_SERVICE_INACTIVE', 'the service is switched off');
    const price = parseYocto(service.priceYocto);
    const fee = parseYocto(PAYMENT_STORAGE_FEE_YOCTO);
    const sum = price + fee;
    const required = sum > U128_MAX ? U128_MAX : sum; // saturating, as in lib.rs
    let escrowAfter: bigint | undefined;
    if (funding.kind === 'deposit') {
      if (funding.attached < required) {
        throw contractError(
          'ERR_DEPOSIT_TOO_LOW',
          `attach at least ${required} yocto (price + storage fee)`,
        );
      }
    } else {
      const balance = this.escrow.get(signer) ?? 0n;
      if (balance < required) {
        throw contractError(
          'ERR_ESCROW_INSUFFICIENT',
          `the escrow holds ${balance} yocto, the payment needs ${required} (price + storage fee)`,
        );
      }
      escrowAfter = balance - required;
    }
    if (!isValidNonce(nonce)) {
      throw contractError('ERR_INVALID_NONCE', 'the nonce must be 1 to 20 decimal digits');
    }
    if (this.payments.has(nonce)) throw contractError('ERR_NONCE_USED', 'nonce already paid');
    if (this.payments.size >= this.maxPayments) {
      throw new AgentGateError(
        'devnet_capacity',
        `the devnet stores at most ${this.maxPayments} payments`,
        429,
      );
    }

    const { txHash, blockHeight, timestamp } = this.nextTx({
      kind: funding.kind === 'escrow' ? 'pay_from_escrow' : 'pay',
      serviceId,
      nonce,
      payer: signer,
    });
    if (escrowAfter !== undefined) {
      // The escrow sits in the registry's balance: the price leaves it, the fee stays.
      this.escrow.set(signer, escrowAfter);
      this.move(MOCK_REGISTRY_ID, service.paymentTarget, price);
    } else {
      this.move(signer, service.paymentTarget, price);
      this.move(signer, MOCK_REGISTRY_ID, fee);
    }
    this.payments.set(nonce, {
      nonce,
      serviceId,
      payer: signer,
      amountYocto: price.toString(),
      timestamp,
      blockHeight,
      selfPaid: isSelfPaid(signer, service),
      attested: false,
    });
    this.pushActivity({
      kind: 'payment',
      serviceId,
      account: signer,
      txHash,
      blockHeight,
      amountYocto: price.toString(),
      nonce,
      timestamp,
      detail: `${signer} paid ${formatNear(price.toString())} to service #${serviceId}`,
    });
    return { txHash };
  }

  /**
   * lib.rs `deposit_escrow`. The attached deposit moves to the registry. An account without an
   * escrow entry must attach more than ESCROW_STORAGE_FEE_YOCTO, which the registry keeps; the
   * rest opens the escrow. An existing entry (even a drained one) takes any deposit above zero,
   * credited in full.
   */
  depositEscrow(signer: string, depositYocto: Yocto): { txHash: string } {
    assertAccountId(signer, 'signer');
    const attached = parseYocto(depositYocto);
    this.assertCanFund(signer, attached);
    const existing = this.escrow.get(signer);
    let fee = 0n;
    if (existing !== undefined) {
      if (attached === 0n) throw contractError('ERR_DEPOSIT_TOO_LOW', 'attach a deposit');
    } else {
      fee = parseYocto(ESCROW_STORAGE_FEE_YOCTO);
      if (attached <= fee) {
        throw contractError(
          'ERR_DEPOSIT_TOO_LOW',
          `the first deposit must be more than ${ESCROW_STORAGE_FEE_YOCTO} yocto (${formatNear(ESCROW_STORAGE_FEE_YOCTO)} escrow storage fee)`,
        );
      }
    }
    const { txHash } = this.nextTx({ kind: 'deposit_escrow', payer: signer });
    this.move(signer, MOCK_REGISTRY_ID, attached);
    this.escrow.set(signer, (existing ?? 0n) + attached - fee);
    return { txHash };
  }

  /**
   * lib.rs `withdraw_escrow`: exactly 1 yocto attached (only a full-access key can do that on
   * NEAR), then 1 <= amount <= balance. The escrow is debited and `amount` goes back to the
   * signer; the 1 yocto stays in the registry. The contract's re-credit callback for a failed
   * transfer has no mock counterpart: a devnet transfer cannot fail.
   */
  withdrawEscrow(signer: string, amountYocto: Yocto, depositYocto: Yocto): { txHash: string } {
    assertAccountId(signer, 'signer');
    const attached = parseYocto(depositYocto);
    this.assertCanFund(signer, attached);
    if (attached !== 1n) {
      throw contractError(
        'ERR_ONE_YOCTO_REQUIRED',
        'attach exactly 1 yocto (only a full-access key can withdraw)',
      );
    }
    const amount = parseYocto(amountYocto);
    const balance = this.escrow.get(signer) ?? 0n;
    if (amount === 0n || amount > balance) {
      throw contractError(
        'ERR_ESCROW_INSUFFICIENT',
        `the amount must be between 1 and the escrow balance, ${balance} yocto`,
      );
    }
    const { txHash } = this.nextTx({ kind: 'withdraw_escrow', payer: signer, amount: amount.toString() });
    this.escrow.set(signer, balance - amount);
    this.move(signer, MOCK_REGISTRY_ID, attached);
    this.move(MOCK_REGISTRY_ID, signer, amount);
    return { txHash };
  }

  /** lib.rs `record_attestation`: attestor or owner only, once per payment, never a self-payment. */
  recordAttestation(
    signer: string,
    serviceId: number,
    nonce: string,
    paymentTxHash: string,
    success: boolean,
  ): { txHash: string } {
    assertAccountId(signer, 'signer');
    const service = this.service(serviceId);
    if (signer !== service.attestor && signer !== service.owner) {
      throw contractError('ERR_NOT_AUTHORIZED', 'only the attestor or the owner may attest');
    }
    if (!service.active) throw contractError('ERR_SERVICE_INACTIVE', 'the service is switched off');
    checkLen('payment_tx_hash', paymentTxHash, TX_HASH_MAX);

    const payment = this.payments.get(nonce);
    if (!payment) throw contractError('ERR_PAYMENT_NOT_FOUND', 'no payment with this nonce');
    if (payment.serviceId !== serviceId) {
      throw contractError('ERR_PAYMENT_WRONG_SERVICE', 'the payment belongs to another service');
    }
    if (payment.attested) {
      throw contractError('ERR_ALREADY_ATTESTED', 'this payment is already attested');
    }
    if (payment.selfPaid) {
      throw contractError(
        'ERR_SELF_PAYMENT',
        'the owner or payment target paid; it cannot be attested',
      );
    }

    const { txHash, blockHeight, timestamp } = this.nextTx({
      kind: 'record_attestation',
      serviceId,
      nonce,
      success,
    });
    payment.attested = true;
    const score = this.scores.get(serviceId) ?? { total: 0, success: 0 };
    score.total += 1;
    if (success) score.success += 1;
    this.scores.set(serviceId, score);

    const list = this.attestations.get(serviceId) ?? [];
    list.unshift({ serviceId, nonce, paymentTxHash, success, timestamp });
    if (list.length > MAX_ATTESTATIONS) list.length = MAX_ATTESTATIONS;
    this.attestations.set(serviceId, list);

    this.pushActivity({
      kind: 'attestation',
      serviceId,
      account: signer,
      txHash,
      blockHeight,
      success,
      nonce,
      paymentTxHash,
      timestamp,
      detail: `attested service #${serviceId} — ${success ? 'success' : 'failure'}`,
    });
    return { txHash };
  }

  /** lib.rs `set_active`: owner only. Writes no activity entry. */
  setActive(signer: string, serviceId: number, active: boolean): { txHash: string } {
    assertAccountId(signer, 'signer');
    const service = this.service(serviceId);
    if (service.owner !== signer) {
      throw contractError('ERR_NOT_AUTHORIZED', 'only the service owner may do this');
    }
    const { txHash } = this.nextTx({ kind: 'set_active', serviceId, active });
    service.active = active;
    return { txHash };
  }

  // ---- registry views -------------------------------------------------------

  /** Every reader computes endpointUrl = `<gateway base>/svc/<id>`. */
  private toRecord(service: InternalService): ServiceRecord {
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      endpointUrl: `${stripTrailingSlashes(service.gatewayBaseUrl)}/svc/${service.id}`,
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
    if (!service) throw new AgentGateError('ERR_SERVICE_NOT_FOUND', 'no such service', 404);
    return this.toRecord(service);
  }

  listServices(): ServiceRecord[] {
    return [...this.services.values()].map((s) => this.toRecord(s));
  }

  /** Unknown services score zero, like the contract's default. */
  getScore(serviceId: number): ServiceScore {
    const score = this.scores.get(serviceId);
    return { totalCalls: score?.total ?? 0, successCalls: score?.success ?? 0 };
  }

  listAttestations(serviceId: number, limit?: number): AttestationRecord[] {
    const list = this.attestations.get(serviceId) ?? [];
    return list.slice(0, limit ?? list.length);
  }

  getPayment(nonce: string): PaymentRecord {
    const payment = this.payments.get(nonce);
    if (!payment) throw new AgentGateError('ERR_PAYMENT_NOT_FOUND', 'no payment with this nonce', 404);
    return payment;
  }

  /** lib.rs `escrow_of`: `"0"` for an account that never deposited. */
  escrowOf(accountId: string): Yocto {
    assertAccountId(accountId, 'accountId');
    return (this.escrow.get(accountId) ?? 0n).toString();
  }

  listActivity(limit: number): ActivityEvent[] {
    return this.activity.slice(0, Math.min(limit, ACTIVITY_CAP));
  }
}
