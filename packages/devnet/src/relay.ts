import { AgentGateError } from '@agentgate/shared';
import {
  PAY_DELEGATE_GAS,
  PAY_DELEGATE_METHOD,
  decodeSignedDelegate,
  isRelayablePay,
  verifyDelegateSignature,
  type DecodedDelegate,
} from '@agentgate/chain/delegate';

// The devnet's NEP-366 relay (POST /registry/relay, the gasless rail): NEAR's own checks of a
// SignedDelegate before it runs the delegate's call, with the same helpers the gateway and the
// client use (near-delegate.ts), so the mock refuses what NEAR would refuse.

/** nearcore's ACCESS_KEY_NONCE_RANGE_MULTIPLIER: a delegate nonce of `height × 10^6` or more is too large. */
const NONCE_RANGE_MULTIPLIER = 1_000_000n;

/** What the relay reads from the devnet: its height and the sender's key nonce. */
export interface RelayLedger {
  height: number;
  /** The nonce of `publicKey` on `accountId`, or null when the account holds no such key. */
  keyNonce(accountId: string, publicKey: string): bigint | null;
}

/** NEAR refusing the delegate itself: TX_FAILED naming the DelegateAction error, as a live relay reports it. */
function refused(kind: string, detail: string): AgentGateError {
  return new AgentGateError('TX_FAILED', `NEAR rejected the relayed delegate: ${kind} (${detail})`, 400);
}

/**
 * Reads a relayed SignedDelegate and runs NEAR's checks on it, in nearcore's order: the
 * signature (DelegateActionInvalidSignature), the expiry (DelegateActionExpired once the height
 * passed `max_block_height`), the sender's key (DelegateActionAccessKeyError), its nonce
 * (DelegateActionInvalidNonce unless above the key's) and the nonce's upper bound
 * (DelegateActionNonceTooLarge). Before them, the devnet relays one shape only, like the
 * gateway: one zero-deposit `pay_from_escrow` to the registry (unsupported_delegate otherwise);
 * anything that is not a SignedDelegate is invalid_request. Throws on the first failure; the
 * caller then moves the key's nonce and runs the call.
 */
export function checkRelayedDelegate(signedDelegate: string, registryId: string, ledger: RelayLedger): DecodedDelegate {
  const delegate = decodeSignedDelegate(signedDelegate);
  if (delegate === null) {
    throw new AgentGateError('invalid_request', '"signedDelegate" is not a base64 borsh SignedDelegate (ed25519)', 400);
  }
  if (!isRelayablePay(delegate, registryId)) {
    throw new AgentGateError(
      'unsupported_delegate',
      `the devnet relays only one zero-deposit ${PAY_DELEGATE_METHOD} call (at most ${PAY_DELEGATE_GAS} gas) to ${registryId}`,
      400,
    );
  }
  if (!verifyDelegateSignature(delegate)) {
    throw refused('DelegateActionInvalidSignature', 'the signature does not verify under the delegate key');
  }
  const height = BigInt(ledger.height);
  if (height > delegate.maxBlockHeight) {
    throw refused('DelegateActionExpired', `max_block_height ${delegate.maxBlockHeight} is below the height ${height}`);
  }
  const keyNonce = ledger.keyNonce(delegate.senderId, delegate.publicKey);
  if (keyNonce === null) {
    throw refused('DelegateActionAccessKeyError', `AccessKeyNotFound: ${delegate.publicKey} is not a key of ${delegate.senderId}`);
  }
  if (delegate.nonce <= keyNonce) {
    throw refused('DelegateActionInvalidNonce', `delegate nonce ${delegate.nonce}, key nonce ${keyNonce}`);
  }
  const upperBound = height * NONCE_RANGE_MULTIPLIER;
  if (delegate.nonce >= upperBound) {
    throw refused('DelegateActionNonceTooLarge', `delegate nonce ${delegate.nonce}, upper bound ${upperBound}`);
  }
  return delegate;
}

/**
 * The relayed call's JSON arguments, `{service_id, nonce}`. Arguments the contract could not
 * deserialize make its call fail (CONTRACT_ERROR), after NEAR spent the delegate's nonce.
 */
export function relayedPayArgs(delegate: DecodedDelegate): { serviceId: number; nonce: string } {
  const call = delegate.actions[0];
  let args: unknown;
  try {
    args = call?.kind === 'functionCall' ? JSON.parse(Buffer.from(call.args).toString('utf8')) : undefined;
  } catch {
    args = undefined;
  }
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  const serviceId = record['service_id'];
  const nonce = record['nonce'];
  if (typeof serviceId !== 'number' || !Number.isSafeInteger(serviceId) || serviceId < 0 || typeof nonce !== 'string') {
    throw new AgentGateError(
      'CONTRACT_ERROR',
      `the registry contract failed: ${PAY_DELEGATE_METHOD} could not deserialize its arguments {service_id, nonce}`,
      400,
    );
  }
  return { serviceId, nonce };
}
