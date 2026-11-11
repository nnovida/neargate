import { Account, getTransactionLastResult } from 'near-api-js';
import type { Action } from 'near-api-js';
import { AgentGateError, isNearTxHash } from '@agentgate/shared';
import type { NearKeySigner, NearNetwork } from '@agentgate/shared';
import { TxTimeoutError, badResponse, mapCallError } from './near-errors';
import { loadNearSigner } from './near-keys';
import { withTimeout, type NearRpc } from './near-rpc';
import { CallSigner } from './near-signer';

/** A change call that has not come back in this long fails: TX_TIMEOUT once its tx is signed. */
export const CALL_TIMEOUT_MS = 120_000;
/** Signer accounts kept for reuse; each Account's nonce manager keeps its keys' nonces in order. */
const MAX_CACHED_ACCOUNTS = 16;

/**
 * What a change call waits for. `pay`, `record_attestation` and the escrow calls return once
 * executed: the gateway reads payments, and the escrow views read balances, with `optimistic`
 * finality. `register_service`, `set_active` and the agent AddKey wait for finality, so the
 * `final` reads that follow them (the CLI's wrap and pause, an agent's first nonce lookup) see
 * the change.
 */
export type WaitUntil = 'EXECUTED_OPTIMISTIC' | 'FINAL';

export interface TxSenderContext {
  rpc: NearRpc;
  nearNetwork: NearNetwork;
  /** `near-testnet` | `near-mainnet`, for error text. */
  network: string;
  registryId: string;
  /** The explorer's base URL (no trailing slash), for the TX_TIMEOUT link. */
  explorerUrl: string;
  /** Resolves when the RPC serves the configured chain, throws otherwise (the client's `ping`). */
  ping(): Promise<void>;
}

/**
 * The one sending path of every change call (registry calls and the agent AddKey): signs and
 * sends one single-action tx, with the key `loadNearSigner` resolves, after checking the RPC serves
 * the configured chain.
 */
export class TxSender {
  private readonly accounts = new Map<string, Account>();
  private networkCheck: Promise<void> | null = null;

  constructor(private readonly ctx: TxSenderContext) {}

  /**
   * Signs and sends one single-action tx from `signer` to `receiverId`. `method` names the call in
   * errors. Returns the tx hash, the call's JSON result and the tx's whole outcome (a relay reads
   * its receipts: `judgeRelayOutcome`).
   *
   * `Account.signAndSendTransaction` builds the tx, has the CallSigner sign it (which records
   * its hash before anything is sent), re-signs with a fresh nonce on InvalidNonce, and throws
   * the parsed execution error on a `Failure` status, so contract panics keep their `ERR_*`
   * codes. Once the tx is signed, anything short of NEAR's verdict on it (a failed or timed-out
   * send, a reply without its outcome, the call's 120 s bound) is TX_TIMEOUT naming that tx.
   */
  async send(
    signer: NearKeySigner,
    receiverId: string,
    method: string,
    action: Action,
    waitUntil: WaitUntil,
  ): Promise<{ txHash: string; result: unknown; outcome: unknown }> {
    const { ctx } = this;
    const loaded = await loadNearSigner({
      accountId: signer.accountId,
      keyPath: signer.keyPath,
      secretKey: signer.secretKey,
      network: ctx.nearNetwork,
    });
    await this.ensureNetwork();
    const what = `the ${method} call`;
    const callSigner = new CallSigner(loaded);
    let outcome: Awaited<ReturnType<Account['signAndSendTransaction']>>;
    try {
      outcome = await withTimeout(
        this.accountFor(signer.accountId).signAndSendTransaction({
          receiverId,
          actions: [action],
          waitUntil,
          signer: callSigner,
        }),
        CALL_TIMEOUT_MS,
        () => {
          callSigner.close(); // nothing more goes out for this call once the caller has its answer
          const lead = `${what} got no answer within ${CALL_TIMEOUT_MS / 1000} s`;
          return callSigner.txHash === undefined
            ? new AgentGateError('RPC_TIMEOUT', `${lead}; nothing was sent`, 504)
            : new TxTimeoutError(lead, callSigner.txHash, ctx.explorerUrl);
        },
      );
    } catch (err) {
      throw mapCallError(err, {
        what,
        method,
        network: ctx.network,
        registryId: ctx.registryId,
        signerId: signer.accountId,
        publicKey: loaded.publicKey,
        txHash: callSigner.txHash,
        explorerUrl: ctx.explorerUrl,
      });
    }
    const txHash = (outcome as { transaction_outcome?: { id?: unknown } }).transaction_outcome?.id;
    if (!isNearTxHash(txHash)) {
      // A reply without the tx's outcome (a status alone, or a shape this client cannot read) settles nothing.
      throw callSigner.txHash === undefined
        ? badResponse(what, 'without a transaction hash')
        : new TxTimeoutError(`the NEAR RPC answered ${what} without the tx's outcome`, callSigner.txHash, ctx.explorerUrl);
    }
    return { txHash, result: getTransactionLastResult(outcome), outcome };
  }

  /** The chain-id check runs once before the first signature (again after a failed check). */
  private ensureNetwork(): Promise<void> {
    this.networkCheck ??= this.ctx.ping().catch((err: unknown) => {
      this.networkCheck = null;
      throw err;
    });
    return this.networkCheck;
  }

  /** One Account per signer account, so its nonce manager keeps each key's nonces in order across calls. */
  private accountFor(accountId: string): Account {
    let account = this.accounts.get(accountId);
    if (account === undefined) {
      account = new Account(accountId, this.ctx.rpc.provider);
      this.accounts.set(accountId, account);
      if (this.accounts.size > MAX_CACHED_ACCOUNTS) {
        const oldest = this.accounts.keys().next().value;
        if (oldest !== undefined) this.accounts.delete(oldest);
      }
    }
    return account;
  }
}
