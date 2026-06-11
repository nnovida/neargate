'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { formatCspr, motesToCspr } from '@agentgate/shared';
import { fetcher, isChainDown, isNotFound } from '@/lib/fetcher';
import { formatDateTime, formatInt, svcLabel, timeAgo, truncateMiddle } from '@/lib/format';
import type { ServiceDetailResponse } from '@/lib/api-types';
import { TrustBadge } from '@/components/trust-badge';
import { ScoreViz } from '@/components/score-viz';
import { TxHash } from '@/components/tx-hash';
import { CommandBlock, CopyButton } from '@/components/copy';
import { ChainDownBanner, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { LiveDot } from '@/components/live-dot';

function MetaRow({
  label,
  value,
  mono = true,
  copyValue,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyValue?: string;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-3 last:border-b-0">
      <span className="microlabel shrink-0">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          title={title ?? value}
          className={`truncate text-right text-sm ${mono ? 'font-mono text-[13px]' : ''} text-zinc-200`}
        >
          {value}
        </span>
        {copyValue ? <CopyButton text={copyValue} /> : null}
      </span>
    </div>
  );
}

function buildCurlSnippet(endpointUrl: string): string {
  return [
    '# 1 — call without payment → HTTP 402 + invoice JSON',
    `curl -i ${endpointUrl}`,
    '',
    '# 2 — pay priceMotes to paymentTarget with transfer_id = invoice.nonce,',
    '#     then retry with the payment proof headers',
    `curl -s ${endpointUrl} \\`,
    '  -H "X-Payment-Deploy-Hash: <deployHash>" \\',
    '  -H "X-Payment-Nonce: <nonce>"',
  ].join('\n');
}

function DetailSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-10 w-72" />
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="panel p-6 lg:col-span-7">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="mt-3 h-4 w-2/3" />
          <div className="mt-6 space-y-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </div>
        <div className="space-y-5 lg:col-span-5">
          <div className="panel p-6">
            <Skeleton className="h-28 w-28 rounded-full" />
          </div>
          <div className="panel p-6">
            <Skeleton className="h-9 w-40" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** /services/[id] data surface — polls /api/services/:id every 5 s. */
export function ServiceDetail({ id }: { id: number }) {
  const { data, error, isLoading } = useSWR<ServiceDetailResponse>(
    `/api/services/${id}`,
    fetcher,
    { refreshInterval: 5000, keepPreviousData: true },
  );

  if (!data) {
    if (isLoading) return <DetailSkeleton />;
    if (error) {
      if (isNotFound(error)) {
        return (
          <EmptyState label="404" title={`Service #${id} is not registered on-chain.`}>
            <p className="text-center text-sm text-mut">
              Check the{' '}
              <Link href="/catalog" className="text-accent underline underline-offset-4">
                catalog
              </Link>{' '}
              for live services.
            </p>
          </EmptyState>
        );
      }
      return isChainDown(error) ? (
        <>
          <ChainDownBanner />
          <EmptyState label="standby" title="Waiting for the chain to come back…" />
        </>
      ) : (
        <ErrorState title="Could not load this service" detail="The API returned an error." />
      );
    }
    return null;
  }

  const { service, score, trustTier, attestations, revenueMotes, balanceMotes, network, mode } =
    data;

  return (
    <>
      {error ? <ChainDownBanner /> : null}

      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="microlabel">
            {svcLabel(service.id)} · network <span className="text-white">{network}</span>
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {service.name}
          </h1>
        </div>
        <div className="flex items-center gap-3 pb-1">
          <TrustBadge tier={trustTier} />
          <span
            className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] ${
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
      </div>

      <div className="mt-8 grid gap-5 lg:grid-cols-12">
        {/* metadata */}
        <section className="panel p-6 lg:col-span-7">
          <p className="microlabel">service metadata</p>
          <p className="mt-3 text-sm leading-6 text-zinc-300">
            {service.description || 'No description provided.'}
          </p>
          <div className="mt-5">
            <MetaRow
              label="endpoint"
              value={service.endpointUrl}
              copyValue={service.endpointUrl}
            />
            <MetaRow label="price / call" value={formatCspr(service.priceMotes)} />
            <MetaRow
              label="payment target"
              value={truncateMiddle(service.paymentTarget, 22, 8)}
              title={service.paymentTarget}
              copyValue={service.paymentTarget}
            />
            <MetaRow
              label="owner"
              value={truncateMiddle(service.owner, 14, 8)}
              title={service.owner}
              copyValue={service.owner}
            />
            <MetaRow
              label="attestor"
              value={truncateMiddle(service.attestor, 14, 8)}
              title={service.attestor}
              copyValue={service.attestor}
            />
            <MetaRow label="registered" value={formatDateTime(service.createdAt)} mono={false} />
          </div>
        </section>

        <div className="space-y-5 lg:col-span-5">
          {/* score */}
          <section className="panel p-6">
            <div className="flex items-center justify-between">
              <p className="microlabel">reputation score</p>
              <TrustBadge tier={trustTier} />
            </div>
            <div className="mt-5">
              <ScoreViz score={score} />
            </div>
          </section>

          {/* revenue */}
          <section className="panel p-6">
            <p className="microlabel">revenue settled</p>
            <p className="mt-2 font-display text-4xl font-semibold tracking-tight text-white">
              {motesToCspr(revenueMotes)}
              <span className="ml-2 font-mono text-sm text-mut">CSPR</span>
            </p>
            <p className="mt-2 font-mono text-[11px] text-mut">
              {formatCspr(service.priceMotes)} × {formatInt(score.successCalls)} successful calls
            </p>
            {mode === 'mock' && balanceMotes !== null ? (
              <p className="mt-4 border-t border-line/60 pt-3 font-mono text-[11px] text-mut">
                payment-target wallet balance{' '}
                <span className="text-white">{formatCspr(balanceMotes)}</span>{' '}
                <span className="text-mut/70">(mock devnet)</span>
              </p>
            ) : null}
          </section>
        </div>
      </div>

      {/* 402 flow snippet */}
      <section className="mt-5">
        <div className="mb-3 flex items-center justify-between">
          <p className="microlabel">try it — the HTTP 402 flow</p>
        </div>
        <CommandBlock text={buildCurlSnippet(service.endpointUrl)} prompt={null} />
      </section>

      {/* attestation feed */}
      <section className="panel mt-5">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <p className="microlabel">on-chain attestations · newest first</p>
          <LiveDot stalled={error !== undefined} />
        </div>
        {attestations.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="microlabel">no attestations yet</p>
            <p className="mx-auto mt-3 max-w-md font-display text-lg text-white">
              The first paid call will write its attestation here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {attestations.map((a) => (
              <li
                key={a.recordTxHash}
                className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4"
              >
                <span
                  className={`inline-block w-16 shrink-0 border px-1.5 py-0.5 text-center font-mono text-[9px] uppercase tracking-[0.16em] ${
                    a.success ? 'border-ok/50 text-ok' : 'border-warn/50 text-warn'
                  }`}
                >
                  {a.success ? 'ok ✓' : 'fail ✗'}
                </span>
                <span className="w-20 shrink-0 font-mono text-[11px] text-mut">
                  {timeAgo(a.timestamp)}
                </span>
                <span className="min-w-0 flex-1 font-mono text-[11px] text-mut">
                  payment <TxHash hash={a.paymentDeployHash} network={network} />
                </span>
                <span className="shrink-0 font-mono text-[11px] text-mut">
                  attest <TxHash hash={a.recordTxHash} network={network} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
