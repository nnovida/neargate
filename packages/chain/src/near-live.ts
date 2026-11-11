import { Account, PublicKey, Signer, getTransactionLastResult } from 'near-api-js';
import {
  AgentGateError,
  REGISTRATION_DEPOSIT_YOCTO,
  isNearAccountId,
  isNearNetwork,
  isNearTxHash,
  isRecord,
  isValidNonce,
  nativeNearOption,
  parseYocto,
} from '@agentgate/shared';
import type {
  ActivityEvent,
  AgentGateConfig,
  AnySigner,
  AttestationRecord,
  ChainClient,
  NearKeySigner,
  NearNetwork,
  PaymentRecord,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
  VerifyPaymentQuery,
  VerifyResult,
  Yocto,
} from '@agentgate/shared';
import { mapCallError } from './near-errors';
import { loadNearSigner, type LoadedNearSigner } from './near-keys';
import { NearRpc, withTimeout, type TxStatus, type ViewFinality } from './near-rpc';
import { badView, isPayAction, parseActivity, parseAttestations, parsePayment, parseScore, parseService } from './near-views';

/** Gas attached to every registry change call: 30 TGas. */
const CALL_GAS = 30_000_000_000_000n;
/** A change call that has not come back in this long fails with TX_TIMEOUT (it may still land). */
const CALL_TIMEOUT_MS = 120_000;
/** `list_services` returns at most this many services per call (the contract's LIST_LIMIT_MAX). */
const LIST_PAGE = 50;
/** `get_recent_activity` returns at most this many events (the contract's ACTIVITY_CAP). */
const ACTIVITY_CAP = 200;
const DEFAULT_ACTIVITY_LIMIT = 50;
/** The largest `limit` a list read accepts, as on the devnet's REST API. */
const MAX_QUERY_LIMIT = 1000;
/** Accounts kept for reuse, one per signing key (each tracks its key's nonce). */
const MAX_CACHED_ACCOUNTS = 16;
const YOCTO_RE = /^(0|[1-9]\d*)$/;

/**
 * What a change call waits for. `pay` and `record_attestation` return once executed: the
 * gateway reads payments with `optimistic` finality. `register_service` and `set_active` wait
 * for finality, so the `final` reads that follow them (the CLI's wrap and pause) see the change.
 */
type WaitUntil = 'EXECUTED_OPTIMISTIC' | 'FINAL';

type PayVerdict = 'unknown' | 'in_flight' | 'succeeded' | 'failed' | 'mismatch';

function invalid(message: string): AgentGateError {
  return new AgentGateError('invalid_query', message, 400);
}

function configInvalid(message: string): AgentGateError {
  return new AgentGateError('CONFIG_INVALID', message, 500);
}

/** The mock's code for a malformed account id (the devnet's ERR_INVALID_ACCOUNT_ID). */
function assertAccountId(value: unknown, field: string): void {
  if (!isNearAccountId(value)) {
    throw new AgentGateError(
      'ERR_INVALID_ACCOUNT_ID',
      `ERR_INVALID_ACCOUNT_ID: ${field} is not a valid NEAR account id`,
      400,
    );
  }
}

