import { JsonRpcProvider } from 'near-api-js';
import { AccessKeyDoesNotExistError, AccountDoesNotExistError, UnknownTransactionError } from 'near-api-js/rpc-errors';
import { AgentGateError, isRecord } from '@agentgate/shared';
import { mapNearError } from './near-errors';

/** `optimistic` sees a tx's effects as soon as it executes; `final` once its block is final. */
export type ViewFinality = 'optimistic' | 'final';

/** A read the RPC has not answered within this long fails with RPC_TIMEOUT (504). */
export const RPC_READ_TIMEOUT_MS = 30_000;

/** near-api-js retries HTTP 500/503/408 itself: 4 attempts, 0.5 s, 1 s and 2 s apart. */
const RPC_RETRY = { retries: 4, wait: 500, backoff: 2 };

/**
 * Settles like `work`, or rejects with `onTimeout()` once `ms` pass first. The work itself is
 * not cancelled (near-api-js takes no abort signal); its late result is dropped.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A transaction as the `tx` method shows it, reduced to what payment verification reads. */
export interface TxStatus {
  /** `final_execution_status`: NONE, INCLUDED, EXECUTED_OPTIMISTIC, INCLUDED_FINAL, EXECUTED or FINAL. */
  executionStatus: string;
  /** null while the RPC holds no outcome for the tx (it answers with the status alone). */
  outcome: TxOutcome | null;
}

export interface TxOutcome {
  signerId: string;
  receiverId: string;
  /** The tx's actions as the RPC shows them: `{FunctionCall: {method_name, args, gas, deposit}}`, … */
  actions: unknown[];
  /** `in_flight` until the tx's result is known (status NotStarted / Started), then `succeeded` or `failed`. */
  state: 'in_flight' | 'succeeded' | 'failed';
}

function badResponse(what: string): AgentGateError {
  return new AgentGateError('RPC_BAD_RESPONSE', `the NEAR RPC answered ${what} with an unexpected shape`, 502);
}

function txState(status: unknown): TxOutcome['state'] {
  if (isRecord(status)) {
    if ('SuccessValue' in status) return 'succeeded';
    if ('Failure' in status) return 'failed';
  }
  return 'in_flight'; // NotStarted, Started, or a status this client does not know
}

/**
 * Small typed wrappers over near-api-js's JsonRpcProvider. Every read is bounded by
 * RPC_READ_TIMEOUT_MS, and every failure leaves as an AgentGateError (`mapNearError`), except
 * the "not there" answers the callers need as null.
 */
export class NearRpc {
  readonly provider: JsonRpcProvider;

  constructor(
    url: string,
    private readonly ctx: { network: string; registryId: string },
  ) {
    this.provider = new JsonRpcProvider({ url }, RPC_RETRY);
  }

  /** Calls a contract view method and returns its JSON result. */
  async viewCall<T = unknown>(
    contractId: string,
    method: string,
    args: Record<string, unknown>,
    finality: ViewFinality,
  ): Promise<T> {
    const what = `the ${method} view`;
    const raw = await this.read(what, () =>
      this.provider.callFunctionRaw({ contractId, method, args, blockQuery: { finality } }),
    );
    const bytes: unknown = raw.result;
    if (!Array.isArray(bytes) || bytes.length === 0) throw badResponse(what);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes as number[]))) as T;
    } catch {
      throw badResponse(what);
    }
  }

  /** The tx's current status as the RPC knows it (`wait_until: NONE`), or null for an unknown tx. */
  async txStatus(txHash: string, senderId: string): Promise<TxStatus | null> {
    const what = `the status of tx ${txHash}`;
    let res: unknown;
    try {
      res = await this.bounded(what, () =>
        this.provider.viewTransactionStatus({ txHash, accountId: senderId, waitUntil: 'NONE' }),
      );
    } catch (err) {
      if (err instanceof UnknownTransactionError) return null;
      throw mapNearError(err, { what, ...this.ctx });
    }
    if (!isRecord(res)) throw badResponse(what);
    const executionStatus = typeof res['final_execution_status'] === 'string' ? res['final_execution_status'] : 'NONE';
    const tx = res['transaction'];
    if (tx === undefined) return { executionStatus, outcome: null };
    if (
      !isRecord(tx) ||
      typeof tx['signer_id'] !== 'string' ||
      typeof tx['receiver_id'] !== 'string' ||
      !Array.isArray(tx['actions'])
    ) {
      throw badResponse(what);
    }
    return {
      executionStatus,
      outcome: {
        signerId: tx['signer_id'],
        receiverId: tx['receiver_id'],
        actions: tx['actions'] as unknown[],
        state: txState(res['status']),
      },
    };
  }

  /** The access key's permission (`'FullAccess'` or `{FunctionCall: …}`), or null when the account or key does not exist. */
  async viewAccessKey(accountId: string, publicKey: string): Promise<{ permission: unknown } | null> {
    const what = `the access key lookup for ${accountId}`;
    try {
      const key = await this.bounded(what, () =>
        this.provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: 'final' } }),
      );
      return { permission: key.permission };
    } catch (err) {
      if (err instanceof AccessKeyDoesNotExistError || err instanceof AccountDoesNotExistError) return null;
      throw mapNearError(err, { what, ...this.ctx });
    }
  }

  /** The account's liquid balance in yocto, or null when the account does not exist. */
  async viewAccount(accountId: string): Promise<{ amount: string } | null> {
    const what = `the account lookup for ${accountId}`;
    try {
      const account = await this.bounded(what, () =>
        this.provider.viewAccount({ accountId, blockQuery: { finality: 'final' } }),
      );
      return { amount: account.amount.toString() };
    } catch (err) {
      if (err instanceof AccountDoesNotExistError) return null;
      throw mapNearError(err, { what, ...this.ctx });
    }
  }

  /** The chain id the RPC node serves (`testnet`, `mainnet`, …). */
  async status(): Promise<{ chainId: string }> {
    const what = 'the status request';
    const res: unknown = await this.read(what, () => this.provider.viewNodeStatus());
    if (!isRecord(res) || typeof res['chain_id'] !== 'string') throw badResponse(what);
    return { chainId: res['chain_id'] };
  }

  /** `run` bounded by RPC_READ_TIMEOUT_MS; its own errors pass through untouched. */
  private bounded<T>(what: string, run: () => Promise<T>): Promise<T> {
    return withTimeout(
      run(),
      RPC_READ_TIMEOUT_MS,
      () => new AgentGateError('RPC_TIMEOUT', `the NEAR RPC did not answer ${what} within ${RPC_READ_TIMEOUT_MS / 1000} s`, 504),
    );
  }

  /** `run` bounded by RPC_READ_TIMEOUT_MS, any failure mapped to an AgentGateError. */
  private async read<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await this.bounded(what, run);
    } catch (err) {
      throw mapNearError(err, { what, ...this.ctx });
    }
  }
}
