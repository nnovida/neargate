import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-center px-5 py-28 text-center sm:px-8">
      <p className="font-mono text-6xl font-bold text-accent">404</p>
      <h1 className="mt-4 font-display text-2xl font-semibold text-white">
        Nothing behind this gate.
      </h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-mut">
        The page you requested does not exist. Try the service catalog or the live activity feed.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/catalog"
          className="bg-accent px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-white transition-colors hover:bg-accent-dim"
        >
          catalog
        </Link>
        <Link
          href="/"
          className="border border-line px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white"
        >
          home
        </Link>
      </div>
    </div>
  );
}
