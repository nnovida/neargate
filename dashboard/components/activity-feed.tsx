'use client';

import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import type { ActivityEvent } from '@agentgate/shared';
import { addMotes, formatCspr, formatToken } from '@agentgate/shared';
import { fetcher, isChainDown, isRateLimited } from '@/lib/fetcher';
import { formatDateTime, formatInt, svcLabel, timeAgo } from '@/lib/format';
import type { ActivityResponse } from '@/lib/api-types';
import { TxHash } from '@/components/tx-hash';
import { ChainDownBanner, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { LiveDot } from '@/components/live-dot';

type Kind = ActivityEvent['kind'];

/** Per-kind presentation: the row's left rail colour, chip, and short label. */
function kindMeta(event: ActivityEvent): { label: string; rail: string; chip: string } {
  if (event.kind === 'payment') {
    return { label: 'payment', rail: 'border-l-accent', chip: 'border-accent/50 text-accent' };
  }
  if (event.kind === 'attestation') {
    const ok = event.success !== false;
    return ok
      ? { label: 'attest ✓', rail: 'border-l-ok', chip: 'border-ok/50 text-ok' }
      : { label: 'attest ✗', rail: 'border-l-warn', chip: 'border-warn/50 text-warn' };
  }
  return { label: 'register', rail: 'border-l-mut', chip: 'border-line text-mut' };
}

/* ── summary ─────────────────────────────────────────────────────────────── */

function StatTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="microlabel">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight text-white tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-mut">{sub}</p>
    </div>
  );
}

function Summary({ events }: { events: ActivityEvent[] }) {
  const payments = events.filter((e) => e.kind === 'payment');
  const attests = events.filter((e) => e.kind === 'attestation');
  // Native-CSPR volume only — token (WCSPR) payments carry the same 9-decimal
  // scale but are a different asset, so summing them into a CSPR total would lie.
  const volumeMotes = payments
    .filter((e) => !e.assetSymbol)
    .reduce((sum, e) => addMotes(sum, e.amountMotes ?? '0'), '0');
  const attestOk = attests.filter((e) => e.success !== false).length;
  const rate = attests.length ? Math.round((attestOk / attests.length) * 100) : null;
  const services = new Set(events.map((e) => e.serviceId).filter((id): id is number => id !== null)).size;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="events" value={formatInt(events.length)} sub="on-chain, newest first" />
      <StatTile label="payments" value={formatInt(payments.length)} sub={`${formatCspr(volumeMotes)} settled`} />
      <StatTile
        label="attestations"
        value={formatInt(attests.length)}
        sub={rate === null ? 'no scored calls yet' : `${rate}% success (${attestOk}/${attests.length})`}
      />
      <StatTile label="services" value={formatInt(services)} sub="touched in this window" />
    </div>
  );
}

/* ── filters ─────────────────────────────────────────────────────────────── */

const FILTERS: { id: Kind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'payment', label: 'Payments' },
  { id: 'attestation', label: 'Attestations' },
  { id: 'service_registered', label: 'Registrations' },
];

