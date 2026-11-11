'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { formatNear, formatPriceWithStorage, yoctoToNear } from '@agentgate/shared';
import { fetcher, isChainDown, isNotFound } from '@/lib/fetcher';
import { formatDateTime, formatInt, svcLabel, timeAgo } from '@/lib/format';
import { shellUrl } from '@/lib/links';
import type { ServiceDetailResponse } from '@/lib/api-types';
import { AccountLink } from '@/components/account-id';
import { TrustBadge } from '@/components/trust-badge';
import { ScoreViz } from '@/components/score-viz';
import { SafeLink } from '@/components/safe-link';
import { TxHash } from '@/components/tx-hash';
import { CommandBlock, CopyButton } from '@/components/copy';
import { ChainDownBanner, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { LiveDot } from '@/components/live-dot';

/** One labelled row of the metadata panel; `children` is the value (text, a link, an account). */
function MetaRow({
  label,
  mono = true,
  copyValue,
  children,
}: {
  label: string;
  mono?: boolean;
  copyValue?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line/60 py-3 last:border-b-0">
      <span className="microlabel shrink-0">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`truncate text-right text-sm ${mono ? 'font-mono text-[13px]' : ''} text-zinc-200`}
        >
          {children}
        </span>
        {copyValue ? <CopyButton text={copyValue} /> : null}
      </span>
    </div>
  );
}

/** The endpoint is seller-controlled bytes: it enters the copy-paste snippet only as one quoted shell word. */
function buildCurlSnippet(
  serviceId: number,
  endpointUrl: string,
  network: string,
  mode: ServiceDetailResponse['mode'],
): string {
  const target = shellUrl(endpointUrl);
  // The CLI defaults to live mode: against the offline devnet it needs --mode mock.
  const modeFlag = mode === 'mock' ? ' --mode mock' : '';
  return [
    '# the same flow in one command (budget cap in NEAR, on price + storage fee):',
    `#   npm run neargate -- buy ${serviceId} --max <near> --account <your account>${modeFlag}`,
    '',
    '# 1 — call without payment → HTTP 402 + PaymentRequiredResponse JSON',
    `curl -i ${target}`,
    '',
    '# 2 — call pay({service_id, nonce: accepts[0].extra.nonce}) on accepts[0].payTo,',
    '#     attaching accepts[0].maxAmountRequired yocto (price + storage fee); receive <txHash>.',
    `#     Encode proof: base64({"x402Version":1,"scheme":"exact","network":"${network}",`,
    '#       "payload":{"kind":"tx","transaction":"<txHash>","nonce":"<nonce>","payer":"<account>"}})',
    `curl -s ${target} \\`,
    '  -H "X-PAYMENT: <base64-encoded-payload>"',
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

  const { service, score, trustTier, attestations, revenueYocto, balanceYocto, network, explorerUrl, mode } = data;

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
            <MetaRow label="endpoint" copyValue={service.endpointUrl}>
              {/* The registry stores any bytes here: link it only when it is http(s). */}
              <SafeLink
                href={service.endpointUrl}
                title={service.endpointUrl}
                className="hover:text-accent"
              >
                {service.endpointUrl}
              </SafeLink>
            </MetaRow>
            <MetaRow label="price / call">{formatNear(service.priceYocto)}</MetaRow>
            <MetaRow label="buyer attaches">{formatPriceWithStorage(service.priceYocto)}</MetaRow>
            <MetaRow label="payment target" copyValue={service.paymentTarget}>
              <AccountLink accountId={service.paymentTarget} network={network} explorerUrl={explorerUrl} />
            </MetaRow>
            <MetaRow label="owner" copyValue={service.owner}>
              <AccountLink accountId={service.owner} network={network} explorerUrl={explorerUrl} />
            </MetaRow>
            <MetaRow label="attestor" copyValue={service.attestor}>
              <AccountLink accountId={service.attestor} network={network} explorerUrl={explorerUrl} />
            </MetaRow>
            <MetaRow label="registered" mono={false}>
              {formatDateTime(service.createdAt)}
            </MetaRow>
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
              {yoctoToNear(revenueYocto)}
              <span className="ml-2 font-mono text-sm text-mut">NEAR</span>
            </p>
            <p className="mt-2 font-mono text-[11px] text-mut">
              {formatNear(service.priceYocto)} × {formatInt(score.successCalls)} successful calls
            </p>
            {mode === 'mock' && balanceYocto !== null ? (
              <p className="mt-4 border-t border-line/60 pt-3 font-mono text-[11px] text-mut">
                payment-target wallet balance{' '}
                <span className="text-white">{formatNear(balanceYocto)}</span>{' '}
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
        <CommandBlock text={buildCurlSnippet(service.id, service.endpointUrl, network, mode)} prompt={null} />
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
                key={a.nonce}
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
                  payment <TxHash hash={a.paymentTxHash} network={network} explorerUrl={explorerUrl} />
                </span>
                <span className="shrink-0 font-mono text-[11px] text-mut">
                  nonce <code className="text-zinc-300">{a.nonce}</code>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
