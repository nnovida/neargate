'use client';

import Link from 'next/link';
import useSWR from 'swr';
import type { ActivityEvent } from '@agentgate/shared';
import { formatCspr } from '@agentgate/shared';
import { fetcher, isChainDown } from '@/lib/fetcher';
import { svcLabel, timeAgo } from '@/lib/format';
import type { ActivityResponse } from '@/lib/api-types';
import { TxHash } from '@/components/tx-hash';
import { ChainDownBanner, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { LiveDot } from '@/components/live-dot';

function KindChip({ event }: { event: ActivityEvent }) {
  if (event.kind === 'payment') {
    return (
      <span className="inline-block w-24 shrink-0 border border-accent/50 px-1.5 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.16em] text-accent">
        payment
      </span>
    );
  }
  if (event.kind === 'attestation') {
    const ok = event.success !== false;
    return (
      <span
        className={`inline-block w-24 shrink-0 border px-1.5 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.16em] ${
          ok ? 'border-ok/50 text-ok' : 'border-warn/50 text-warn'
        }`}
      >
        attest {ok ? '✓' : '✗'}
      </span>
    );
  }
  return (
    <span className="inline-block w-24 shrink-0 border border-line px-1.5 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.16em] text-mut">
      registered
    </span>
  );
}

function Row({ event, network }: { event: ActivityEvent; network: string }) {
  return (
    <li className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex shrink-0 items-center gap-4">
        <span className="w-20 shrink-0 font-mono text-[11px] text-mut" title={String(event.timestamp)}>
          {timeAgo(event.timestamp)}
        </span>
        <KindChip event={event} />
      </div>
      <p className="min-w-0 flex-1 truncate text-sm text-zinc-300" title={event.detail}>
        {event.serviceId !== null ? (
          <Link
            href={`/services/${event.serviceId}`}
            className="mr-2 font-mono text-[11px] text-mut underline decoration-line underline-offset-4 hover:text-accent"
          >
            {svcLabel(event.serviceId)}
          </Link>
        ) : null}
        {event.detail}
      </p>
      <div className="flex shrink-0 items-center gap-4">
        {event.amountMotes ? (
          <span className="font-mono text-xs text-white">{formatCspr(event.amountMotes)}</span>
        ) : null}
        <TxHash hash={event.txHash} network={network} />
      </div>
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div className="panel divide-y divide-line">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-32" />
        </div>
      ))}
    </div>
  );
}

/** /activity unified feed — polls /api/activity every 5 s. */
export function ActivityFeed() {
  const { data, error, isLoading } = useSWR<ActivityResponse>('/api/activity?limit=100', fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  if (!data) {
    if (isLoading) return <FeedSkeleton />;
    if (error) {
      return isChainDown(error) ? (
        <>
          <ChainDownBanner />
          <EmptyState label="standby" title="Waiting for the chain to come back…" />
        </>
      ) : (
        <ErrorState title="Could not load activity" detail="The API returned an error." />
      );
    }
    return null;
  }

  return (
    <>
      {error ? <ChainDownBanner /> : null}
      <div className="panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <p className="microlabel">
            registrations · payments · attestations — network{' '}
            <span className="text-white">{data.network}</span>
          </p>
          <LiveDot stalled={error !== undefined} />
        </div>
        {data.events.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="microlabel">no activity yet</p>
            <p className="mx-auto mt-3 max-w-md font-display text-lg text-white">
              The first registration, payment or attestation will stream in here.
            </p>
            <p className="mt-3 text-sm text-mut">
              Run <code className="font-mono text-zinc-300">npm run demo</code> to fire a full
              wrap → 402 → pay → attest loop.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {data.events.map((event, i) => (
              <Row key={`${event.txHash}-${event.kind}-${i}`} event={event} network={data.network} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
