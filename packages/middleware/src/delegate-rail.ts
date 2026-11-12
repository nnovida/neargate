import {
  PAY_DELEGATE_GAS,
  PAY_DELEGATE_METHOD,
  inspectPayDelegate,
  payDelegateTiming,
  verifyDelegateSignature,
  type DecodedDelegate,
} from '@agentgate/chain/delegate';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  compareYocto,
  timedOutTxHash,
  type AccessKeyInfo,
  type AnySigner,
  type ChainClient,
  type Logger,
  type ServiceRecord,
  type VerifyResult,
} from '@agentgate/shared';
import type { PaywallErrorCode } from './types';

// The gasless rail (Task 10c, ruling R58): the gateway relays the buyer's signed NEP-366
// `pay_from_escrow` delegate and pays the gas. NEAR has a relayer pay the inner call's deposit,
// so only a zero-deposit `pay_from_escrow` to the registry is ever relayed: the relayer's
// exposure is gas only. Every refusal below comes before `relayPay`, so a refused delegate costs
// it nothing; a relay that fails (relay_failed) costs one relay's gas. Relays in flight, relays
// whose outcome is not served yet and the delegate nonces relayed live in this process's memory
// (one gateway instance, ruling R49).

/** Relays remembered at once, and signing keys whose relayed nonces are tracked; past this the oldest is dropped. */
const MAX_REMEMBERED = 10_000;

/**
 * The `code` of a relay_failed that failed on the gateway's side: its key, account or balance,
 * the relay tx itself, the RPC. The buyer is told no more: none of it is the buyer's to fix.
 */
export const RELAYER_ERROR = 'RELAYER_ERROR';

/** How much of a failure's message a log line keeps. */
const LOG_TEXT_MAX = 300;

/** What the gateway does with a delegate presented for an invoice. */
export type DelegateSettlement =
  /** The registry holds this invoice's payment by the delegate's sender: burn the nonce, proxy, attest `txHash`. */
  | { kind: 'paid'; txHash: string; payer: string; selfPaid: boolean }
  /** Refused, or the relay definitively failed: 402 `error` (and the chain's `code`) with a fresh invoice; the nonce stays open. */
  | { kind: 'refused'; error: PaywallErrorCode; code?: string }
  /** A relay of this invoice is in flight, may still land, or landed and is not read yet (`transaction`): 402 settlement_pending on the same invoice. */
  | { kind: 'pending'; transaction?: string };

export interface DelegateRailDeps {
  chain: ChainClient;
  /** The relay's signer: the gateway account, which pays the gas. */
  relayer: AnySigner;
  /** A payment older than this is not served (the invoice TTL, as on the tx rail). */
  maxAgeMs: number;
  logger: Logger;
}

/** A relay this process sent for an invoice: what the retry of its delegate is checked against and served from. */
export interface RememberedRelay {
  txHash: string;
  senderId: string;
  publicKey: string;
  delegateNonce: bigint;
  maxBlockHeight: bigint;
}

export interface DelegateRail {
  /**
   * Settles invoice `nonce` of `service` (an open invoice of this gateway) with the presented
   * delegate, in this order: the delegate's structure (`delegate_<reason>`), its signature
   * (`bad_signature`), a relay of this invoice in flight (`settlement_pending`), a payment the
   * registry already holds (served only as the retry of a relay this process sent, for that relay's
   * sender and key, else `invoice_used`), a relay that may still land (`settlement_pending`), the
   * delegate's timing (`delegate_expired`, `delegate_nonce_too_large`), the signing key
   * (`unknown_key`, `key_not_allowed`, `stale_nonce`), the escrow (`escrow_insufficient`), then the
   * relay and the payment record (payer = the delegate's sender). The timing comes after the
   * payment checks: the retry of a relay that landed is served even once its delegate expired.
   */
  settle(input: { service: ServiceRecord; nonce: string; signedDelegate: string; payer: string }): Promise<DelegateSettlement>;
  /** Invoice `nonce` is burned (served): its relay need not be remembered any longer. */
  served(nonce: string): void;
  /** The relay remembered for invoice `nonce`, if any. */
  remembered(nonce: string): Readonly<RememberedRelay> | undefined;
}

/** True iff NEAR lets this key sign the delegate: full access, or a function-call key for the registry that may call pay_from_escrow (an empty method list allows any). */
function keyAllowsPay(key: AccessKeyInfo, registryId: string): boolean {
  if (key.permission === 'FullAccess') return true;
  const { receiverId, methodNames } = key.permission;
  return receiverId === registryId && (methodNames.length === 0 || methodNames.includes(PAY_DELEGATE_METHOD));
}

