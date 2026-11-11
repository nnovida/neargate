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
  isNearTxHash,
  type AccessKeyInfo,
  type AnySigner,
  type ChainClient,
  type Logger,
  type ServiceRecord,
  type VerifyResult,
} from '@agentgate/shared';

// The gasless rail (Task 10c, ruling R58): the gateway relays the buyer's signed NEP-366
// `pay_from_escrow` delegate and pays the gas. NEAR has a relayer pay the inner call's deposit,
// so only a zero-deposit `pay_from_escrow` to the registry is ever relayed: the relayer's
// exposure is gas only, and every refusal below comes before `relayPay`, so a refused delegate
// costs it nothing. In-flight and timed-out relays live in this process's memory (one gateway
// instance, ruling R49).

/** Timed-out relays remembered at once; past this the oldest is dropped (its retry is then invoice_used or stale_nonce). */
const MAX_REMEMBERED_RELAYS = 10_000;

/** What the gateway does with a delegate presented for an invoice. */
export type DelegateSettlement =
  /** The registry holds this invoice's payment by the delegate's sender: burn the nonce, proxy, attest `txHash`. */
  | { kind: 'paid'; txHash: string; payer: string; selfPaid: boolean }
  /** Refused, or the relay definitively failed: 402 `error` (and the chain's `code`) with a fresh invoice; the nonce stays open. */
  | { kind: 'refused'; error: string; code?: string }
  /** A relay of this invoice is in flight or may still land (`transaction`): 402 settlement_pending on the same invoice. */
  | { kind: 'pending'; transaction?: string };

export interface DelegateRailDeps {
  chain: ChainClient;
  /** The relay's signer: the gateway account, which pays the gas. */
  relayer: AnySigner;
  /** A payment older than this is not served (the invoice TTL, as on the tx rail). */
  maxAgeMs: number;
  logger: Logger;
}

export interface DelegateRail {
  /**
   * Settles invoice `nonce` of `service` (an open invoice of this gateway) with the presented
   * delegate, in this order: the delegate's structure (`delegate_<reason>`), its signature
   * (`bad_signature`), a relay of this invoice in flight (`settlement_pending`), a payment the
   * registry already holds (served only as the retry of a relay this process sent, for that relay's
   * sender, else `invoice_used`), a timed-out relay that may still land (`settlement_pending`), the
   * delegate's timing (`delegate_expired`, `delegate_nonce_too_large`), the signing key
   * (`unknown_key`, `key_not_allowed`, `stale_nonce`), the escrow (`escrow_insufficient`), then the
   * relay and the payment record (payer = the delegate's sender). The timing comes after the
   * payment checks: the retry of a relay that landed is served even once its delegate expired.
   */
  settle(input: { service: ServiceRecord; nonce: string; signedDelegate: string; payer: string }): Promise<DelegateSettlement>;
}

/** True iff NEAR lets this key sign the delegate: full access, or a function-call key for the registry that may call pay_from_escrow (an empty method list allows any). */
function keyAllowsPay(key: AccessKeyInfo, registryId: string): boolean {
  if (key.permission === 'FullAccess') return true;
  const { receiverId, methodNames } = key.permission;
  return receiverId === registryId && (methodNames.length === 0 || methodNames.includes(PAY_DELEGATE_METHOD));
}

/** A relay that timed out (or settled before the registry view showed it): what its retry is checked against. */
interface RememberedRelay {
  txHash: string;
  senderId: string;
  publicKey: string;
  delegateNonce: bigint;
  maxBlockHeight: bigint;
}

/** The tx a TX_TIMEOUT names (the relay was sent, its outcome is unknown), or undefined for any other failure. */
function timedOutTxHash(err: unknown): string | undefined {
  if (!(err instanceof AgentGateError) || err.code !== 'TX_TIMEOUT') return undefined;
  const txHash = (err as { txHash?: unknown }).txHash;
  return isNearTxHash(txHash) ? txHash : undefined;
}

function refused(error: string, code?: string): DelegateSettlement {
  return code === undefined ? { kind: 'refused', error } : { kind: 'refused', error, code };
}

