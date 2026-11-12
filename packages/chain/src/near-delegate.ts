import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'borsh';
import { PublicKey, SCHEMA, actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate } from 'near-api-js';
import type { Signer } from 'near-api-js';
import { AgentGateError, SIGNED_DELEGATE_MAX, SIGNED_DELEGATE_MAX_CHARS, base58Encode, isBase64, isRecord } from '@agentgate/shared';
import { invalid } from './checks';
import { mapContractPanic } from './near-errors';

// NEP-366 delegates of the gasless rail (Task 10c, ruling R58): the buyer signs one zero-deposit
// `pay_from_escrow(service_id, nonce)` to the registry, and the gateway relays it. Built, read,
// judged and verified here, in one place, for the client, the gateway and the devnet alike, with
// near-api-js's own borsh encoding (SCHEMA.SignedDelegate, encodeDelegateAction).

/** The one registry call the gateway relays: it attaches nothing, so the relayer only pays gas. */
export const PAY_DELEGATE_METHOD = 'pay_from_escrow';
/** Gas the delegate's call carries: 30 TGas, as every registry call (the relayer pays it). */
export const PAY_DELEGATE_GAS = 30_000_000_000_000n;
/** A client's delegate stays valid this many blocks past the height it read. */
export const PAY_DELEGATE_TTL_BLOCKS = 100;
/** The gateway relays a delegate only while it stays valid this many more blocks: time for the relay to land. */
export const RELAY_MIN_TTL_BLOCKS = 20;
/** nearcore's ACCESS_KEY_NONCE_RANGE_MULTIPLIER: a nonce of `height × 10^6` or more is DelegateActionNonceTooLarge. */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;
const MAX_TEXT = 300;