function refused(error: PaywallErrorCode, code?: string): DelegateSettlement {
  return code === undefined ? { kind: 'refused', error } : { kind: 'refused', error, code };
}

/** Whether NEAR ran the delegate and the registry refused its call (its ERR_* code, or the call failed): the delegate's nonce is spent. */
function delegateRan(err: unknown): err is AgentGateError {
  if (!(err instanceof AgentGateError)) return false;
  return err.code === 'CONTRACT_ERROR' || (/^ERR_[A-Z0-9_]+$/.test(err.code) && err.code !== 'ERR_INSUFFICIENT_BALANCE');
}

/**
 * The `code` a relay_failed shows the buyer: NEAR's verdict on the delegate (DELEGATE_REJECTED)
 * and the registry's on its call (ERR_*, CONTRACT_ERROR) as they are; anything else failed on the
 * gateway's side (its key, account or balance, the relay tx, the RPC) and is RELAYER_ERROR.
 */
function buyerCode(err: unknown): string {
  if (delegateRan(err)) return err.code;
  return err instanceof AgentGateError && err.code === 'DELEGATE_REJECTED' ? err.code : RELAYER_ERROR;
}

function errorCode(err: unknown): string {
  return err instanceof AgentGateError ? err.code : 'UNEXPECTED_ERROR';
}

/** A failure's message for the operator's log: keys and long base64 or base58 runs (a delegate, a signed tx, a secret) redacted, clipped. */
function logText(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err))
    .replace(/(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+/g, '<key>')
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, '<redacted>');
  return text.length > LOG_TEXT_MAX ? `${text.slice(0, LOG_TEXT_MAX)}…` : text;
}

/** The signing key a delegate's nonce belongs to. */
function keyOf(delegate: DecodedDelegate): string {
  return `${delegate.senderId} ${delegate.publicKey}`;
}

