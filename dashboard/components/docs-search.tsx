'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DOC_GROUPS } from '@/lib/doc-links';

interface Hit {
  href: string;
  label: string;
  group: string;
  keywords: string[];
}

/**
 * Command-palette search over the docs pages. Opens on ⌘K / Ctrl-K (or the
 * trigger button), filters page titles + their section + per-page keywords
 * (core vocabulary, error codes, env vars — see doc-links.ts), and navigates
 * on Enter. Purely client-side over the static IA — no index/build step.
 */
export function DocsSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const index = useMemo<Hit[]>(
    () =>
      DOC_GROUPS.flatMap((g) =>
        g.links.map((l) => ({
          href: l.href,
          label: l.label,
          group: g.label,
          keywords: (l.keywords ?? []).map((k) => k.toLowerCase()),
        })),
      ),
    [],
  );

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return index;
    return index.filter(
      (it) =>
        it.label.toLowerCase().includes(term) ||
        it.group.toLowerCase().includes(term) ||
        it.keywords.some((k) => k.includes(term)),
    );
  }, [q, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => setActive(0), [q]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search documentation"
        className="flex w-full items-center justify-between gap-3 border border-line bg-panel px-3 py-2 text-left font-mono text-xs text-mut transition-colors hover:border-accent/40 hover:text-white"
      >
        <span>Search docs…</span>
        <kbd className="border border-line px-1.5 py-0.5 text-[10px] text-zinc-400">⌘K</kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
          role="dialog"
          aria-modal="true"
          aria-label="Search documentation"
          onClick={() => setOpen(false)}
        >
          <div className="panel w-full max-w-lg bg-panel" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, results.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const r = results[active];
                  if (r) go(r.href);
                }
              }}
              placeholder="Search documentation…"
              className="w-full border-b border-line bg-transparent px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-mut"
            />
            <ul className="max-h-[50vh] overflow-y-auto py-2">
              {results.length === 0 ? (
                <li className="px-4 py-3 text-sm text-mut">No matches.</li>
              ) : (
                results.map((r, i) => (
                  <li key={r.href}>
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(r.href)}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors ${
                        i === active ? 'bg-accent-soft text-white' : 'text-mut hover:text-white'
                      }`}
                    >
                      <span>{r.label}</span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">
                        {r.group}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
