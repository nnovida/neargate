'use client';

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
        <span
          title={service.active ? 'Active' : 'Inactive'}
          className={`mt-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
            service.active ? 'text-ok' : 'text-mut'
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${service.active ? 'bg-ok animate-pulse-dot' : 'bg-mut/60'}`}
          />
          {service.active ? 'active' : 'inactive'}
        </span>
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

/** /catalog data surface — polls /api/services every 5 s. */
export function CatalogGrid() {
  const { data, error, isLoading } = useSWR<ServicesResponse>('/api/services', fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  if (!data) {
    if (isLoading) {
      return (
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
      <div className="mb-5 flex items-center justify-between">
        <p className="font-mono text-xs text-mut">
          <span className="text-white">{formatInt(data.services.length)}</span> service
          {data.services.length === 1 ? '' : 's'} on-chain · network{' '}
          <span className="text-white">{data.network}</span>
        </p>
        <LiveDot stalled={error !== undefined} />
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