/** Drops the oldest entries (insertion order) past MAX_REMEMBERED. */
function bound<V>(map: Map<string, V>): void {
  while (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function createDelegateRail(deps: DelegateRailDeps): DelegateRail {
  const { chain, relayer, maxAgeMs, logger } = deps;
  /** Invoice nonces whose delegate is being settled right now: one relay per invoice at a time. */
  const inFlight = new Set<string>();
  /** Relays this process sent whose invoice is not served yet, by invoice nonce. */
  const relays = new Map<string, RememberedRelay>();
  /**
   * The highest delegate nonce relayed per signing key, while that relay may still run (until its
   * delegate's max height): the RPC's view of the key can lag it, and a second delegate with a
   * nonce NEAR already took would only fail, on the relayer's gas.
   */
  const relayedNonces = new Map<string, { nonce: bigint; maxBlockHeight: bigint }>();
  /** `<sender> <public key> <nonce>` of each delegate being relayed right now. */
  const relaying = new Set<string>();

  function remember(nonce: string, txHash: string, delegate: DecodedDelegate): RememberedRelay {
    const relay: RememberedRelay = {
      txHash,
      senderId: delegate.senderId,
      publicKey: delegate.publicKey,
      delegateNonce: delegate.nonce,
      maxBlockHeight: delegate.maxBlockHeight,
    };
    relays.delete(nonce);
    relays.set(nonce, relay);
    bound(relays);
    return relay;
  }

  /** The delegate was relayed and NEAR may have run it: its nonce is taken until it can no longer run. */
  function noteRelayed(delegate: DecodedDelegate, height: number): void {
    const key = keyOf(delegate);
    const held = relayedNonces.get(key);
    const live = held !== undefined && BigInt(height) <= held.maxBlockHeight ? held : undefined;
    relayedNonces.delete(key);
    relayedNonces.set(key, {
      nonce: live !== undefined && live.nonce > delegate.nonce ? live.nonce : delegate.nonce,
      maxBlockHeight: live !== undefined && live.maxBlockHeight > delegate.maxBlockHeight ? live.maxBlockHeight : delegate.maxBlockHeight,
    });
    bound(relayedNonces);
  }

  /** Whether the delegate's nonce is being relayed right now, or is at most one relayed for its key that may still run. */
  function nonceTaken(delegate: DecodedDelegate, height: number): boolean {
    if (relaying.has(`${keyOf(delegate)} ${delegate.nonce}`)) return true;
    const held = relayedNonces.get(keyOf(delegate));
    if (held === undefined) return false;
    if (BigInt(height) > held.maxBlockHeight) {
      relayedNonces.delete(keyOf(delegate)); // it can no longer run: the key's nonce on chain decides alone
      return false;
    }
    return delegate.nonce <= held.nonce;
  }

  /** The registry's record of the invoice's payment, judged as the tx rail judges it (service, amount ≥ price, age, not attested). */
  function record(service: ServiceRecord, nonce: string): Promise<VerifyResult> {
    return chain.verifyPayment({ nonce, serviceId: service.id, minAmountYocto: service.priceYocto, maxAgeMs });
  }

  /** Whether the record is the relay's payment: one this gateway serves, by the relay's sender. */
  function recordServes(verdict: VerifyResult, relay: RememberedRelay): boolean {
    return verdict.ok && verdict.payer === relay.senderId;
  }

  /** `paid` when the record is the relay's payment and the presented delegate is the relay's sender's, signed with its key. */
  function servedFromRecord(verdict: VerifyResult, delegate: DecodedDelegate, relay: RememberedRelay): DelegateSettlement | null {
    if (!verdict.ok || !recordServes(verdict, relay)) return null;
    if (delegate.senderId !== relay.senderId || delegate.publicKey !== relay.publicKey) return null;
    return { kind: 'paid', txHash: relay.txHash, payer: verdict.payer, selfPaid: verdict.selfPaid };
  }

  /**
   * Whether a remembered relay may still pay: until its delegate's max height, yes. Past it, only
   * if NEAR ran the delegate, which set the signing key's nonce to the delegate's: its call to the
   * registry may then still be settling (or failed). A key that is gone may have run it too. Read
   * at `final`: what NEAR has settled.
   */
  async function mayStillLand(relay: RememberedRelay, height: number): Promise<boolean> {
    if (BigInt(height) <= relay.maxBlockHeight) return true;
    const key = await chain.accessKey(relay.senderId, relay.publicKey);
    return key === null || key.nonce >= relay.delegateNonce;
  }

  /** A relay whose record can never serve it is forgotten once its delegate can no longer run (a failed height read keeps it until the next retry). */
  async function forgetIfUnservable(nonce: string, verdict: VerifyResult, relay: RememberedRelay): Promise<void> {
    if (recordServes(verdict, relay)) return;
    const height = await chain.blockHeight().catch(() => undefined);
    if (height !== undefined && BigInt(height) > relay.maxBlockHeight) relays.delete(nonce);
  }

  async function settleLocked(
    service: ServiceRecord,
    nonce: string,
    signedDelegate: string,
    delegate: DecodedDelegate,
  ): Promise<DelegateSettlement> {
    // A payment the registry already holds is never relayed again (R58 §2).
    const before = await record(service, nonce);
    const remembered = relays.get(nonce);
    if (before.ok || before.reason !== 'not_found') {
      // Served only as the retry of a relay this process sent, for that relay's sender and key: it
      // names the tx to settle and attest. A payment it did not relay (e.g. a direct pay) goes on
      // the tx rail with its tx.
      if (remembered === undefined) return refused('invoice_used');
      if (!before.ok && before.reason === 'pending') return { kind: 'pending', transaction: remembered.txHash };
      const paid = servedFromRecord(before, delegate, remembered);
      if (paid !== null) return paid;
      // Another account's or key's delegate is not served: the relay stays remembered for its own.
      await forgetIfUnservable(nonce, before, remembered);
      return refused('invoice_used');
    }
    const height = await chain.blockHeight();
    if (remembered !== undefined) {
      // A relay that may still land is never sent again meanwhile: a second one could not pay
      // twice (the registry takes one payment per invoice, ERR_NONCE_USED), but it would cost the
      // relayer its gas, and the first relay's outcome is the answer.
      if (await mayStillLand(remembered, height)) return { kind: 'pending', transaction: remembered.txHash };
      relays.delete(nonce); // NEAR never ran its delegate and never will: the invoice is open again
    }

    // Whether NEAR still takes this delegate, now that it is to be relayed.
    const timing = payDelegateTiming(delegate, height);
    if (timing !== null) return refused(`delegate_${timing}`);

    // The signing key (R58 §1): free reads, so a forged or stale delegate costs the relayer nothing.
    // Its authority at `final`: what NEAR has settled.
    const key = await chain.accessKey(delegate.senderId, delegate.publicKey);
    if (key === null) return refused('unknown_key');
    if (!keyAllowsPay(key, chain.registryId)) return refused('key_not_allowed');
    // Its nonce at `optimistic`: a nonce spent in a block that is not final yet is spent. And above
    // every nonce this gateway relayed for the key that may still run, which the view can lag.
    const latest = await chain.accessKey(delegate.senderId, delegate.publicKey, 'optimistic');
    if (latest === null) return refused('unknown_key');
    if (delegate.nonce <= latest.nonce || nonceTaken(delegate, height)) return refused('stale_nonce');

    const total = addYocto(service.priceYocto, PAYMENT_STORAGE_FEE_YOCTO);
    if (compareYocto(await chain.escrowOf(delegate.senderId), total) < 0) return refused('escrow_insufficient');

    const slot = `${keyOf(delegate)} ${delegate.nonce}`;
    relaying.add(slot);
    let txHash: string;
    try {
      ({ txHash } = await chain.relayPay(signedDelegate, relayer));
    } catch (err) {
      if (err instanceof AgentGateError && err.code === 'TX_TIMEOUT') {
        // The relay may still land: its retry is served if it did, and it is never relayed again meanwhile.
        noteRelayed(delegate, height);
        const lost = timedOutTxHash(err);
        if (lost !== undefined) remember(nonce, lost, delegate);
        logger.warn('relay_timeout', { serviceId: service.id, nonce, txHash: lost });
        return lost === undefined ? { kind: 'pending' } : { kind: 'pending', transaction: lost };
      }
      // A definitive failure: no payment, the invoice stays open. The log keeps what went wrong,
      // the buyer only whose it is to fix.
      if (delegateRan(err)) noteRelayed(delegate, height);
      logger.warn('relay_failed', { serviceId: service.id, nonce, code: errorCode(err), message: logText(err) });
      return refused('relay_failed', buyerCode(err));
    } finally {
      relaying.delete(slot);
    }

    // The registry's call succeeded (relayPay judged the outcome): the delegate's nonce is spent, and
    // the relay is remembered before anything else is read, so no failed read strands the buyer.
    noteRelayed(delegate, height);
    const relay = remember(nonce, txHash, delegate);
    let after: VerifyResult;
    try {
      after = await record(service, nonce);
    } catch (err) {
      logger.warn('relay_record_unread', { serviceId: service.id, nonce, txHash, code: errorCode(err), message: logText(err) });
      return { kind: 'pending', transaction: txHash }; // the retry reads it again
    }
    const paid = servedFromRecord(after, delegate, relay);
    if (paid !== null) return paid;
    if (!after.ok && (after.reason === 'not_found' || after.reason === 'pending')) {
      return { kind: 'pending', transaction: txHash }; // the view lags the outcome: the retry serves it
    }
    relays.delete(nonce); // its delegate ran: the record above is its payment, and it can never be served
    logger.warn('relay_record_mismatch', { serviceId: service.id, nonce, txHash, reason: after.ok ? 'payer' : after.reason });
    return refused(after.ok ? 'tx_mismatch' : after.reason);
  }

  async function settle(input: {
    service: ServiceRecord;
    nonce: string;
    signedDelegate: string;
    payer: string;
  }): Promise<DelegateSettlement> {
    const { service, nonce, signedDelegate, payer } = input;
    // The structure (the timing waits for the payment checks), then the signature: no chain read yet.
    const inspected = inspectPayDelegate(signedDelegate, {
      registryId: chain.registryId,
      serviceId: service.id,
      nonce,
      payer,
      maxGas: PAY_DELEGATE_GAS,
      minGas: PAY_DELEGATE_GAS,
    });
    if (!inspected.ok) return refused(`delegate_${inspected.reason}`);
    if (!verifyDelegateSignature(inspected.delegate)) return refused('bad_signature');

    if (inFlight.has(nonce)) return { kind: 'pending' };
    inFlight.add(nonce);
    try {
      return await settleLocked(service, nonce, signedDelegate, inspected.delegate);
    } finally {
      inFlight.delete(nonce);
    }
  }

  function served(nonce: string): void {
    relays.delete(nonce);
  }

  function rememberedRelay(nonce: string): Readonly<RememberedRelay> | undefined {
    const relay = relays.get(nonce);
    return relay === undefined ? undefined : { ...relay };
  }

  return { settle, served, remembered: rememberedRelay };
}
