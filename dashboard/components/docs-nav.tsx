'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

interface DocLink {
  href: string;
  label: string;
}
interface DocGroup {
  label: string;
  links: DocLink[];
}

/** Industry-standard grouped IA: Get started → Guides → Concepts → Reference. */
export const DOC_GROUPS: DocGroup[] = [
  {
    label: 'Get started',
    links: [
      { href: '/docs', label: 'Overview' },
      { href: '/docs/quickstart', label: 'Quickstart' },
      { href: '/docs/installation', label: 'Installation' },
    ],
  },
  {
    label: 'Guides',
    links: [
      { href: '/docs/sellers', label: 'Wrap an API' },
      { href: '/docs/buyers', label: 'Build an agent' },
      { href: '/docs/deployment', label: 'Deploy to production' },
    ],
  },
  {
    label: 'Concepts',
    links: [
      { href: '/docs/protocol', label: 'How it works' },
      { href: '/docs/architecture', label: 'Architecture' },
      { href: '/docs/security', label: 'Security model' },
    ],
  },
  {
    label: 'Reference',
    links: [
      { href: '/docs/cli', label: 'CLI' },
      { href: '/docs/api', label: 'HTTP API' },
      { href: '/docs/sdk', label: 'Client SDK' },
      { href: '/docs/configuration', label: 'Configuration' },
      { href: '/docs/contract', label: 'Smart contracts' },
      { href: '/docs/errors', label: 'Error codes' },
    ],
  },
];

/** Flat, ordered list (derived) — used for prev/next and any flat consumer. */
export const DOC_LINKS = DOC_GROUPS.flatMap((g) => g.links);

function isActive(pathname: string, href: string): boolean {
  if (href === '/docs') return pathname === '/docs';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sticky left rail on desktop — grouped sections with labels. */
export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation sections" className="space-y-7">
      {DOC_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="microlabel mb-3">{group.label}</p>
          <ul className="space-y-0.5">
            {group.links.map(({ href, label }) => {
              const active = isActive(pathname, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={`block border-l py-1.5 pl-4 pr-2 font-mono text-xs tracking-wide transition-colors ${
                      active
                        ? 'border-accent bg-accent-soft text-white'
                        : 'border-line text-mut hover:border-accent/40 hover:text-white'
                    }`}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Compact horizontal variant shown above the content on small screens. */
export function DocsTopNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Documentation sections"
      className="-mx-5 overflow-x-auto border-b border-line px-5 pb-3 sm:-mx-8 sm:px-8"
    >
      <ul className="flex w-max gap-2">
        {DOC_LINKS.map(({ href, label }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                  active
                    ? 'border-accent/60 bg-accent-soft text-white'
                    : 'border-line text-mut hover:border-accent/40 hover:text-white'
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

/**
 * Auto-generated "On this page" rail. Scans the rendered <article> for
 * anchored h2/h3 headings and scroll-spies the active one. Re-scans on route
 * change. Renders nothing when a page has no sections.
 */
export function OnThisPage() {
  const pathname = usePathname();
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('article h2[id], article h3[id]'),
    );
    setItems(
      nodes.map((n) => ({
        id: n.id,
        text: (n.textContent ?? '').replace(/\s*#\s*$/, '').trim(),
        level: n.tagName === 'H3' ? 3 : 2,
      })),
    );
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [pathname]);

  if (items.length === 0) return null;
  return (
    <nav aria-label="On this page">
      <p className="microlabel mb-3">on this page</p>
      <ul className="space-y-1 border-l border-line">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              className={`block py-1 text-xs leading-5 transition-colors ${
                it.level === 3 ? 'pl-7' : 'pl-4'
              } ${
                active === it.id
                  ? 'border-l-2 border-accent -ml-px text-white'
                  : 'text-mut hover:text-white'
              }`}
            >
              {it.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
