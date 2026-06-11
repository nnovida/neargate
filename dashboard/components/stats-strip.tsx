'use client';

import useSWR from 'swr';
import { motesToCspr } from '@agentgate/shared';
import { fetcher, isChainDown } from '@/lib/fetcher';
import { formatInt } from '@/lib/format';
import type { StatsResponse } from '@/lib/api-types';
import { LiveDot } from '@/components/live-dot';
import { Skeleton } from '@/components/states';

function Cell({
  label,
  value,
  unit,
  loading,
}: {
  label: string;
  value: string | null;
  unit?: string;
  loading: boolean;
}) {
  return (
    <div className="flex-1 px-6 py-6 sm:py-7">
      <p className="microlabel">{label}</p>
      {loading ? (
        <Skeleton className="mt-3 h-9 w-24" />
      ) : (
        <p className="mt-2 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {value ?? '—'}
          {unit ? <span className="ml-1.5 font-mono text-sm text-mut">{unit}</span> : null}
        </p>
      )}
    </div>
  );
}

/** Landing-page live stats strip — polls /api/stats every 5 s. */
export function StatsStrip() {
  const { data, error, isLoading } = useSWR<StatsResponse>('/api/stats', fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });

  const loading = isLoading && !data;
  const down = error !== undefined && isChainDown(error);

  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-line px-6 py-3">
        <p className="microlabel">live network stats · 5s poll</p>
        <LiveDot stalled={error !== undefined} />
      </div>

      {error && !data ? (
        <div className="px-6 py-8 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">
            {down ? 'chain unreachable' : 'stats unavailable'}
          </p>
          <p className="mt-2 text-sm text-mut">
            {down
              ? 'The devnet is not responding — stats will appear as soon as it is back.'
              : 'Could not load stats — retrying automatically.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line sm:flex-row sm:divide-x sm:divide-y-0">
          <Cell
            label="services listed"
            loading={loading}
            value={data ? formatInt(data.services) : null}
          />
          <Cell
            label="paid calls attested"
            loading={loading}
            value={data ? formatInt(data.totalCalls) : null}
          />
          <Cell
            label="revenue settled"
            loading={loading}
            value={data ? motesToCspr(data.revenueMotes) : null}
            unit="CSPR"
          />
          <Cell label="network" loading={loading} value={data ? data.network : null} />
        </div>
      )}
    </div>
  );
}
