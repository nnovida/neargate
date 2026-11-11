import { AgentGateError } from '@agentgate/shared';
import { TypedError } from 'near-api-js';
import {
  AccessKeyDoesNotExistError,
  AccessKeyNotFoundActionError,
  AccountDoesNotExistError,
  ContractCodeDoesNotExistError,
  ContractExecutionError,
  ContractMethodNotFoundError,
  HostGuestPanicError,
  InvalidTransactionError,
  LackBalanceForStateActionError,
  NotEnoughBalanceError,
  NotEnoughBalanceForDepositError,
  RequestRoutedError,
  RpcError,
  SignerDoesNotExistError,
  TransactionExecutionError,
  TransactionTimeoutError,
} from 'near-api-js/rpc-errors';

/** Where a NEAR failure happened, for the error text. Never carries key material or the RPC URL. */
export interface NearErrorContext {
  /** What was being done, e.g. "the get_service view" or "the pay call". */
  what: string;
  /** `near-testnet` | `near-mainnet`. */
  network: string;
  registryId: string;
}

/** A change call also names its method, its signer, the public key it signs with and the tx it signed. */
export interface CallErrorContext extends NearErrorContext {
  /** The registry method called, e.g. "pay" ("after the pay tx was sent"). */
  method: string;
  signerId: string;
  publicKey: string;
  /** The hash of the last tx the call signed, and so may have sent; undefined while nothing was signed. */
  txHash: string | undefined;
  /** The explorer's base URL (config.nearExplorerUrl, no trailing slash), for the TX_TIMEOUT link. */
  explorerUrl: string;
}

/**
 * TX_TIMEOUT (504): a registry change call's tx was sent, but its outcome is unknown: no
 * definitive NEAR verdict came back for it (the RPC stopped waiting, failed or dropped the
 * connection after the tx went out, forwarded it without waiting, answered without its outcome,
 * or the call's own bound ran out). The tx may still land: look it up before retrying, or a
 * retry can register or pay twice. The error carries what that takes:
 *
 * - `txHash`: the hash of the signed tx that was sent (its explorer page is in the message)
 */
export class TxTimeoutError extends AgentGateError {
  readonly txHash: string;
  private readonly lead: string;
  private readonly explorerUrl: string;

  /**
   * `lead` says what happened, e.g. "the NEAR RPC failed (HTTP 502) after the pay tx was sent".
   * `note`, when given, is appended as a further sentence (what the caller left behind to check).
   */
  constructor(lead: string, txHash: string, explorerUrl: string, note?: string) {
    super(
      'TX_TIMEOUT',
      `${lead}: tx ${txHash} may still land; check ${explorerUrl}/txns/${txHash} before retrying` +
        (note === undefined ? '' : `. ${note}`),
      504,
    );
    this.name = 'TxTimeoutError';
    this.txHash = txHash;
    this.lead = lead;
    this.explorerUrl = explorerUrl;
  }

  /** The same timeout with `note` appended to its message (same code, status and tx). */
  withNote(note: string): TxTimeoutError {
    return new TxTimeoutError(this.lead, this.txHash, this.explorerUrl, note);
  }
}

/** RPC_BAD_RESPONSE (502): the NEAR RPC, or the registry behind it, answered `what` in a shape this client cannot use. */
export function badResponse(what: string, how = 'with an unexpected shape'): AgentGateError {
  return new AgentGateError('RPC_BAD_RESPONSE', `the NEAR RPC answered ${what} ${how}`, 502);
}