export function createDelegateRail(deps: DelegateRailDeps): DelegateRail {
  const { chain, relayer, maxAgeMs, logger } = deps;
  /** Invoice nonces whose delegate is being settled right now: one relay per invoice at a time. */
  const inFlight = new Set<string>();
  /** Relays that timed out (or settled before the registry view showed them), by invoice nonce. */
  const relays = new Map<string, RememberedRelay>();

  function remember(nonce: string, txHash: string, delegate: DecodedDelegate): void {
    relays.delete(nonce);
    relays.set(nonce, {
      txHash,
      senderId: delegate.senderId,
      publicKey: delegate.publicKey,
      delegateNonce: delegate.nonce,
      maxBlockHeight: delegate.maxBlockHeight,
    });
    if (relays.size > MAX_REMEMBERED_RELAYS) {
      const oldest = relays.keys().next().value;
      if (oldest !== undefined) relays.delete(oldest);
    }
  }

  /** The registry's record of the invoice's payment, judged as the tx rail judges it (service, amount ≥ price, age, not attested). */
  function record(service: ServiceRecord, nonce: string): Promise<VerifyResult> {
    return chain.verifyPayment({ nonce, serviceId: service.id, minAmountYocto: service.priceYocto, maxAgeMs });
  }

  /** `paid` when the record is the delegate sender's payment, for this service and price. */
  function paidBy(verdict: VerifyResult, delegate: DecodedDelegate, txHash: string): DelegateSettlement | null {
    if (!verdict.ok || verdict.payer !== delegate.senderId) return null;
    return { kind: 'paid', txHash, payer: verdict.payer, selfPaid: verdict.selfPaid };
  }

  /**
   * Whether a remembered relay may still pay: until its delegate's max height, yes. Past it, only
   * if NEAR ran the delegate, which set the signing key's nonce to the delegate's: its call to the
   * registry may then still be settling (or failed). A key that is gone may have run it too.
   */
  async function mayStillLand(relay: RememberedRelay, height: number): Promise<boolean> {
    if (BigInt(height) <= relay.maxBlockHeight) return true;
    const key = await chain.accessKey(relay.senderId, relay.publicKey);
    return key === null || key.nonce >= relay.delegateNonce;
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
      // Served only as the retry of a relay this process sent: it names the tx to settle and
      // attest. A payment it did not relay (e.g. a direct pay) goes on the tx rail with its tx.
      if (remembered === undefined) return refused('invoice_used');
      if (!before.ok && before.reason === 'pending') return { kind: 'pending', transaction: remembered.txHash };
      const paid = paidBy(before, delegate, remembered.txHash);
      // Another account's delegate is not served, and the relay stays remembered for its own sender.
      if (paid === null) return refused('invoice_used');
      relays.delete(nonce);
      return paid;
    }
    const height = await chain.blockHeight();
    if (remembered !== undefined) {
      // A timed-out relay that may still land: relaying again could pay twice.
      if (await mayStillLand(remembered, height)) return { kind: 'pending', transaction: remembered.txHash };
      relays.delete(nonce); // NEAR never ran its delegate and never will: the invoice is open again
    }

    // Whether NEAR still takes this delegate, now that it is to be relayed.
    const timing = payDelegateTiming(delegate, height);
    if (timing !== null) return refused(`delegate_${timing}`);

    // The signing key (R58 §1): free reads, so a forged or stale delegate costs the relayer nothing.
    const key = await chain.accessKey(delegate.senderId, delegate.publicKey);
    if (key === null) return refused('unknown_key');
    if (!keyAllowsPay(key, chain.registryId)) return refused('key_not_allowed');
    if (delegate.nonce <= key.nonce) return refused('stale_nonce');

    const total = addYocto(service.priceYocto, PAYMENT_STORAGE_FEE_YOCTO);
    if (compareYocto(await chain.escrowOf(delegate.senderId), total) < 0) return refused('escrow_insufficient');

    let txHash: string;
    try {
      ({ txHash } = await chain.relayPay(signedDelegate, relayer));
    } catch (err) {
      const lost = timedOutTxHash(err);
      if (err instanceof AgentGateError && err.code === 'TX_TIMEOUT') {
        // The relay may still land: the retry is served if it did, never relayed again meanwhile.
        if (lost !== undefined) remember(nonce, lost, delegate);
        logger.warn('relay_timeout', { serviceId: service.id, nonce, txHash: lost });
        return lost === undefined ? { kind: 'pending' } : { kind: 'pending', transaction: lost };
      }
      // NEAR's verdict (or nothing was sent): no payment, the invoice stays open.
      const code = err instanceof AgentGateError ? err.code : 'RELAY_ERROR';
      logger.warn('relay_failed', { serviceId: service.id, nonce, code });
      return refused('relay_failed', code);
    }

    // The registry's receipt succeeded (relayPay judged the outcome); its record must agree.
    const after = await record(service, nonce);
    const paid = paidBy(after, delegate, txHash);
    if (paid !== null) return paid;
    if (!after.ok && (after.reason === 'not_found' || after.reason === 'pending')) {
      remember(nonce, txHash, delegate); // the view lags the outcome: the retry serves it
      return { kind: 'pending', transaction: txHash };
    }
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

  return { settle };
}
