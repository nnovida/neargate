import { Account, PublicKey, actions, getTransactionLastResult } from 'near-api-js';
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
  stripTrailingSlashes,
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
import { assertNonEmpty, assertServiceId, assertYocto, checkVerifyQuery, invalid, judgePaymentRecord } from './checks';
import { TxTimeoutError, badResponse, mapCallError } from './near-errors';
import { loadNearSigner } from './near-keys';
import { NearRpc, withTimeout, type TxStatus, type ViewFinality } from './near-rpc';
import { CallSigner } from './near-signer';
import { isPayAction, parseActivity, parseAttestations, parsePayment, parseScore, parseService } from './near-views';

/** Gas attached to every registry change call: 30 TGas. */
const CALL_GAS = 30_000_000_000_000n;
/** A change call that has not come back in this long fails: TX_TIMEOUT once its tx is signed. */
export const CALL_TIMEOUT_MS = 120_000;
/** `list_services` returns at most this many services per call (the contract's LIST_LIMIT_MAX). */
const LIST_PAGE = 50;
/** `get_recent_activity` returns at most this many events (the contract's ACTIVITY_CAP). */
const ACTIVITY_CAP = 200;
const DEFAULT_ACTIVITY_LIMIT = 50;
/** The largest `limit` a list read accepts, as on the devnet's REST API. */
const MAX_QUERY_LIMIT = 1000;
/** Signer accounts kept for reuse; each Account's nonce manager keeps its keys' nonces in order. */
const MAX_CACHED_ACCOUNTS = 16;

/**
 * What a change call waits for. `pay` and `record_attestation` return once executed: the
 * gateway reads payments with `optimistic` finality. `register_service` and `set_active` wait
 * for finality, so the `final` reads that follow them (the CLI's wrap and pause) see the change.
 */
type WaitUntil = 'EXECUTED_OPTIMISTIC' | 'FINAL';

type PayVerdict = 'unknown' | 'in_flight' | 'succeeded' | 'failed' | 'mismatch';

function configInvalid(message: string): AgentGateError {
  return new AgentGateError('CONFIG_INVALID', message, 500);
}

