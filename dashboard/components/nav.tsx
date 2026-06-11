'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/catalog', label: 'Catalog' },
  { href: '/activity', label: 'Activity' },
  { href: '/docs', label: 'Docs' },
] as const;

function GateMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="6" fill="#FF3B30" />
      <path d="M9 24V14a7 7 0 0 1 14 0v10h-4.4V14a2.6 2.6 0 0 0-5.2 0v10z" fill="#0A0E14" />
    </svg>
  );
}

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link href="/" className="group flex items-center gap-3">
          <GateMark />
          <span className="font-display text-[15px] font-bold uppercase tracking-[0.22em] text-white">
            Agent<span className="text-accent transition-colors group-hover:text-white">Gate</span>
          </span>
          <span className="hidden border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-mut sm:inline">
            casper testnet
          </span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Main">
          {LINKS.map(({ href, label }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] transition-colors ${
                  active ? 'text-accent' : 'text-mut hover:text-white'
                }`}
              >
                {label}
              </Link>
            );
          })}
          <a
            href="https://github.com/agentgate"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub (placeholder link pre-launch)"
            className="ml-1 hidden border border-line px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white sm:block"
          >
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
