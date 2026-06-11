import Link from 'next/link';
import { StatsStrip } from '@/components/stats-strip';
import { CommandBlock } from '@/components/copy';

const WRAP_CMD =
  'npx agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"';

const STEPS = [
  {
    n: '01',
    title: 'Wrap',
    body: 'One command registers your API on the Casper registry contract and drops a 402 paywall in front of it. No billing code, no accounts, no keys to issue.',
    code: 'npx agentgate wrap <url> --price 0.5',
  },
  {
    n: '02',
    title: 'Discover',
    body: 'Agents read the on-chain catalog — price, endpoint, trust score — pick a service, and get an HTTP 402 invoice with a one-time payment nonce.',
    code: 'GET /svc/1 → 402 { priceMotes, nonce }',
  },
  {
    n: '03',
    title: 'Get paid',
    body: 'The agent pays in native CSPR with transfer_id = nonce and retries with proof. Every served call writes a reputation attestation back on-chain.',
    code: '200 OK · attestation recorded ✓',
  },
] as const;

const ROADMAP = [
  {
    tag: 'NOW',
    title: 'Casper Testnet · Plan B settlement',
    body: 'Native CSPR transfers carrying HTTP 402 semantics (transfer_id = invoice nonce), verified via CSPR.cloud. Registry + reputation contract live.',
    done: true,
  },
  {
    tag: 'NEXT',
    title: 'Casper Mainnet launch',
    body: 'Audited registry deploy, real CSPR settlement, seller onboarding for the first indie data providers.',
    done: false,
  },
  {
    tag: 'Q3',
    title: 'x402 Facilitator (Plan A)',
    body: 'Swap the built-in verifier for the official Casper x402 Facilitator behind the existing PaymentVerifier seam — zero changes for sellers.',
    done: false,
  },
  {
    tag: 'Q3',
    title: 'CSPR.cloud streaming',
    body: 'Replace 5-second polling with push-based streaming for instant catalog, payment and attestation updates.',
    done: false,
  },
  {
    tag: 'Q4',
    title: 'MCP server',
    body: 'A Model Context Protocol server so Claude and other agents can query the registry and pay for services natively from any conversation.',
    done: false,
  },
] as const;

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-5 sm:px-8">
      {/* ── hero ─────────────────────────────────────────────── */}
      <section className="pb-16 pt-20 sm:pb-24 sm:pt-28">
        <p
          className="microlabel animate-fade-up text-accent"
          style={{ animationDelay: '0ms' }}
        >
          casper testnet · http 402 · on-chain reputation
        </p>
        <h1
          className="mt-5 max-w-3xl animate-fade-up font-display text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-6xl"
          style={{ animationDelay: '90ms' }}
        >
          Stripe for AI agents
          <br />
          on Casper<span className="text-accent">.</span>
        </h1>
        <p
          className="mt-6 max-w-2xl animate-fade-up text-base leading-7 text-mut sm:text-lg"
          style={{ animationDelay: '180ms' }}
        >
          AgentGate turns any API into a paid x402 service in one command — machine-to-machine
          micropayments in native CSPR, with on-chain discovery and reputation. No cards, no KYC,
          no API keys.
        </p>
        <div
          className="mt-9 animate-fade-up"
          style={{ animationDelay: '270ms' }}
        >
          <CommandBlock text={WRAP_CMD} wrap typewriter />
        </div>
        <div
          className="mt-7 flex flex-wrap items-center gap-3 animate-fade-up"
          style={{ animationDelay: '360ms' }}
        >
          <Link
            href="/catalog"
            className="bg-accent px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-white shadow-glow-sm transition-colors hover:bg-accent-dim"
          >
            browse the catalog →
          </Link>
          <Link
            href="/activity"
            className="border border-line px-5 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:border-accent/60 hover:text-white"
          >
            live activity
          </Link>
          <a
            href="https://github.com/agentgate"
            target="_blank"
            rel="noopener noreferrer"
            title="Placeholder link pre-launch"
            className="px-2 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-mut transition-colors hover:text-accent"
          >
            github ↗
          </a>
        </div>
      </section>

      {/* ── live stats ───────────────────────────────────────── */}
      <section aria-label="Live network stats" className="pb-20 sm:pb-28">
        <StatsStrip />
      </section>

      {/* ── how it works ─────────────────────────────────────── */}
      <section className="pb-20 sm:pb-28">
        <p className="microlabel">how it works</p>
        <h2 className="mt-3 max-w-xl font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Wrap an API. Agents find it, pay it, and rate it — all on-chain.
        </h2>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {STEPS.map((step) => (
            <div key={step.n} className="panel flex flex-col p-6">
              <span className="font-mono text-4xl font-bold text-accent/85">{step.n}</span>
              <h3 className="mt-4 font-display text-xl font-semibold text-white">{step.title}</h3>
              <p className="mt-3 flex-1 text-sm leading-6 text-mut">{step.body}</p>
              <code className="mt-6 block overflow-x-auto whitespace-nowrap border border-line bg-[#070A0F] px-3 py-2 font-mono text-[11px] text-zinc-300">
                {step.code}
              </code>
            </div>
          ))}
        </div>
      </section>

      {/* ── why on-chain ─────────────────────────────────────── */}
      <section className="pb-20 sm:pb-28">
        <div className="panel grid gap-px overflow-hidden bg-line md:grid-cols-3">
          {[
            {
              k: '402',
              t: 'Native HTTP semantics',
              d: 'The paywall speaks the web’s own “Payment Required” status — any agent that can fetch can pay.',
            },
            {
              k: '< 1¢',
              t: 'True micropayments',
              d: 'Per-call pricing in motes. No minimum fees, no monthly plans — price a call at half a cent if you want.',
            },
            {
              k: 'TX×2',
              t: 'Verifiable reputation',
              d: 'Every paid call leaves two on-chain transactions: the payment and the attestation that scores the service.',
            },
          ].map((f) => (
            <div key={f.k} className="bg-panel p-6">
              <span className="font-mono text-sm text-accent">{f.k}</span>
              <h3 className="mt-2 font-display text-lg font-semibold text-white">{f.t}</h3>
              <p className="mt-2 text-sm leading-6 text-mut">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── roadmap ──────────────────────────────────────────── */}
      <section className="pb-20 sm:pb-28">
        <p className="microlabel">roadmap</p>
        <h2 className="mt-3 font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          Built to outlive the hackathon.
        </h2>
        <ol className="mt-10 space-y-0">
          {ROADMAP.map((item, i) => (
            <li key={item.title} className="relative flex gap-6 pb-10 last:pb-0">
              {/* timeline rail */}
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${
                    item.done
                      ? 'border-accent bg-accent shadow-glow-sm'
                      : 'border-line bg-ink'
                  }`}
                />
                {i < ROADMAP.length - 1 ? (
                  <span aria-hidden className="mt-1 w-px flex-1 bg-line" />
                ) : null}
              </div>
              <div className="-mt-0.5 pb-2">
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.22em] ${
                    item.done ? 'text-accent' : 'text-mut'
                  }`}
                >
                  {item.tag}
                  {item.done ? ' · shipped' : ''}
                </span>
                <h3 className="mt-1 font-display text-lg font-semibold text-white">{item.title}</h3>
                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-mut">{item.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── closing CTA ──────────────────────────────────────── */}
      <section className="pb-24 sm:pb-32">
        <div className="panel relative overflow-hidden p-8 sm:p-12">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl"
          />
          <p className="microlabel">get started</p>
          <h2 className="mt-3 max-w-lg font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Wrap your first API in under five minutes.
          </h2>
          <div className="mt-7 max-w-2xl">
            <CommandBlock text={WRAP_CMD} wrap />
          </div>
          <p className="mt-4 font-mono text-[11px] text-mut">
            then open{' '}
            <Link href="/catalog" className="text-accent underline underline-offset-4">
              /catalog
            </Link>{' '}
            and watch agents find you.
          </p>
        </div>
      </section>
    </div>
  );
}
