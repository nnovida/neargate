'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { formatCspr } from '@agentgate/shared';
import { fetcher, isChainDown } from '@/lib/fetcher';
import { formatInt, svcLabel } from '@/lib/format';
import type { CatalogEntry, ServicesResponse } from '@/lib/api-types';
import { TrustBadge } from '@/components/trust-badge';
import { CommandBlock } from '@/components/copy';
import { ChainDownBanner, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { LiveDot } from '@/components/live-dot';

const WRAP_CMD =
  'npx agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"';

type View = 'grid' | 'list';
const VIEW_KEY = 'agentgate:catalog-view';

function ActiveDot({ active }: { active: boolean }) {
  return (
    <span
      title={active ? 'Active' : 'Inactive'}
      className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
        active ? 'text-ok' : 'text-mut'
      }`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-ok animate-pulse-dot' : 'bg-mut/60'}`}
      />
      {active ? 'active' : 'inactive'}
    </span>
  );
}

function CardSkeleton() {
  return (
    <div className="panel p-6">
      <Skeleton className="h-5 w-36" />
      <Skeleton className="mt-4 h-4 w-full" />
      <Skeleton className="mt-2 h-4 w-2/3" />
      <div className="mt-6 flex items-end justify-between">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-5 w-20" />
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <Skeleton className="h-4 w-40" />
      <div className="ml-auto flex items-center gap-6">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-12" />
      </div>
    </div>
  );
}

function ServiceCard({ entry }: { entry: CatalogEntry }) {
  const { service, score, trustTier } = entry;
  return (
    <Link
      href={`/services/${service.id}`}
      className="panel group flex flex-col p-6 transition-colors hover:border-accent/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="microlabel">{svcLabel(service.id)}</p>
          <h3 className="mt-1 truncate font-display text-lg font-semibold text-white">
            {service.name}
          </h3>
        </div>
        <ActiveDot active={service.active} />
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm leading-5 text-mut">
        {service.description || 'No description provided.'}
      </p>

      <div className="mt-6 flex items-end justify-between gap-3 border-t border-line pt-4">
        <div>
          <p className="microlabel">price / call</p>
          <p className="mt-1 font-mono text-xl text-white">{formatCspr(service.priceMotes)}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <TrustBadge tier={trustTier} />
          <p className="font-mono text-[11px] text-mut">
            {formatInt(score.successCalls)}/{formatInt(score.totalCalls)} calls ok
          </p>
        </div>
      </div>

      <span className="mt-4 font-mono text-[11px] uppercase tracking-[0.18em] text-mut transition-colors group-hover:text-accent">
        view service →
      </span>
    </Link>
  );
}

