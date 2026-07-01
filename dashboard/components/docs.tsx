import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyButton } from './copy';
import { DOCS_VERSION, REGISTRY_HASH_SHORT } from '@/lib/version';

/* Server-side building blocks for the /docs section. The only interactive piece
   is the client CopyButton (from copy.tsx) embedded in CodeBlock and StepFlow;
   active-nav and scroll-spy live in docs-nav.tsx. */

/** Page header — same microlabel + h1 + lede pattern as app/catalog/page.tsx. */
export function DocHeader({
  kicker,
  title,
  lede,
}: {
  kicker: string;
  title: ReactNode;
  lede: ReactNode;
}) {
  return (
    <header>
      <p className="microlabel text-accent">{kicker}</p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-mut">{lede}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">
        <span className="border border-line px-2 py-0.5">CLI v{DOCS_VERSION.cli}</span>
        <span className="border border-line px-2 py-0.5">SDK v{DOCS_VERSION.sdk}</span>
        <span className="border border-line px-2 py-0.5">registry {REGISTRY_HASH_SHORT}</span>
        <span className="border border-line px-2 py-0.5">{DOCS_VERSION.network}</span>
      </div>
    </header>
  );
}

/** Anchored section heading. `scroll-mt` keeps it clear of the sticky nav. */
export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-14 scroll-mt-24 border-b border-line pb-3 font-display text-xl font-semibold tracking-tight text-white sm:text-2xl"
    >
      <a href={`#${id}`} className="group">
        {children}
        <span aria-hidden className="ml-2 hidden text-accent/70 group-hover:inline">
          #
        </span>
      </a>
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3
      id={id}
      className="mt-10 scroll-mt-24 font-display text-base font-semibold tracking-tight text-white sm:text-lg"
    >
      <a href={`#${id}`} className="group">
        {children}
        <span aria-hidden className="ml-2 hidden text-accent/70 group-hover:inline">
          #
        </span>
      </a>
    </h3>
  );
}

/** Body paragraph. */
export function P({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-sm leading-7 text-mut">{children}</p>;
}

/** Inline identifier — flags, env vars, routes, field names. */
export function M({ children }: { children: ReactNode }) {
  return (
    <code className="whitespace-nowrap border border-line bg-panel2 px-1 py-px font-mono text-[0.85em] text-zinc-200">
      {children}
    </code>
  );
}

/** Internal cross-link with the house accent treatment. */
export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent underline underline-offset-4 hover:text-white">
      {children}
    </Link>
  );
}

/** Panel-wrapped data table. Cells may be strings or rich nodes (M, DocLink…). */
export function DocTable({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className="panel mt-5 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {head.map((h, i) => (
              <th key={i} className="microlabel whitespace-nowrap px-4 py-3 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/50 align-top last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-4 py-2.5 text-[13px] leading-6 text-mut">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Non-interactive code/output panel (example responses, printed output, JSON). */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="panel mt-5 bg-[#070A0F]">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        {label ? <p className="microlabel">{label}</p> : <span aria-hidden />}
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-6 text-zinc-300">
        {code}
      </pre>
    </div>
  );
}

/** Left-rule callout for notes, warnings and confirmations. */
export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'ok';
  title: string;
  children: ReactNode;
}) {
  const rule =
    tone === 'warn' ? 'border-warn' : tone === 'ok' ? 'border-ok' : 'border-accent/70';
  const label = tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-accent';
  return (
    <div className={`mt-5 border-l-2 ${rule} bg-panel px-4 py-3`}>
      <p className={`microlabel ${label}`}>{title}</p>
      <div className="mt-1.5 text-[13px] leading-6 text-mut">{children}</div>
    </div>
  );
}

/** Numbered vertical flow — same timeline rail idiom as the homepage roadmap. */
export function StepFlow({
  steps,
}: {
  steps: { title: string; body: ReactNode; code?: string }[];
}) {
  return (
    <ol className="mt-6 space-y-0">
      {steps.map((step, i) => (
        <li key={i} className="relative flex gap-5 pb-8 last:pb-0">
          <div className="flex flex-col items-center">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-accent/50 bg-panel font-mono text-xs font-bold text-accent">
              {String(i + 1).padStart(2, '0')}
            </span>
            {i < steps.length - 1 ? <span aria-hidden className="mt-1 w-px flex-1 bg-line" /> : null}
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h3 className="font-display text-base font-semibold text-white">{step.title}</h3>
            <div className="mt-1.5 text-sm leading-6 text-mut">{step.body}</div>
            {step.code ? (
              <div className="mt-3 flex items-start gap-3 border border-line bg-[#070A0F] px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11px] leading-6 text-zinc-300">
                  {step.code}
                </code>
                <CopyButton text={step.code} className="mt-0.5" />
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Grid of link cards — used for the docs index and cross-section pointers. */
export function CardGrid({
  cards,
}: {
  cards: { href: string; title: string; desc: string }[];
}) {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {cards.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="panel group p-5 transition-colors hover:border-accent/40"
        >
          <p className="font-display text-base font-semibold text-white transition-colors group-hover:text-accent">
            {c.title} <span aria-hidden>→</span>
          </p>
          <p className="mt-2 text-sm leading-6 text-mut">{c.desc}</p>
        </Link>
      ))}
    </div>
  );
}

/** HTTP-method + path header for an API/endpoint reference entry. */
export function ApiBadge({ method, path }: { method: string; path?: string }) {
  const m = method.toUpperCase();
  const tone =
    m === 'GET'
      ? 'border-ok/50 text-ok'
      : m === 'DELETE'
        ? 'border-warn/50 text-warn'
        : 'border-accent/50 text-accent';
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <span
        className={`border ${tone} px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em]`}
      >
        {m}
      </span>
      {path ? (
        <code className="font-mono text-[13px] text-zinc-200">{path}</code>
      ) : null}
    </div>
  );
}

/**
 * Definition list for parameters, fields, headers or env vars. Each prop shows
 * a name, an optional type/required/default meta line, and a description.
 */
export function PropList({
  items,
}: {
  items: {
    name: string;
    type?: string;
    required?: boolean;
    default?: string;
    desc: ReactNode;
  }[];
}) {
  return (
    <dl className="mt-5 divide-y divide-line border-y border-line">
      {items.map((it) => (
        <div key={it.name} className="py-3.5">
          <dt className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <code className="font-mono text-[13px] text-white">{it.name}</code>
            {it.type ? <span className="font-mono text-[11px] text-zinc-400">{it.type}</span> : null}
            {it.required ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">
                required
              </span>
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">
                optional
              </span>
            )}
            {it.default ? (
              <span className="font-mono text-[11px] text-zinc-400">default {it.default}</span>
            ) : null}
          </dt>
          <dd className="mt-1.5 text-[13px] leading-6 text-mut">{it.desc}</dd>
        </div>
      ))}
    </dl>
  );
}

/** End-of-page “keep reading” strip. */
export function NextLinks({ links }: { links: { href: string; label: string }[] }) {
  return (
    <div className="mt-16 border-t border-line pt-6">
      <p className="microlabel">keep reading</p>
      <div className="mt-4 flex flex-wrap gap-3">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="border border-line px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white"
          >
            {l.label} <span aria-hidden>→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
