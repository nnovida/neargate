import { truncateHash } from '@/lib/format';

/**
 * Tx hash rendering per SPEC §11:
 * - mock network → plain mono text (nothing to link to)
 * - live network → link to https://testnet.cspr.live/deploy/<hash>
 */
export function TxHash({
  hash,
  network,
  className = '',
}: {
  hash: string;
  network: string;
  className?: string;
}) {
  const label = truncateHash(hash);
  const base = `font-mono text-xs ${className}`;
  if (network === 'mock') {
    return (
      <code title={hash} className={`${base} text-mut`}>
        {label}
      </code>
    );
  }
  return (
    <a
      href={`https://testnet.cspr.live/deploy/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      className={`${base} text-zinc-300 underline decoration-line underline-offset-4 transition-colors hover:text-accent hover:decoration-accent`}
    >
      {label}
      <span aria-hidden className="ml-1 text-[10px]">
        ↗
      </span>
    </a>
  );
}