function assertNonEmpty(value: string, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${what} must be a non-empty string`);
  }
}

function assertServiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalid(`serviceId must be a positive integer, got ${String(id)}`);
  }
}

function checkLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new AgentGateError('invalid_limit', `"limit" must be between 1 and ${MAX_QUERY_LIMIT}`, 400);
  }
  return limit;
}

function requireNearSigner(signer: AnySigner): NearKeySigner {
  if (signer.kind !== 'near') {
    throw new AgentGateError(
      'invalid_signer',
      `LiveNearClient requires a near signer, got "${String((signer as { kind?: unknown }).kind)}"`,
      400,
    );
  }
  assertAccountId(signer.accountId, 'signer');
  return signer;
}

/**
 * A near-api-js Signer over a key resolved by `loadNearSigner`: it signs through the loader's
 * `sign` and never holds the secret key itself.
 */
class LoadedKeySigner extends Signer {
  private readonly publicKey: PublicKey;

  constructor(private readonly loaded: LoadedNearSigner) {
    super();
    this.publicKey = PublicKey.fromString(loaded.publicKey);
  }

  async getPublicKey(): Promise<PublicKey> {
    return this.publicKey;
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(this.loaded.sign(bytes), 'base64'));
  }
}

/**
 * ChainClient for the `neargate-registry` contract on NEAR testnet/mainnet, over near-api-js 7.4.0.
 *
 * Reads are contract views (`final` finality; `get_payment` uses `optimistic` so a payment
 * counts as soon as its tx executes). Writes are function calls with 30 TGas, signed with a key
 * from `loadNearSigner`. Contract panics come back as AgentGateErrors whose `code` is the
 * contract's `ERR_*` code and whose message starts with it, the same shape the mock client
 * gives, so callers handle one error format.
 */
export class LiveNearClient implements ChainClient {
  readonly network: string;
  readonly registryId: string;
  private readonly nearNetwork: NearNetwork;
  private readonly rpc: NearRpc;
  private readonly accounts = new Map<string, Account>();
  private networkCheck: Promise<void> | null = null;

  constructor(config: AgentGateConfig) {
    if (!isNearNetwork(config.nearNetwork)) throw configInvalid('NEAR_NETWORK must be "testnet" or "mainnet"');
    if (typeof config.registryContractId !== 'string' || config.registryContractId === '') {
      throw configInvalid('live mode needs the neargate-registry contract id: set REGISTRY_CONTRACT_ID');
    }
    if (!isNearAccountId(config.registryContractId)) {
      throw configInvalid('REGISTRY_CONTRACT_ID must be a NEAR account id');
    }
    let rpcUrl: URL;
    try {
      rpcUrl = new URL(config.nearRpcUrl);
    } catch {
      throw configInvalid('NEAR_RPC_URL must be a valid URL');
    }
    if (rpcUrl.protocol !== 'http:' && rpcUrl.protocol !== 'https:') {
      throw configInvalid('NEAR_RPC_URL must be http(s)');
    }
    this.nearNetwork = config.nearNetwork;
    this.network = `near-${config.nearNetwork}`;
    this.registryId = config.registryContractId;
    this.rpc = new NearRpc(config.nearRpcUrl, { network: this.network, registryId: this.registryId });
  }

  /** Readiness probe: the RPC answers `status` and serves the configured chain. */
  async ping(): Promise<void> {
    const { chainId } = await this.rpc.status();
    if (chainId !== this.nearNetwork) {
      throw configInvalid(
        `NEAR_RPC_URL serves the ${JSON.stringify(chainId.slice(0, 40))} chain, but NEAR_NETWORK is "${this.nearNetwork}"`,
      );
    }
  }

  // ---- reads ----------------------------------------------------------------

  private view(method: string, args: Record<string, unknown>, finality: ViewFinality = 'final'): Promise<unknown> {
    return this.rpc.viewCall(this.registryId, method, args, finality);
  }

  async getService(id: number): Promise<ServiceRecord | null> {
    assertServiceId(id);
    const raw = await this.view('get_service', { service_id: id });
    return raw === null ? null : parseService(raw, 'get_service');
  }

  /** Every service with a native NEAR price: `list_services` pages of 50 up to `services_count()`. */
  async listServices(): Promise<ServiceRecord[]> {
    const count = await this.view('services_count', {});
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw badView('services_count');
    const services: ServiceRecord[] = [];
    for (let from = 1; from <= count; from += LIST_PAGE) {
      const page = await this.view('list_services', { from_index: from, limit: LIST_PAGE });
      if (!Array.isArray(page)) throw badView('list_services');
      for (const raw of page) {
        const service = parseService(raw, 'list_services');
        if (service !== null) services.push(service);
      }
    }
    return services;
  }

  async getScore(id: number): Promise<ServiceScore> {
    assertServiceId(id);
    return parseScore(await this.view('get_score', { service_id: id }), 'get_score');
  }

  /** Newest first. The contract keeps the last 100; `limit` trims client-side. */
  async listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]> {
    assertServiceId(serviceId);
    const max = checkLimit(limit, MAX_QUERY_LIMIT);
    const raw = await this.view('get_attestations', { service_id: serviceId });
    return parseAttestations(raw, serviceId, 'get_attestations').slice(0, max);
  }

  /** Newest first, default 50 (the contract keeps the last 200). */
  async listRecentActivity(limit?: number): Promise<ActivityEvent[]> {
    const max = checkLimit(limit, DEFAULT_ACTIVITY_LIMIT);
    const raw = await this.view('get_recent_activity', { limit: Math.min(max, ACTIVITY_CAP) });
    return parseActivity(raw, 'get_recent_activity');
  }

  /** The account's liquid balance; an account that does not exist holds 0, as on the devnet. */
  async getBalance(accountId: string): Promise<Yocto> {
    assertAccountId(accountId, 'accountId');
    return (await this.rpc.viewAccount(accountId))?.amount ?? '0';
  }

  /** Read with `optimistic` finality: a payment counts as soon as its `pay` tx executes. */
  async getPayment(nonce: string): Promise<PaymentRecord | null> {
    assertNonEmpty(nonce, 'nonce');
    if (!isValidNonce(nonce)) return null; // `pay` only ever stores 1–20 digit nonces
    const raw = await this.view('get_payment', { nonce }, 'optimistic');
    return raw === null ? null : parsePayment(raw, 'get_payment');
  }

  /** True iff `publicKey` is a full-access key of the account (`view_access_key`, `final`). */
  async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    assertAccountId(accountId, 'accountId');
    assertNonEmpty(publicKey, 'publicKey');
    let key: string;
    try {
      key = PublicKey.fromString(publicKey).toString();
    } catch {
      return false; // not a NEAR public key, so no account holds it
    }
    const found = await this.rpc.viewAccessKey(accountId, key);
    if (found === null) return false;
    if (found.permission === 'FullAccess') return true;
    // The answer gates owner authority: only a known permission shape may say "no" quietly.
    if (isRecord(found.permission)) return false; // FunctionCall (or a gas key's permission)
    throw new AgentGateError('RPC_BAD_RESPONSE', 'the NEAR RPC answered the access key lookup without a permission', 502);
  }

  /** `view_account`: UNKNOWN_ACCOUNT is false, any other RPC failure throws. */
  async accountExists(accountId: string): Promise<boolean> {
    assertAccountId(accountId, 'accountId');
    return (await this.rpc.viewAccount(accountId)) !== null;
  }

  /**
   * Checks the registry's payment record for the nonce in the mock's order (not_found,
   * wrong_service, amount_too_low, expired, already_attested), then, when `txHash` is given,
   * that the tx is a successful `pay` of this nonce and service on this registry, signed by
   * the payer: `tx_mismatch` otherwise, `pending` while the RPC cannot show it yet. With no
   * payment recorded yet, a `pay` tx for the nonce that is still executing (or executed but
   * not yet visible to the view) is `pending`; an unknown or failed one is `not_found`.
   * Payments relayed as delegate actions (signed by a relayer) do not match here.
   */
  async verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    if (typeof q.nonce !== 'string' || !isValidNonce(q.nonce)) {
      throw invalid('nonce must be 1–20 decimal digits');
    }
    assertServiceId(q.serviceId);
    if (typeof q.minAmountYocto !== 'string' || !YOCTO_RE.test(q.minAmountYocto)) {
      throw invalid('minAmountYocto must be a yocto decimal string');
    }
    if (typeof q.maxAgeMs !== 'number' || !Number.isFinite(q.maxAgeMs) || q.maxAgeMs < 0) {
      throw invalid('maxAgeMs must be a non-negative number');
    }
    if (q.txHash !== undefined && !isNearTxHash(q.txHash)) {
      throw invalid('txHash must be a base58 NEAR transaction hash');
    }
    if (q.payer !== undefined) assertAccountId(q.payer, 'payer');

    const payment = await this.getPayment(q.nonce);
    if (payment === null) {
      if (q.txHash === undefined || q.payer === undefined) return { ok: false, reason: 'not_found' };
      const verdict = this.judgePayTx(await this.rpc.txStatus(q.txHash, q.payer), q, q.payer);
      if (verdict === 'mismatch') return { ok: false, reason: 'tx_mismatch' };
      if (verdict === 'unknown' || verdict === 'failed') return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'pending' };
    }
    if (payment.serviceId !== q.serviceId) return { ok: false, reason: 'wrong_service' };
    if (BigInt(payment.amountYocto) < BigInt(q.minAmountYocto)) return { ok: false, reason: 'amount_too_low' };
    if (Date.now() - payment.timestamp > q.maxAgeMs) return { ok: false, reason: 'expired' };
    if (payment.attested) return { ok: false, reason: 'already_attested' };
    if (q.txHash !== undefined) {
      if (q.payer !== undefined && q.payer !== payment.payer) return { ok: false, reason: 'tx_mismatch' };
      const verdict = this.judgePayTx(await this.rpc.txStatus(q.txHash, payment.payer), q, payment.payer);
      if (verdict === 'mismatch' || verdict === 'failed') return { ok: false, reason: 'tx_mismatch' };
      if (verdict !== 'succeeded') return { ok: false, reason: 'pending' };
    }
    return {
      ok: true,
      amountYocto: payment.amountYocto,
      payer: payment.payer,
      timestamp: payment.timestamp,
      selfPaid: payment.selfPaid,
    };
  }

  /** Where a tx stands as `payer`'s `pay` of q's nonce for q's service on this registry. */
  private judgePayTx(status: TxStatus | null, q: VerifyPaymentQuery, payer: string): PayVerdict {
    if (status === null) return 'unknown';
    const { outcome } = status;
    if (outcome === null) return 'in_flight';
    const isThePay =
      outcome.signerId === payer &&
      outcome.receiverId === this.registryId &&
      outcome.actions.some((action) => isPayAction(action, q.serviceId, q.nonce));
    return isThePay ? outcome.state : 'mismatch';
  }

  // ---- writes ---------------------------------------------------------------

  /** Registers a service, attaching exactly the registration deposit; returns the new id. */
  async registerService(
    input: RegisterServiceInput,
    signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    const near = requireNearSigner(signer);
    assertAccountId(input.paymentTarget, 'paymentTarget');
    assertAccountId(input.attestor, 'attestor');
    parseYocto(input.priceYocto);
    const { txHash, result } = await this.call(
      near,
      'register_service',
      {
        name: input.name,
        description: input.description,
        gateway_base_url: input.gatewayBaseUrl,
        accepts: [nativeNearOption(input.priceYocto)],
        payment_target: input.paymentTarget,
        attestor: input.attestor,
      },
      REGISTRATION_DEPOSIT_YOCTO,
      'FINAL',
    );
    if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) {
      throw new AgentGateError('RPC_BAD_RESPONSE', `register_service returned no service id (tx ${txHash})`, 502);
    }
    return { serviceId: result, txHash };
  }

  /**
   * Calls the registry's `pay` with `depositYocto` attached: the price goes to the service's
   * payment target, the storage fee stays in the registry, the rest is refunded.
   */
  async pay(
    input: { serviceId: number; nonce: string; depositYocto: Yocto },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const near = requireNearSigner(signer);
    assertServiceId(input.serviceId);
    if (typeof input.depositYocto !== 'string' || !YOCTO_RE.test(input.depositYocto)) {
      throw invalid('depositYocto must be a yocto decimal string');
    }
    parseYocto(input.depositYocto);
    const { txHash } = await this.call(
      near,
      'pay',
      { service_id: input.serviceId, nonce: input.nonce }, // the registry checks the shape (ERR_INVALID_NONCE)
      input.depositYocto,
      'EXECUTED_OPTIMISTIC',
    );
    return { txHash };
  }

  async recordAttestation(
    input: { serviceId: number; nonce: string; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const near = requireNearSigner(signer);
    assertServiceId(input.serviceId);
    const { txHash } = await this.call(
      near,
      'record_attestation',
      {
        service_id: input.serviceId,
        nonce: input.nonce,
        payment_tx_hash: input.paymentTxHash,
        success: input.success,
      },
      '0',
      'EXECUTED_OPTIMISTIC',
    );
    return { txHash };
  }

  async setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }> {
    const near = requireNearSigner(signer);
    assertServiceId(serviceId);
    const { txHash } = await this.call(near, 'set_active', { service_id: serviceId, active }, '0', 'FINAL');
    return { txHash };
  }

  /**
   * Signs and sends one registry function call with 30 TGas and `depositYocto` attached, after
   * checking the RPC serves the configured chain. Returns the tx hash and the call's JSON result.
   */
  private async call(
    signer: NearKeySigner,
    method: string,
    args: Record<string, unknown>,
    depositYocto: Yocto,
    waitUntil: WaitUntil,
  ): Promise<{ txHash: string; result: unknown }> {
    const loaded = await loadNearSigner({
      accountId: signer.accountId,
      keyPath: signer.keyPath,
      secretKey: signer.secretKey,
      network: this.nearNetwork,
    });
    await this.ensureNetwork();
    const what = `the ${method} call`;
    let outcome: Awaited<ReturnType<Account['callFunctionRaw']>>;
    try {
      outcome = await withTimeout(
        this.accountFor(signer.accountId, loaded).callFunctionRaw({
          contractId: this.registryId,
          methodName: method,
          args,
          deposit: BigInt(depositYocto),
          gas: CALL_GAS,
          waitUntil,
        }),
        CALL_TIMEOUT_MS,
        () => new AgentGateError('TX_TIMEOUT', `${what} did not come back within ${CALL_TIMEOUT_MS / 1000} s; it may still land`, 504),
      );
    } catch (err) {
      throw mapCallError(err, {
        what,
        network: this.network,
        registryId: this.registryId,
        signerId: signer.accountId,
        publicKey: loaded.publicKey,
      });
    }
    const txHash = (outcome as { transaction_outcome?: { id?: unknown } }).transaction_outcome?.id;
    if (!isNearTxHash(txHash)) {
      throw new AgentGateError('RPC_BAD_RESPONSE', `the NEAR RPC answered ${what} without a transaction hash`, 502);
    }
    return { txHash, result: getTransactionLastResult(outcome) };
  }

  /** The chain-id check runs once before the first signature (again after a failed check). */
  private ensureNetwork(): Promise<void> {
    this.networkCheck ??= this.ping().catch((err: unknown) => {
      this.networkCheck = null;
      throw err;
    });
    return this.networkCheck;
  }

  /** One Account per signing key, so its nonces stay in order across calls. */
  private accountFor(accountId: string, loaded: LoadedNearSigner): Account {
    const key = `${accountId} ${loaded.publicKey}`;
    let account = this.accounts.get(key);
    if (account === undefined) {
      account = new Account(accountId, this.rpc.provider, new LoadedKeySigner(loaded));
      this.accounts.set(key, account);
      if (this.accounts.size > MAX_CACHED_ACCOUNTS) {
        const oldest = this.accounts.keys().next().value;
        if (oldest !== undefined) this.accounts.delete(oldest);
      }
    }
    return account;
  }
}
