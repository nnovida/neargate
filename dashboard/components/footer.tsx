import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div>
          <p className="font-display text-sm font-bold uppercase tracking-[0.22em] text-white">
            Agent<span className="text-accent">Gate</span>
          </p>
          <p className="mt-1 text-xs text-mut">
            HTTP 402 payments for AI agents on Casper · Built for the Casper Agentic Buildathon
            2026.
          </p>
        </div>
        <div className="flex items-center gap-5 font-mono text-xs uppercase tracking-[0.18em]">
          <a
            href="https://example.invalid/AgentGate"
            target="_blank"
            rel="noopener noreferrer"
            className="text-mut transition-colors hover:text-accent"
          >
            GitHub
          </a>
          <Link href="/docs" className="text-mut transition-colors hover:text-accent">
            Docs
          </Link>
        </div>
      </div>
      <div className="border-t border-line/50">
        <p className="mx-auto max-w-6xl px-5 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-mut/60 sm:px-8">
          MIT licensed · example.invalid/AgentGate
        </p>
      </div>
    </footer>
  );
}