/** A contract panic message that leads with a code: "ERR_NONCE_USED: nonce already paid". */
const ERR_CODE_RE = /^(ERR_[A-Z_]+)(?![A-Za-z0-9_])/;
/** How the runtime reports a panic in a transaction outcome (FunctionCallError.ExecutionError). */
const EXECUTION_PANIC_PREFIX = 'Smart contract panicked: ';
/** How a view call reports a panic: the VM error's Rust Debug form, inside the RPC `result.error`. */
const GUEST_PANIC_RE = /GuestPanic \{ panic_msg: "((?:[^"\\]|\\.)*)" \}/;
const MAX_TEXT = 300;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Undoes Rust's Debug string escaping (`\"`, `\\`, `\n`, …) inside a captured panic message. */
function unescapeDebug(text: string): string {
  return text.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

/** The contract's own panic text inside a near-api-js error, or null when the error is no panic. */
function panicText(err: unknown): string | null {
  if (err instanceof HostGuestPanicError) return err.panicMessage;
  if (!(err instanceof Error)) return null;
  const at = err.message.indexOf(EXECUTION_PANIC_PREFIX);
  if (at >= 0) return err.message.slice(at + EXECUTION_PANIC_PREFIX.length);
  const debug = GUEST_PANIC_RE.exec(err.message);
  return debug?.[1] === undefined ? null : unescapeDebug(debug[1]);
}

/** The hash of the failed transaction a near-api-js error carries, if any. */
function failedTxHash(err: unknown): string | undefined {
  if (err instanceof ContractExecutionError || err instanceof TransactionExecutionError) {
    const id = err.transactionResult?.transaction_outcome?.id;
    if (typeof id === 'string' && id !== '') return id;
  }
  if (err instanceof TransactionExecutionError && err.txHash !== '') return err.txHash;
  return undefined;
}

function withTx(message: string, err: unknown): string {
  const txHash = failedTxHash(err);
  return txHash === undefined ? message : `${message} (tx ${txHash})`;
}

/** A contract-level failure that is no panic: gas exhaustion, a wasm trap, a view's VM error. */
function isVmFailure(err: unknown): err is Error {
  return (
    err instanceof ContractExecutionError ||
    (err instanceof RpcError && err.message.startsWith('wasm execution failed'))
  );
}

/**
 * A failed `neargate-registry` call as an AgentGateError. A panic that leads with an `ERR_*`
 * code keeps it verbatim, in the mock client's shape: `code` is the contract's code and the
 * message is the contract's panic text ("ERR_NONCE_USED: nonce already paid"), followed by
 * " (tx <hash>)" when a transaction failed. Any other contract failure (a panic without a code,
 * gas exhaustion) is CONTRACT_ERROR (502), whose message never leads with an `ERR_*` code.
 */
export function mapContractPanic(err: unknown): AgentGateError {
  const text = panicText(err);
  const code = text === null ? undefined : ERR_CODE_RE.exec(text)?.[1];
  if (text !== null && code !== undefined) {
    return new AgentGateError(code, withTx(clip(text), err), 400);
  }
  const detail = text ?? (isVmFailure(err) ? err.message : null);
  return new AgentGateError(
    'CONTRACT_ERROR',
    withTx(detail === null ? 'the registry contract call failed' : `the registry contract failed: ${clip(detail)}`, err),
    502,
  );
}

function isContractFailure(err: unknown): boolean {
  return isVmFailure(err) || panicText(err) !== null;
}

/** The HTTP status near-api-js put on a transport-level failure (its ProviderError `cause`), or null. */
function httpStatusOf(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === 'number' && cause >= 100 ? cause : null;
}

/** The network error code under a failed `fetch` (ECONNREFUSED, ENOTFOUND, …), never its text. */
function networkCode(err: unknown): string | null {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

/** A `fetch` that got no HTTP answer at all: Node's TypeError "fetch failed", a network code under it. */
function isFetchFailure(err: unknown): err is TypeError {
  return err instanceof TypeError && (err.message === 'fetch failed' || networkCode(err) !== null);
}

/**
 * Any failure of a NEAR RPC round trip as an AgentGateError. Transport errors never repeat the
 * error's own text: near-api-js puts the RPC URL (which can embed an API key) in some of them.
 *
 * - a registry without the contract (or not this ABI) → NOT_DEPLOYED (503)
 * - a contract panic → `mapContractPanic`
 * - a transaction the RPC stopped waiting for → TX_TIMEOUT (504); one NEAR rejected → TX_FAILED (502)
 * - HTTP 408 → RPC_TIMEOUT (504): a read can simply be retried; other HTTP errors, unreachable
 *   RPC, RPC-side errors → RPC_ERROR (502). (On a sent tx, `mapCallError` makes each of these TX_TIMEOUT.)
 * - malformed JSON → RPC_BAD_RESPONSE (502)
 */
export function mapNearError(err: unknown, ctx: NearErrorContext): AgentGateError {
  if (err instanceof AgentGateError) return err;
  if (
    err instanceof ContractCodeDoesNotExistError ||
    err instanceof ContractMethodNotFoundError ||
    (err instanceof AccountDoesNotExistError && err.accountId === ctx.registryId)
  ) {
    return new AgentGateError(
      'NOT_DEPLOYED',
      `${ctx.registryId} on ${ctx.network} is not a deployed neargate-registry contract (${ctx.what})`,
      503,
    );
  }
  if (isContractFailure(err)) return mapContractPanic(err);
  if (err instanceof TransactionTimeoutError) {
    return new AgentGateError(
      'TX_TIMEOUT',
      `the NEAR RPC stopped waiting for ${ctx.what}; the transaction may still land, check it before retrying`,
      504,
    );
  }
  if (err instanceof TransactionExecutionError || err instanceof InvalidTransactionError) {
    return new AgentGateError('TX_FAILED', withTx(`NEAR rejected ${ctx.what}: ${clip(err.message)}`, err), 502);
  }
  const status = httpStatusOf(err);
  if (status === 408) return new AgentGateError('RPC_TIMEOUT', `the NEAR RPC timed out on ${ctx.what}`, 504);
  if (status !== null) {
    const why = status === 429 ? 'rate-limited' : `answered HTTP ${status} to`;
    return new AgentGateError('RPC_ERROR', `the NEAR RPC ${why} ${ctx.what}`, 502);
  }
  if (err instanceof SyntaxError) return badResponse(ctx.what, 'with malformed JSON');
  if (err instanceof RpcError) {
    // RPC-side errors (node syncing, unknown block, internal error): the node's own text.
    return new AgentGateError('RPC_ERROR', `the NEAR RPC failed ${ctx.what}: ${clip(err.message)}`, 502);
  }
  if (isFetchFailure(err)) {
    const code = networkCode(err);
    return new AgentGateError(
      'RPC_ERROR',
      `the NEAR RPC was unreachable for ${ctx.what}${code === null ? '' : ` (${code})`}`,
      502,
    );
  }
  if (err instanceof TypedError) {
    return new AgentGateError('RPC_ERROR', `the NEAR RPC gave no usable answer to ${ctx.what}`, 502);
  }
  const name = err instanceof Error ? err.name : typeof err;
  return new AgentGateError('RPC_ERROR', `the NEAR RPC round trip for ${ctx.what} failed (${name})`, 502);
}

/**
 * The definitive NEAR verdicts on a sent tx, as near-api-js parses them; only these settle its
 * outcome:
 *
 * - rejected, so it will not land: INVALID_TRANSACTION, parsed into the TransactionExecutionError
 *   for its InvalidTxError (NotEnoughBalance, Expired, InvalidSignature, an unknown access key, …),
 *   or InvalidTransactionError when the RPC gives no detail
 * - landed and failed: the tx's `Failure` outcome, parsed into a TransactionExecutionError (an
 *   action error) or a ContractExecutionError (the contract panicked or failed). No contract is
 *   called once a tx is signed, so after signing a ContractExecutionError can only be this.
 */
function isDefinitiveVerdict(err: unknown): boolean {
  return (
    err instanceof InvalidTransactionError ||
    err instanceof TransactionExecutionError ||
    err instanceof ContractExecutionError
  );
}

/** What left a sent tx without a verdict, for its TX_TIMEOUT lead; a transport error's own text is never repeated. */
function unknownOutcomeLead(err: unknown, ctx: CallErrorContext): string {
  const sent = `after the ${ctx.method} tx was sent`;
  const status = httpStatusOf(err);
  if (err instanceof TransactionTimeoutError || status === 408) return `the NEAR RPC stopped waiting for ${ctx.what}`;
  if (status !== null) return `the NEAR RPC failed (HTTP ${status}) ${sent}`;
  if (err instanceof RequestRoutedError) {
    return `the NEAR RPC forwarded the ${ctx.method} tx to another node without waiting for its outcome`;
  }
  if (err instanceof RpcError) return `the NEAR RPC failed (${clip(err.message)}) ${sent}`; // the node's own text
  if (isFetchFailure(err)) {
    const code = networkCode(err);
    return `the NEAR RPC connection failed${code === null ? '' : ` (${code})`} ${sent}`;
  }
  return `the NEAR RPC gave no usable answer ${sent}`;
}

/**
 * A failed change call (sign + send through `Account`) as an AgentGateError.
 *
 * Once the call has signed a tx (`ctx.txHash`), only a definitive NEAR verdict on it
 * (`isDefinitiveVerdict`) maps as listed below. Any other failure (an HTTP error after
 * near-api-js's retries, a dropped connection, REQUEST_ROUTED, TIMEOUT_ERROR, a reply this client
 * cannot read) leaves the tx's outcome unknown: TxTimeoutError (TX_TIMEOUT, 504) naming the tx,
 * which may still land. Before anything is signed nothing was sent, and a failure maps as for a
 * read (RPC_TIMEOUT, RPC_ERROR, …): a retry is safe.
 *
 * - NEAR refusing a tx the signer cannot fund (NotEnoughBalance), or one that leaves an account
 *   short of its storage stake (LackBalanceForState) → ERR_INSUFFICIENT_BALANCE (400), the mock's code
 * - a signing key that is not an access key of the signer → SIGNER_KEY_NOT_FOUND (400)
 * - a signer account that does not exist → SIGNER_ACCOUNT_NOT_FOUND (400)
 * - anything else → `mapNearError`: a contract panic keeps its `ERR_*` code, another rejection or
 *   failed action is TX_FAILED
 */
export function mapCallError(err: unknown, ctx: CallErrorContext): AgentGateError {
  if (err instanceof AgentGateError) return err; // this client's own answer, e.g. the call's time bound
  if (ctx.txHash !== undefined && !isDefinitiveVerdict(err)) {
    return new TxTimeoutError(unknownOutcomeLead(err, ctx), ctx.txHash, ctx.explorerUrl);
  }
  if (err instanceof NotEnoughBalanceError || err instanceof NotEnoughBalanceForDepositError) {
    return new AgentGateError(
      'ERR_INSUFFICIENT_BALANCE',
      `ERR_INSUFFICIENT_BALANCE: ${err.signerId} has ${err.balance.toString()} yocto, the transaction needs ` +
        `${err.cost.toString()} yocto (deposit + gas)`,
      400,
    );
  }
  if (err instanceof LackBalanceForStateActionError) {
    return new AgentGateError(
      'ERR_INSUFFICIENT_BALANCE',
      withTx(
        `ERR_INSUFFICIENT_BALANCE: ${err.accountId} cannot cover its storage after this transaction ` +
          `(${err.amount.toString()} yocto required)`,
        err,
      ),
      400,
    );
  }
  if (err instanceof AccessKeyDoesNotExistError || err instanceof AccessKeyNotFoundActionError) {
    return new AgentGateError(
      'SIGNER_KEY_NOT_FOUND',
      `${ctx.publicKey} is not an access key of ${ctx.signerId} on ${ctx.network}`,
      400,
    );
  }
  if (
    err instanceof SignerDoesNotExistError ||
    (err instanceof AccountDoesNotExistError && err.accountId !== ctx.registryId)
  ) {
    return new AgentGateError(
      'SIGNER_ACCOUNT_NOT_FOUND',
      `the signer account ${ctx.signerId} does not exist on ${ctx.network}`,
      400,
    );
  }
  return mapNearError(err, ctx);
}
