'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const DOC_LINKS = [
  { href: '/docs', label: 'Overview' },
  { href: '/docs/quickstart', label: 'Quickstart' },
  { href: '/docs/sellers', label: 'Sellers' },
  { href: '/docs/buyers', label: 'Buyers' },
  { href: '/docs/protocol', label: 'Protocol' },
  { href: '/docs/api', label: 'HTTP API' },
  { href: '/docs/cli', label: 'CLI' },
  { href: '/docs/contract', label: 'Contract' },
  { href: '/docs/configuration', label: 'Configuration' },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === '/docs') return pathname === '/docs';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Sticky left rail on desktop (rendered inside the server docs layout). */
export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation sections">
      <p className="microlabel mb-4">documentation</p>
      <ul className="space-y-0.5">
        {DOC_LINKS.map(({ href, label }) => {
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
