import { truncateHash } from '@/lib/format';

/**
 * Tx hash rendering: plain mono text, with the full hash in the tooltip.
 * TODO(Task 8): on a live network, link to `${NEAR_EXPLORER_URL}/txns/<hash>`.
 */
export function TxHash({
  hash,
  className = '',
}: {
  hash: string;
  /** Chain network the hash belongs to (Task 8 uses it for explorer links). */
  network: string;
  className?: string;
}) {
  return (
    <code title={hash} className={`font-mono text-xs ${className} text-mut`}>
      {truncateHash(hash)}
    </code>
  );
}
