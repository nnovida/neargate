import type { ReactNode } from 'react';
import { httpUrl } from '@/lib/links';

/**
 * An external link for a URL read from the chain: an anchor only when the scheme is http(s) (R35),
 * otherwise the same text as a plain span. Never use a raw chain string as an `href` anywhere else.
 */
export function SafeLink({
  href,
  className = '',
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const safe = httpUrl(href);
  if (safe === null) {
    return (
      <span title={title} className={className}>
        {children}
      </span>
    );
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" title={title} className={className}>
      {children}
    </a>
  );
}
