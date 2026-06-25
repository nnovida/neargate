'use client';

/** App Router route-level error boundary: a recoverable failure surface. */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="panel mx-auto my-16 max-w-md px-6 py-10 text-center">
      <p className="microlabel text-accent">error</p>
      <p className="mt-3 font-display text-lg text-white">Something went wrong</p>
      <p className="mt-2 text-sm text-mut">
        This page failed to render. The data services may be temporarily unavailable.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 border border-line px-4 py-2 font-mono text-xs uppercase tracking-[0.18em] text-zinc-300 transition-colors hover:border-accent hover:text-accent"
      >
        try again
      </button>
    </div>
  );
}