function Tabs({
  active,
  counts,
  onSelect,
}: {
  active: Kind | 'all';
  counts: Record<Kind | 'all', number>;
  onSelect: (id: Kind | 'all') => void;
}) {
  return (
    <div role="tablist" aria-label="Filter activity by type" className="flex flex-wrap gap-1">
      {FILTERS.map((f) => {
        const on = active === f.id;
        return (
          <button
            key={f.id}
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(f.id)}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
              on
                ? 'border-accent/60 bg-accent-soft text-white'
                : 'border-line text-mut hover:border-mut/40 hover:text-zinc-300'
            }`}
          >
            {f.label} <span className="ml-1 tabular-nums text-mut">{counts[f.id]}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── pager ───────────────────────────────────────────────────────────────── */

/** Rows per page. Client-side over the already-fetched window (no extra CSPR.cloud reads). */
const PAGE_SIZE = 15;

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  const btn =
    'border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-mut transition-colors hover:border-mut/40 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-mut';
  return (
    <nav aria-label="Activity pagination" className="flex items-center justify-between gap-3">
      <button type="button" className={btn} onClick={() => onPage(page - 1)} disabled={page === 0}>
        ‹ Prev
      </button>
      <span className="microlabel">
        Page <span className="tabular-nums text-white">{page + 1}</span> /{' '}
        <span className="tabular-nums text-white">{pageCount}</span>
      </span>
      <button
        type="button"
        className={btn}
        onClick={() => onPage(page + 1)}
        disabled={page >= pageCount - 1}
      >
        Next ›
      </button>
    </nav>
  );
}

/* ── table ───────────────────────────────────────────────────────────────── */

const HEADERS = ['Time', 'Type', 'Service', 'Event', 'Amount', 'Status', 'Tx'];

function Row({ event, network }: { event: ActivityEvent; network: string }) {
  const meta = kindMeta(event);
  return (
    <tr className="border-t border-line align-middle hover:bg-panel2/50">
      <td className={`whitespace-nowrap border-l-2 py-3 pl-4 pr-4 ${meta.rail}`}>
        <span className="font-mono text-[11px] text-mut" title={formatDateTime(event.timestamp)}>
          {timeAgo(event.timestamp)}
        </span>
      </td>
      <td className="whitespace-nowrap py-3 pr-4">
        <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] ${meta.chip}`}>
          {meta.label}
        </span>
      </td>
      <td className="whitespace-nowrap py-3 pr-4">
        {event.serviceId !== null ? (
          <Link
            href={`/services/${event.serviceId}`}
            className="font-mono text-[11px] text-mut underline decoration-line underline-offset-4 hover:text-accent"
          >
            {svcLabel(event.serviceId)}
          </Link>
        ) : (
          <span className="font-mono text-[11px] text-mut">—</span>
        )}
      </td>
      <td className="max-w-[22rem] py-3 pr-4">
        <span className="block truncate text-sm text-zinc-300" title={event.detail}>
          {event.detail}
        </span>
      </td>
      <td className="whitespace-nowrap py-3 pr-4 text-right font-mono text-xs tabular-nums text-white">
        {event.amountMotes ? (
          event.assetSymbol ? (
            formatToken(event.amountMotes, event.assetDecimals ?? 9, event.assetSymbol)
          ) : (
            formatCspr(event.amountMotes)
          )
        ) : (
          <span className="text-mut">—</span>
        )}
      </td>
      <td className="whitespace-nowrap py-3 pr-4">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-mut">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
          confirmed
        </span>
      </td>
      <td className="whitespace-nowrap py-3 pr-4 text-right">
        <TxHash hash={event.txHash} network={network} />
      </td>
    </tr>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="panel px-4 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-3 h-6 w-12" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>
      <div className="panel divide-y divide-line">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Soft, transient rate-limit state — the upstream history provider hit its quota. */
function RateLimited() {
  return (
    <div className="panel px-6 py-14 text-center">
      <p className="microlabel text-warn">rate limited</p>
      <p className="mx-auto mt-3 max-w-md font-display text-lg text-white">
        Live history is temporarily rate-limited
      </p>
      <p className="mx-auto mt-3 max-w-md text-sm text-mut">
        The on-chain history provider (CSPR.cloud) hit its request quota. This view refreshes
        automatically once the quota window resets — on-chain data and payments are unaffected.
      </p>
    </div>
  );
}

/** /activity ledger — polls /api/activity (server-cached ~30 s). */
export function ActivityFeed() {
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const [page, setPage] = useState(0);
  const { data, error, isLoading } = useSWR<ActivityResponse>('/api/activity?limit=100', fetcher, {
    refreshInterval: 30000,
    keepPreviousData: true,
  });

  if (!data) {
    if (isLoading) return <FeedSkeleton />;
    if (error) {
      if (isRateLimited(error)) return <RateLimited />;
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

  const events = data.events;
  const counts: Record<Kind | 'all', number> = {
    all: events.length,
    payment: events.filter((e) => e.kind === 'payment').length,
    attestation: events.filter((e) => e.kind === 'attestation').length,
    service_registered: events.filter((e) => e.kind === 'service_registered').length,
  };
  const rows = filter === 'all' ? events : events.filter((e) => e.kind === filter);
  // Client-side pagination over the fetched window. Clamp the page so a live refresh
  // that shrinks the set (or a filter change) can never strand us past the last page.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pagedRows = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const rangeStart = rows.length === 0 ? 0 : currentPage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(rows.length, currentPage * PAGE_SIZE + PAGE_SIZE);
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label.toLowerCase() ?? 'event';

  return (
    <div className="space-y-6">
      {data.stale ? (
        <p className="border border-warn/30 bg-warn/5 px-4 py-2 text-xs text-warn">
          Showing cached activity — the live history refresh is rate-limited (CSPR.cloud quota).
          Retrying automatically.
        </p>
      ) : error ? (
        <ChainDownBanner />
      ) : null}

      {events.length === 0 ? (
        <div className="panel px-6 py-14 text-center">
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
        <>
          <Summary events={events} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs
              active={filter}
              counts={counts}
              onSelect={(id) => {
                setFilter(id);
                setPage(0);
              }}
            />
            <p className="microlabel flex items-center gap-2">
              network <span className="text-white">{data.network}</span>
              <span className="text-line">·</span> polled every 5s
              <LiveDot stalled={error !== undefined} />
            </p>
          </div>

          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr>
                  {HEADERS.map((h) => (
                    <th
                      key={h}
                      className={`microlabel border-b border-line py-2.5 pr-4 font-normal ${
                        h === 'Time' ? 'pl-4' : ''
                      } ${h === 'Amount' || h === 'Tx' ? 'text-right' : ''}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={HEADERS.length} className="px-4 py-10 text-center text-sm text-mut">
                      No {FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} in this window.
                    </td>
                  </tr>
                ) : (
                  pagedRows.map((event, i) => (
                    <Row key={`${event.txHash}-${event.kind}-${i}`} event={event} network={data.network} />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />

          <p className="text-xs text-mut">
            Showing{' '}
            <span className="tabular-nums text-zinc-300">
              {formatInt(rangeStart)}–{formatInt(rangeEnd)}
            </span>{' '}
            of {formatInt(rows.length)}
            {filter === 'all' ? '' : ` ${filterLabel}`} event{rows.length === 1 ? '' : 's'}
            {events.length >= 100 ? ' (latest 100)' : ''}. Times are relative; hover for the exact
            timestamp. Every row links to its transaction on cspr.live.
          </p>
        </>
      )}
    </div>
  );
}
