import type { ReactNode } from 'react';

/** Shimmer placeholder block. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

/** Red banner shown on every data surface when /api/* reports chain_unreachable. */
export function ChainDownBanner() {
  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-3 border border-accent/40 bg-accent-soft px-4 py-3"
    >
      <span aria-hidden className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse-dot" />
      <div>
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">
          chain unreachable
        </p>
        <p className="mt-1 text-sm text-mut">
          The devnet / chain API is not responding. Showing last known data — retrying every 5
          seconds.
        </p>
      </div>
    </div>
  );
}

/** Generic non-chain error surface. */
export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="panel px-6 py-10 text-center">
      <p className="microlabel text-accent">error</p>
      <p className="mt-3 font-display text-lg text-white">{title}</p>
      {detail ? <p className="mt-2 text-sm text-mut">{detail}</p> : null}
      <p className="mt-4 font-mono text-xs text-mut">retrying automatically…</p>
    </div>
  );
}

/** Intentional empty state with optional action block (e.g. the wrap command). */
export function EmptyState({
  label,
  title,
  children,
}: {
  label: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="panel px-6 py-14 text-center sm:px-10">
      <p className="microlabel">{label}</p>
      <p className="mx-auto mt-4 max-w-md font-display text-xl text-white">{title}</p>
      {children ? <div className="mx-auto mt-6 max-w-xl text-left">{children}</div> : null}
    </div>
  );
}