/** `value` as an http(s) URL string, or CONFIG_INVALID naming the setting. */
function httpUrl(value: unknown, setting: string): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw configInvalid(`${setting} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw configInvalid(`${setting} must be http(s)`);
  return String(value);
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
  private readonly explorerUrl: string;
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
    const rpcUrl = httpUrl(config.nearRpcUrl, 'NEAR_RPC_URL');
    this.explorerUrl = stripTrailingSlashes(httpUrl(config.nearExplorerUrl, 'NEAR_EXPLORER_URL'));
    this.nearNetwork = config.nearNetwork;
    this.network = `near-${config.nearNetwork}`;
    this.registryId = config.registryContractId;
    this.rpc = new NearRpc(rpcUrl, { network: this.network, registryId: this.registryId });
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
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw badResponse('the services_count view');
    }
    const services: ServiceRecord[] = [];
    for (let from = 1; from <= count; from += LIST_PAGE) {
      const page = await this.view('list_services', { from_index: from, limit: LIST_PAGE });
      if (!Array.isArray(page)) throw badResponse('the list_services view');
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
    throw badResponse('the access key lookup', 'without a permission it knows');
  }

  /** `view_account`: UNKNOWN_ACCOUNT is false, any other RPC failure throws. */
  async accountExists(accountId: string): Promise<boolean> {
    assertAccountId(accountId, 'accountId');
    return (await this.rpc.viewAccount(accountId)) !== null;
  }

  /**
   * Checks the registry's payment record for the nonce in the mock's order (`judgePaymentRecord`:
   * not_found, wrong_service, amount_too_low, expired, already_attested), then, when `txHash` is
   * given, that the tx is a successful `pay` of this nonce and service on this registry, signed
   * by the payer: `tx_mismatch` otherwise, `pending` while the RPC cannot show it yet. With no
   * payment recorded yet, a `pay` tx for the nonce that is still executing (or executed but not
   * yet visible to the view) is `pending`; an unknown or failed one is `not_found`.
   * Payments relayed as delegate actions (signed by a relayer) do not match here.
   */
  async verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    checkVerifyQuery(q);
    if (q.txHash !== undefined && !isNearTxHash(q.txHash)) {
      throw invalid('txHash must be a base58 NEAR transaction hash');
    }
    if (q.payer !== undefined) assertAccountId(q.payer, 'payer');

    const payment = await this.getPayment(q.nonce);
    const verdict = judgePaymentRecord(payment, q, Date.now());
    if (payment === null) {
      if (q.txHash === undefined || q.payer === undefined) return verdict;
      const tx = this.judgePayTx(await this.rpc.txStatus(q.txHash, q.payer), q, q.payer);
      if (tx === 'mismatch') return { ok: false, reason: 'tx_mismatch' };
      return tx === 'in_flight' || tx === 'succeeded' ? { ok: false, reason: 'pending' } : verdict;
    }
    if (!verdict.ok || q.txHash === undefined) return verdict;
    if (q.payer !== undefined && q.payer !== payment.payer) return { ok: false, reason: 'tx_mismatch' };
    const tx = this.judgePayTx(await this.rpc.txStatus(q.txHash, payment.payer), q, payment.payer);
    if (tx === 'mismatch' || tx === 'failed') return { ok: false, reason: 'tx_mismatch' };
    return tx === 'succeeded' ? verdict : { ok: false, reason: 'pending' };
  }

  /** Where a tx stands as `payer`'s `pay` of q's nonce for q's service on this registry. */
  private judgePayTx(status: TxStatus | null, q: VerifyPaymentQuery, payer: string): PayVerdict {
    if (status === null) return 'unknown';
    const { outcome } = status;
    // A status-only reply: NONE means the RPC has no record of the tx yet, a later status that it is on its way.
    if (outcome === null) return status.executionStatus === 'NONE' ? 'unknown' : 'in_flight';
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
      throw badResponse(`the register_service call (tx ${txHash})`, 'without a service id');
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
    assertYocto(input.depositYocto, 'depositYocto');
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
   *
   * `Account.signAndSendTransaction` builds the tx, has the CallSigner sign it (which records
   * its hash before anything is sent), re-signs with a fresh nonce on InvalidNonce, and throws
   * the parsed execution error on a `Failure` status, so contract panics keep their `ERR_*`
   * codes. Once the tx is signed, anything short of NEAR's verdict on it (a failed or timed-out
   * send, a reply without its outcome, the call's 120 s bound) is TX_TIMEOUT naming that tx.
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
    const callSigner = new CallSigner(loaded);
    let outcome: Awaited<ReturnType<Account['signAndSendTransaction']>>;
    try {
      outcome = await withTimeout(
        this.accountFor(signer.accountId).signAndSendTransaction({
          receiverId: this.registryId,
          actions: [actions.functionCall(method, args, CALL_GAS, BigInt(depositYocto))],
          waitUntil,
          signer: callSigner,
        }),
        CALL_TIMEOUT_MS,
        () => {
          callSigner.close(); // nothing more goes out for this call once the caller has its answer
          const lead = `${what} got no answer within ${CALL_TIMEOUT_MS / 1000} s`;
          return callSigner.txHash === undefined
            ? new AgentGateError('RPC_TIMEOUT', `${lead}; nothing was sent`, 504)
            : new TxTimeoutError(lead, callSigner.txHash, this.explorerUrl);
        },
      );
    } catch (err) {
      throw mapCallError(err, {
        what,
        method,
        network: this.network,
        registryId: this.registryId,
        signerId: signer.accountId,
        publicKey: loaded.publicKey,
        txHash: callSigner.txHash,
        explorerUrl: this.explorerUrl,
      });
    }
    const txHash = (outcome as { transaction_outcome?: { id?: unknown } }).transaction_outcome?.id;
    if (!isNearTxHash(txHash)) {
      // A reply without the tx's outcome (a status alone, or a shape this client cannot read) settles nothing.
      throw callSigner.txHash === undefined
        ? badResponse(what, 'without a transaction hash')
        : new TxTimeoutError(`the NEAR RPC answered ${what} without the tx's outcome`, callSigner.txHash, this.explorerUrl);
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

  /** One Account per signer account, so its nonce manager keeps each key's nonces in order across calls. */
  private accountFor(accountId: string): Account {
    let account = this.accounts.get(accountId);
    if (account === undefined) {
      account = new Account(accountId, this.rpc.provider);
      this.accounts.set(accountId, account);
      if (this.accounts.size > MAX_CACHED_ACCOUNTS) {
        const oldest = this.accounts.keys().next().value;
        if (oldest !== undefined) this.accounts.delete(oldest);
      }
    }
    return account;
  }
}
