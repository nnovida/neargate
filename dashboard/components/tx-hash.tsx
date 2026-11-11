import { truncateHash } from '@/lib/format';
import { txHref } from '@/lib/explorer';

/**
 * A chain event's transaction, as mono text. On a live network it links to the explorer: the tx
 * page for a real hash, the block page when only the block is known (a contract view cannot know
 * its own tx, so live activity events carry none). On the offline devnet (`near-mock`) there is no
 * explorer, so it stays plain text. The full hash is always in the tooltip.
 */
export function TxHash({
  hash,
  network,
  explorerUrl,
  blockHeight,
  className = '',
}: {
  hash: string | null;
  /** `ChainClient.network` of the data this hash belongs to. */
  network: string;
  /** Explorer base from the API response (server config); links are off without it. */
  explorerUrl?: string;
  /** The event's block, linked when `hash` is null. */
  blockHeight?: number;
  className?: string;
}) {
  const link = txHref({ network, explorerUrl, hash, ...(blockHeight !== undefined ? { blockHeight } : {}) });
  const label =
    link?.kind === 'block' ? `block ${blockHeight}` : hash !== null ? truncateHash(hash) : '—';
  const base = `font-mono text-xs ${className}`;

  if (link === null) {
    return (
      <code title={hash ?? undefined} className={`${base} text-mut`}>
        {label}
      </code>
    );
  }
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      title={hash ?? `block explorer: ${link.href}`}
      className={`${base} text-mut underline decoration-line underline-offset-4 transition-colors hover:text-accent`}
    >
      <code>{label}</code>
    </a>
  );
}
