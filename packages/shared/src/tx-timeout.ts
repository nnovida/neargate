import { AgentGateError } from './errors';
import { isNearTxHash } from './x402';

/**
 * The tx hash a TX_TIMEOUT failure names (a change call that was sent but whose outcome is
 * unknown: it may still land), or undefined for any other failure. Read by duck typing, so a
 * caller recognises the chain client's error without pulling the client in.
 */
export function timedOutTxHash(err: unknown): string | undefined {
  if (!(err instanceof AgentGateError) || err.code !== 'TX_TIMEOUT') return undefined;
  const txHash = (err as { txHash?: unknown }).txHash;
  return isNearTxHash(txHash) ? txHash : undefined;
}
