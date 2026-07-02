'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOC_LINKS } from '@/lib/doc-links';

/**
 * Deterministic prev/next pager over the flat DOC_LINKS order, so the docs can
 * be read linearly cover-to-cover. Complements the per-page NextLinks strips,
 * which stay curated "keep reading" cross-links.
 */
export function DocsPager() {
  const pathname = usePathname();
  const i = DOC_LINKS.findIndex((l) => l.href === pathname);
  if (i === -1) return null;
  const prev = i > 0 ? DOC_LINKS[i - 1] : undefined;
  const next = i < DOC_LINKS.length - 1 ? DOC_LINKS[i + 1] : undefined;
  if (!prev && !next) return null;

  return (
    <nav
      aria-label="Documentation pages"
      className="mx-auto mt-4 flex max-w-3xl items-stretch justify-between gap-3 border-t border-line pt-6"
    >
      {prev ? (
        <Link
          href={prev.href}
          rel="prev"
          className="border border-line px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white"
        >
          <span aria-hidden>←</span> {prev.label}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.href}
          rel="next"
          className="border border-line px-4 py-2 text-right font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white"
        >
          {next.label} <span aria-hidden>→</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