/** One action of a delegate: a FunctionCall in full, any other action by its name. */
export type DelegateCall =
  | { kind: 'functionCall'; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { kind: 'other'; action: string };

/** A borsh SignedDelegate as read by `decodeSignedDelegate` (ed25519 only). */
export interface DecodedDelegate {
  senderId: string;
  receiverId: string;
  actions: DelegateCall[];
  /** The delegate nonce (NEAR takes it only above the signing key's nonce). */
  nonce: bigint;
  /** The last block height at which NEAR executes the delegate. */
  maxBlockHeight: bigint;
  /** The signing key, `ed25519:<base58>`. */
  publicKey: string;
  /** The 64-byte ed25519 signature. */
  signature: Uint8Array;
  /** The borsh value as decoded: it encodes back to exactly the bytes received, which is what a relay sends. */
  signed: { delegateAction: unknown; signature: unknown };
}

/** Why `inspectPayDelegate` refuses a delegate (the gateway answers 402 `delegate_<reason>`), in the order it checks. */
export const PAY_DELEGATE_REFUSALS = [
  'malformed',
  'wrong_sender',
  'wrong_receiver',
  'wrong_action',
  'wrong_args',
  'deposit_not_zero',
  'gas_too_high',
  'gas_too_low',
  'expired',
  'nonce_too_large',
] as const;
export type PayDelegateRefusal = (typeof PAY_DELEGATE_REFUSALS)[number];

export interface PayDelegateExpectation {
  registryId: string;
  /** The invoice's service and nonce: the call's arguments must name exactly these. */
  serviceId: number;
  nonce: string;
  /** The X-PAYMENT payer: the delegate's sender. */
  payer: string;
  /**
   * The chain's current height. When given, the timing is judged too (`payDelegateTiming`);
   * without it, the structure only, and the caller judges the timing later.
   */
  currentBlockHeight?: number;
  /** The most gas the call may carry (the relayer pays it). */
  maxGas: bigint;
  /** The least gas the call may carry (default 0): less runs out and fails on the relayer's gas. */
  minGas?: bigint;
}

export type PayDelegateVerdict = { ok: true; delegate: DecodedDelegate } | { ok: false; reason: PayDelegateRefusal };

/** What the relay of a pay delegate did, read from its tx outcome (`judgeRelayOutcome`). */
export type RelayVerdict =
  | { status: 'paid' }
  | { status: 'failed'; error: AgentGateError }
  | { status: 'unknown'; detail: string };

/** The call's JSON arguments, byte for byte: `{"service_id":<id>,"nonce":"<nonce>"}`. */
export function payDelegateArgs(serviceId: number, nonce: string): string {
  return JSON.stringify({ service_id: serviceId, nonce });
}

/**
 * Builds and signs the buyer's delegate: one FunctionCall `pay_from_escrow(service_id, nonce)` to
 * `registryId` with 30 TGas and nothing attached, as `senderId`, with `delegateNonce` (the signing
 * key's nonce + 1) and `maxBlockHeight`. `signer` holds the key; it may be the agent's
 * function-call key, which NEAR accepts for exactly this call. Returns the base64 borsh SignedDelegate.
 */
export async function buildEscrowPayDelegate(
  signer: Signer,
  input: {
    registryId: string;
    senderId: string;
    serviceId: number;
    nonce: string;
    delegateNonce: bigint;
    maxBlockHeight: bigint;
  },
): Promise<string> {
  const delegateAction = buildDelegateAction({
    senderId: input.senderId,
    receiverId: input.registryId,
    actions: [
      actions.functionCall(
        PAY_DELEGATE_METHOD,
        Buffer.from(payDelegateArgs(input.serviceId, input.nonce), 'utf8'),
        PAY_DELEGATE_GAS,
        0n,
      ),
    ],
    nonce: input.delegateNonce,
    maxBlockHeight: input.maxBlockHeight,
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegateAction);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
}

function toCall(action: unknown): DelegateCall {
  if (isRecord(action) && isRecord(action['functionCall'])) {
    const call = action['functionCall'];
    return {
      kind: 'functionCall',
      methodName: String(call['methodName']),
      args: Uint8Array.from(call['args'] as number[]),
      gas: BigInt(call['gas'] as bigint),
      deposit: BigInt(call['deposit'] as bigint),
    };
  }
  return { kind: 'other', action: isRecord(action) ? (Object.keys(action)[0] ?? 'unknown') : 'unknown' };
}

/**
 * Reads a base64 borsh SignedDelegate, or null for anything else: not strict base64, more than
 * SIGNED_DELEGATE_MAX bytes (refused before borsh sees it), not decodable, not the canonical
 * encoding of what it decodes to (trailing bytes, lossy strings), or not signed with ed25519.
 */
export function decodeSignedDelegate(b64: string): DecodedDelegate | null {
  if (typeof b64 !== 'string' || b64.length > SIGNED_DELEGATE_MAX_CHARS || !isBase64(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > SIGNED_DELEGATE_MAX) return null;
  let value: unknown;
  try {
    value = deserialize(SCHEMA.SignedDelegate, bytes);
    if (!Buffer.from(serialize(SCHEMA.SignedDelegate, value as never)).equals(bytes)) return null;
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value['delegateAction']) || !isRecord(value['signature'])) return null;
  const delegate = value['delegateAction'];
  const key = delegate['publicKey'];
  const signature = value['signature']['ed25519Signature'];
  if (!isRecord(key) || !isRecord(key['ed25519Key']) || !isRecord(signature)) return null; // ed25519 only
  return {
    senderId: String(delegate['senderId']),
    receiverId: String(delegate['receiverId']),
    actions: (delegate['actions'] as unknown[]).map(toCall),
    nonce: BigInt(delegate['nonce'] as bigint),
    maxBlockHeight: BigInt(delegate['maxBlockHeight'] as bigint),
    publicKey: `ed25519:${base58Encode(Uint8Array.from(key['ed25519Key']['data'] as number[]))}`,
    signature: Uint8Array.from(signature['data'] as number[]),
    signed: { delegateAction: delegate, signature: value['signature'] },
  };
}

/**
 * Whether a relay of `delegate` started at `currentBlockHeight` can still be taken by NEAR:
 * `expired` unless it stays valid RELAY_MIN_TTL_BLOCKS more blocks (time for the relay to land),
 * `nonce_too_large` unless its nonce is below height × 10^6 (NEAR's bound, which only grows), else null.
 */
export function payDelegateTiming(delegate: DecodedDelegate, currentBlockHeight: number): 'expired' | 'nonce_too_large' | null {
  const height = BigInt(currentBlockHeight);
  if (delegate.maxBlockHeight < height + BigInt(RELAY_MIN_TTL_BLOCKS)) return 'expired';
  if (delegate.nonce >= height * NONCE_RANGE_MULTIPLIER) return 'nonce_too_large';
  return null;
}

/**
 * The gateway's structure check of a delegate presented for an invoice, in this order: it is a
 * SignedDelegate (`malformed`); its sender is the payer; its receiver is the registry; it holds
 * exactly one FunctionCall `pay_from_escrow`; the arguments are byte for byte
 * `{"service_id":<invoice service>,"nonce":"<invoice nonce>"}`; nothing is attached; the gas is
 * within [minGas, maxGas]; then, given `currentBlockHeight`, its timing (`payDelegateTiming`:
 * `expired`, `nonce_too_large`). The signature is NOT checked here (`verifyDelegateSignature`),
 * nor the key (a chain read).
 */
export function inspectPayDelegate(b64: string, expect: PayDelegateExpectation): PayDelegateVerdict {
  const delegate = decodeSignedDelegate(b64);
  if (delegate === null) return { ok: false, reason: 'malformed' };
  if (delegate.senderId !== expect.payer) return { ok: false, reason: 'wrong_sender' };
  if (delegate.receiverId !== expect.registryId) return { ok: false, reason: 'wrong_receiver' };
  const call = delegate.actions.length === 1 ? delegate.actions[0] : undefined;
  if (call?.kind !== 'functionCall' || call.methodName !== PAY_DELEGATE_METHOD) return { ok: false, reason: 'wrong_action' };
  if (!Buffer.from(call.args).equals(Buffer.from(payDelegateArgs(expect.serviceId, expect.nonce), 'utf8'))) {
    return { ok: false, reason: 'wrong_args' };
  }
  if (call.deposit !== 0n) return { ok: false, reason: 'deposit_not_zero' };
  if (call.gas > expect.maxGas) return { ok: false, reason: 'gas_too_high' };
  if (call.gas < (expect.minGas ?? 0n)) return { ok: false, reason: 'gas_too_low' };
  if (expect.currentBlockHeight !== undefined) {
    const timing = payDelegateTiming(delegate, expect.currentBlockHeight);
    if (timing !== null) return { ok: false, reason: timing };
  }
  return { ok: true, delegate };
}

/**
 * True iff the delegate's ed25519 signature verifies under its own public key over what NEP-366
 * signs: sha256 of near-api-js's `encodeDelegateAction` (the u32 prefix 2^30 + 366, then the borsh
 * DelegateAction). Whether that key belongs to the sender is a chain read, not checked here.
 */
export function verifyDelegateSignature(delegate: DecodedDelegate): boolean {
  try {
    const digest = createHash('sha256')
      .update(encodeDelegateAction(delegate.signed.delegateAction as Parameters<typeof encodeDelegateAction>[0]))
      .digest();
    return PublicKey.fromString(delegate.publicKey).verify(new Uint8Array(digest), delegate.signature);
  } catch {
    return false;
  }
}

/** True iff the delegate is the one shape a relayer may pay for: one zero-deposit `pay_from_escrow` to `registryId`, ≤ 30 TGas. */
export function isRelayablePay(delegate: DecodedDelegate, registryId: string): boolean {
  const call = delegate.actions.length === 1 ? delegate.actions[0] : undefined;
  return (
    delegate.receiverId === registryId &&
    call?.kind === 'functionCall' &&
    call.methodName === PAY_DELEGATE_METHOD &&
    call.deposit === 0n &&
    call.gas <= PAY_DELEGATE_GAS
  );
}

/** The decoded delegate, or invalid_query (400) unless it is relayable (`isRelayablePay`): a relayer's last check. */
export function relayablePayDelegate(b64: string, registryId: string): DecodedDelegate {
  const delegate = decodeSignedDelegate(b64);
  if (delegate === null || !isRelayablePay(delegate, registryId)) {
    throw invalid(
      `relayPay relays only a SignedDelegate (base64 borsh, ed25519, at most ${SIGNED_DELEGATE_MAX} bytes) of one ` +
        `zero-deposit ${PAY_DELEGATE_METHOD} call to ${registryId}`,
    );
  }
  return delegate;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** How a receipt (or the tx) ended: success, a failure, or not yet known. */
function receiptState(outcome: unknown): { state: 'success' } | { state: 'failure'; failure: unknown } | { state: 'pending' } {
  const status = isRecord(outcome) ? outcome['status'] : undefined;
  if (isRecord(status)) {
    if ('SuccessValue' in status || 'SuccessReceiptId' in status) return { state: 'success' };
    if ('Failure' in status) return { state: 'failure', failure: status['Failure'] };
  }
  return { state: 'pending' }; // Unknown, Started, NotStarted, or a shape this client does not know
}

/** NEAR refusing the delegate itself (its signature, sender, expiry, key or nonce): DELEGATE_REJECTED (400), the buyer's to fix. */
function delegateRejected(failure: unknown): AgentGateError {
  return new AgentGateError('DELEGATE_REJECTED', `NEAR rejected the relayed delegate: ${clip(JSON.stringify(failure) ?? 'no detail')}`, 400);
}

/** A failed receipt as an AgentGateError: a contract panic keeps its ERR_* code, anything else is TX_FAILED. */
function failureError(failure: unknown, what: string): AgentGateError {
  const kind = isRecord(failure) && isRecord(failure['ActionError']) ? failure['ActionError']['kind'] : undefined;
  const call = isRecord(kind) ? kind['FunctionCallError'] : undefined;
  const execution = isRecord(call) ? call['ExecutionError'] : undefined;
  if (typeof execution === 'string') {
    // Same shape as a failed registry call: "ERR_ESCROW_INSUFFICIENT: …", or CONTRACT_ERROR.
    if (execution.includes('Smart contract panicked: ')) return mapContractPanic(new Error(execution));
    return new AgentGateError('CONTRACT_ERROR', `the registry contract failed: ${clip(execution)}`, 502);
  }
  return new AgentGateError('TX_FAILED', `NEAR rejected ${what}: ${clip(JSON.stringify(failure) ?? 'no detail')}`, 502);
}

/**
 * The verdict on a relay of a pay delegate, from its tx outcome (`send_tx`/`tx` result). The outer
 * status is never trusted: a Delegate action can succeed while the call it carries fails. Follows
 * the tx to its delegate receipt (on the sender's account), then to the receipt the registry
 * executed: `paid` once that one succeeded; `failed` when the delegate receipt failed (NEAR refused
 * the delegate: DELEGATE_REJECTED) or the registry's did (its panic keeps its ERR_* code);
 * `unknown` while the outcome does not show them both finished.
 */
export function judgeRelayOutcome(outcome: unknown, registryId: string): RelayVerdict {
  if (!isRecord(outcome) || !isRecord(outcome['transaction_outcome']) || !Array.isArray(outcome['receipts_outcome'])) {
    return { status: 'unknown', detail: 'no transaction outcome' };
  }
  const receipts = new Map<string, Record<string, unknown>>();
  for (const entry of outcome['receipts_outcome'] as unknown[]) {
    if (isRecord(entry) && typeof entry['id'] === 'string' && isRecord(entry['outcome'])) receipts.set(entry['id'], entry['outcome']);
  }
  const tx = outcome['transaction_outcome']['outcome'];
  const txState = receiptState(tx);
  if (txState.state === 'failure') return { status: 'failed', error: failureError(txState.failure, 'the relay tx') };
  const firstIds = isRecord(tx) && Array.isArray(tx['receipt_ids']) ? (tx['receipt_ids'] as unknown[]) : [];
  const delegateReceipt = typeof firstIds[0] === 'string' ? receipts.get(firstIds[0]) : undefined;
  if (delegateReceipt === undefined) return { status: 'unknown', detail: 'the outcome does not show the delegate receipt' };
  const delegateState = receiptState(delegateReceipt);
  if (delegateState.state === 'failure') return { status: 'failed', error: delegateRejected(delegateState.failure) };
  if (delegateState.state === 'pending') return { status: 'unknown', detail: 'the delegate receipt has not finished' };
  const childIds = Array.isArray(delegateReceipt['receipt_ids']) ? (delegateReceipt['receipt_ids'] as unknown[]) : [];
  const registryReceipt = childIds
    .map((id) => (typeof id === 'string' ? receipts.get(id) : undefined))
    .find((receipt) => receipt?.['executor_id'] === registryId);
  if (registryReceipt === undefined) return { status: 'unknown', detail: `the outcome does not show ${registryId}'s receipt` };
  const callState = receiptState(registryReceipt);
  if (callState.state === 'failure') {
    return { status: 'failed', error: failureError(callState.failure, `the relayed ${PAY_DELEGATE_METHOD} call`) };
  }
  if (callState.state === 'pending') return { status: 'unknown', detail: `${registryId}'s receipt has not finished` };
  return { status: 'paid' };
}