function ServiceRow({ entry }: { entry: CatalogEntry }) {
  const { service, score, trustTier } = entry;
  return (
    <Link
      href={`/services/${service.id}`}
      className="group flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-white/[0.02] sm:flex-row sm:items-center sm:gap-4"
    >
      {/* name + description */}
      <div className="min-w-0 sm:flex-1">
        <div className="flex items-center gap-2">
          <span className="microlabel shrink-0">{svcLabel(service.id)}</span>
          <h3 className="truncate font-display text-base font-semibold text-white">
            {service.name}
          </h3>
        </div>
        <p className="mt-0.5 truncate text-xs leading-5 text-mut">
          {service.description || 'No description provided.'}
        </p>
      </div>

      {/* price */}
      <div className="shrink-0 sm:w-28 sm:text-right">
        <span className="microlabel sm:hidden">price / call · </span>
        <span className="font-mono text-sm text-white">{formatCspr(service.priceMotes)}</span>
      </div>

      {/* trust */}
      <div className="shrink-0 sm:w-24 sm:text-right">
        <TrustBadge tier={trustTier} />
      </div>

      {/* score */}
      <div className="shrink-0 font-mono text-[11px] text-mut sm:w-20 sm:text-right">
        {formatInt(score.successCalls)}/{formatInt(score.totalCalls)} ok
      </div>

      {/* status */}
      <div className="shrink-0 sm:w-24 sm:text-right">
        <ActiveDot active={service.active} />
      </div>

      <span
        aria-hidden
        className="hidden shrink-0 font-mono text-mut transition-colors group-hover:text-accent sm:inline"
      >
        →
      </span>
    </Link>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="0.5" y="0.5" width="5.5" height="5.5" rx="1" stroke="currentColor" />
      <rect x="8" y="0.5" width="5.5" height="5.5" rx="1" stroke="currentColor" />
      <rect x="0.5" y="8" width="5.5" height="5.5" rx="1" stroke="currentColor" />
      <rect x="8" y="8" width="5.5" height="5.5" rx="1" stroke="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <line x1="0.5" y1="2" x2="13.5" y2="2" stroke="currentColor" strokeLinecap="round" />
      <line x1="0.5" y1="7" x2="13.5" y2="7" stroke="currentColor" strokeLinecap="round" />
      <line x1="0.5" y1="12" x2="13.5" y2="12" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const opts: { id: View; label: string; icon: JSX.Element }[] = [
    { id: 'grid', label: 'Grid', icon: <GridIcon /> },
    { id: 'list', label: 'List', icon: <ListIcon /> },
  ];
  return (
    <div
      role="group"
      aria-label="Catalog view"
      className="inline-flex items-center gap-1 rounded-md border border-line bg-white/[0.02] p-0.5"
    >
      {opts.map((o) => {
        const selected = view === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={selected}
            title={`${o.label} view`}
            className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
              selected ? 'bg-accent/15 text-accent' : 'text-mut hover:text-zinc-300'
            }`}
          >
            {o.icon}
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** /catalog data surface — polls /api/services every 5 s, grid or list view. */
export function CatalogGrid() {
  const [view, setView] = useState<View>('grid');

  // Restore the saved preference after mount (avoids SSR/client mismatch).
  useEffect(() => {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === 'grid' || saved === 'list') setView(saved);
  }, []);

  function changeView(v: View) {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable (private mode) — preference just won't persist */
    }
  }

  const { data, error, isLoading } = useSWR<ServicesResponse>('/api/services', fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  if (!data) {
    if (isLoading) {
      return view === 'list' ? (
        <div className="panel divide-y divide-line">
          {Array.from({ length: 5 }, (_, i) => (
            <RowSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      );
    }
    if (error) {
      return isChainDown(error) ? (
        <>
          <ChainDownBanner />
          <EmptyState label="standby" title="Waiting for the chain to come back…">
            <p className="text-center text-sm text-mut">
              Start the local stack with{' '}
              <code className="font-mono text-zinc-300">npm run dev</code> and this catalog will
              populate itself.
            </p>
          </EmptyState>
        </>
      ) : (
        <ErrorState title="Could not load the catalog" detail="The API returned an error." />
      );
    }
    return null; // first render before SWR kicks in
  }

  return (
    <>
      {error ? <ChainDownBanner /> : null}
      <div className="mb-5 flex items-center justify-between gap-4">
        <p className="font-mono text-xs text-mut">
          <span className="text-white">{formatInt(data.services.length)}</span> service
          {data.services.length === 1 ? '' : 's'} on-chain · network{' '}
          <span className="text-white">{data.network}</span>
        </p>
        <div className="flex items-center gap-4">
          <LiveDot stalled={error !== undefined} />
          {data.services.length > 0 ? <ViewToggle view={view} onChange={changeView} /> : null}
        </div>
      </div>

      {data.services.length === 0 ? (
        <EmptyState
          label="registry empty"
          title="No services on-chain yet — wrap your first API in one command."
        >
          <CommandBlock text={WRAP_CMD} />
          <p className="mt-3 text-center text-xs text-mut">
            Registers the service on-chain, puts a 402 paywall in front of it, and lists it here
            automatically.
          </p>
        </EmptyState>
      ) : view === 'list' ? (
        <div className="panel overflow-hidden">
          {/* column header (sm+) */}
          <div className="hidden border-b border-line px-5 py-2.5 sm:flex sm:items-center sm:gap-4">
            <span className="microlabel flex-1">service</span>
            <span className="microlabel w-28 text-right">price / call</span>
            <span className="microlabel w-24 text-right">trust</span>
            <span className="microlabel w-20 text-right">score</span>
            <span className="microlabel w-24 text-right">status</span>
            <span className="w-4" aria-hidden />
          </div>
          <div className="divide-y divide-line">
            {data.services.map((entry) => (
              <ServiceRow key={entry.service.id} entry={entry} />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data.services.map((entry) => (
            <ServiceCard key={entry.service.id} entry={entry} />
          ))}
        </div>
      )}
    </>
  );
}
