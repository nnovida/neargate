import { accountHref } from '@/lib/explorer';
import { shortAccount } from '@/lib/format';

/**
 * A NEAR account id as mono text, shortened when long (64-hex implicit accounts), the full id in
 * the tooltip. Links to the explorer's address page on a live network (R39); plain text on the
 * offline devnet.
 */
export function AccountLink({
  accountId,
  network,
  explorerUrl,
  className = '',
}: {
  accountId: string;
  network: string;
  explorerUrl?: string;
  className?: string;
}) {
  const href = accountHref({ network, explorerUrl, accountId });
  const text = shortAccount(accountId);
  if (href === null) {
    return (
      <span title={accountId} className={className}>
        {text}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={accountId}
      className={`${className} underline decoration-line underline-offset-4 transition-colors hover:text-accent`}
    >
      {text}
    </a>
  );
}
