import type { Metadata } from 'next';
import { CommandBlock } from '@/components/copy';
import {
  Callout,
  CodeBlock,
  DocHeader,
  DocLink,
  DocTable,
  H2,
  H3,
  M,
  NextLinks,
  P,
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Docs — Quickstart',
  description:
    'From clean clone to a verified on-chain payment loop in five minutes: install, run the one-shot demo, bring up the seeded dev stack and open the dashboard.',
};

export default function QuickstartPage() {
  return (
    <>
      <DocHeader
        kicker="docs / quickstart"
        title="Quickstart"
        lede="From a clean clone to a verified register → 402 → pay → serve → attest → score loop, with the dashboard showing live data. Everything below runs in mock mode against the in-memory devnet — no testnet keys required."
      />

      <H2 id="prerequisites">Prerequisites</H2>
      <DocTable
        head={['Requirement', 'Version', 'Notes']}
        rows={[
          [<M key="n">Node.js</M>, '≥ 22', 'The monorepo uses npm workspaces.'],
          [
            <M key="r">Rust toolchain</M>,
            'pinned nightly',
            <span key="d">
              Only needed for contract work — <M>rust-toolchain.toml</M> auto-selects it. See{' '}
              <DocLink href="/docs/contract#build-test">Contract → Build &amp; test</DocLink>.
            </span>,
          ],
        ]}
      />

      <H2 id="install">1 · Clone and install</H2>
      <CommandBlock text="npm install" />
      <P>
        One install at the repo root covers every workspace package plus the dashboard. No
        further setup is needed for mock mode — every env var has a working default (see{' '}
        <DocLink href="/docs/configuration">Configuration</DocLink>).
      </P>

      <H2 id="demo">2 · Run the one-shot demo</H2>
      <CommandBlock text="npm run demo" />
      <P>
        This is the fastest proof the whole system works. It boots the devnet, the oracle (with
        a static fixture) and the middleware <em>in-process</em>, creates faucet-funded demo
        accounts, wraps the oracle as service #1, runs the buyer agent once, records the
        attestation on-chain, prints both transaction hashes — and exits 0. The data is
        ephemeral: gone when the process exits.
      </P>
      <CodeBlock
        label="what npm run demo prints (abbreviated)"
        code={`══════════════════════════════════════════════════════════════════════════════
  AGENTGATE DEMO — register → 402 → pay → serve → attest → score
══════════════════════════════════════════════════════════════════════════════

stack up: devnet :4030 · oracle :4010 (static fixture) · middleware :4021

seller: 01a1b2c3d4e5f6…   (1000.0 CSPR)
buyer:  01f9e8d7c6b5a4…   (1000.0 CSPR)

wrapped service #1 at http://127.0.0.1:4021/svc/1 (register tx 0123456789ab…)

══════════════════════════════════════════════════════════════════════════════
  DEMO COMPLETE in X.Xs — full loop verified on the mock chain
══════════════════════════════════════════════════════════════════════════════
  payment deploy hash : <full_deploy_hash>
  attestation tx hash : <full_tx_hash>
  amount paid         : 0.5 CSPR
  final score         : 1/1 (success/total)
  service public URL  : http://127.0.0.1:4021/svc/1
  dashboard           : http://localhost:3000/services/1  (start it with \`npm run dev:dashboard\`)
══════════════════════════════════════════════════════════════════════════════`}
      />
      <Callout tone="ok" title="the proof lines">
        The two hashes are the two real on-chain transactions of the loop — the payment deploy
        and the <M>record_attestation</M> call — and <M>1/1</M> is the resulting score. That is
        the entire product in four lines.
      </Callout>

      <H2 id="dev-seed">3 · Bring up the persistent stack, seeded</H2>
      <CommandBlock text="npm run dev:seed" />
      <P>
        Unlike <M>demo</M>, this boots devnet + oracle + middleware and <strong className="text-white">keeps them
        running</strong> until Ctrl+C. The <M>--seed</M> step additionally wraps the oracle at
        0.5 CSPR and runs one paid call, so the dashboard has live data (score 1/1) the moment
        you open it. Plain <M>npm run dev</M> does the same without the seeding.
      </P>
      <CodeBlock
        label="what npm run dev:seed prints (abbreviated)"
        code={`devnet      → http://localhost:4030
oracle      → http://localhost:4010/feed
middleware  → http://localhost:4021

seeding the dashboard (wrap → 402 → pay → serve → attest)…

──────────────────────────────────────────────────────────────────────────────
AgentGate dev stack is up (mock mode) — SEEDED and ready to view.

  service #1   http://localhost:4021/svc/1
  paid call    0.5 CSPR · deploy 0123456789abcdef…
  attestation  0123456789abcdef…
  score        1/1 (success/total)

▶ Open the dashboard:  npm run dev:dashboard   →  http://localhost:3000
  (the stack stays up; the dashboard polls it live every 5s)

Re-run the buyer agent any time to watch the score climb:
  export MOCK_BUYER_ACCOUNT=01a1b2c3d4e5f6…
  export MOCK_SELLER_ACCOUNT=01f9e8d7c6b5a4…
  npm run agent -- --task "Get today's USD/IDR rate and gold price, summarize for a treasury report"

Ctrl+C stops everything.
──────────────────────────────────────────────────────────────────────────────`}
      />

      <H2 id="dashboard">4 · Open the dashboard</H2>
      <P>In a second terminal:</P>
      <CommandBlock text="npm run dev:dashboard" />
      <Callout tone="warn" title="port shift: 3000 → 3001">
        The dashboard is configured for port 3000 (<M>DASHBOARD_PORT</M>), but Next.js silently
        shifts to the next free port if 3000 is taken — e.g. <M>http://localhost:3001</M>.
        Always use the URL printed in the terminal, not a hard-coded 3000.
      </Callout>
      <P>
        The dashboard polls the running stack every 5 seconds: the{' '}
        <DocLink href="/catalog">catalog</DocLink> (ID, name, price, tier, score, active flag),
        the <DocLink href="/activity">activity feed</DocLink> (wraps, payments, attestations)
        and per-service detail pages like <DocLink href="/services/1">/services/1</DocLink>.
      </P>

      <H2 id="manual-loop">5 · Run the loop manually</H2>
      <P>
        With the stack from step 3 still up, you can drive each side of the marketplace by
        hand.
      </P>
      <H3 id="manual-accounts">Create and export demo accounts</H3>
      <CommandBlock text="npm run agentgate -- demo-accounts" />
      <P>
        Prints a faucet-funded buyer and seller (1000 CSPR each) plus ready-to-paste export
        lines:
      </P>
      <CodeBlock
        code={`buyer:  <publicKeyHex>  (1000 CSPR)
seller: <publicKeyHex>  (1000 CSPR)

# paste into your shell (used by the buyer agent and \`agentgate wrap\`):
export MOCK_BUYER_ACCOUNT=<publicKeyHex>
export MOCK_SELLER_ACCOUNT=<publicKeyHex>`}
      />
      <H3 id="manual-wrap">Wrap an API (seller side)</H3>
      <CommandBlock
        wrap
        text='npm run agentgate -- wrap http://localhost:4010/feed --price 0.5 --name "RWA FX & Gold Oracle"'
      />
      <P>
        Registers the service on-chain and maps the upstream on the gateway. Every flag is
        documented in <DocLink href="/docs/sellers#wrap-anatomy">Sellers → Wrap anatomy</DocLink>{' '}
        and <DocLink href="/docs/cli#wrap">CLI → wrap</DocLink>.
      </P>
      <H3 id="manual-agent">Run the buyer agent</H3>
      <CommandBlock
        wrap
        text={'npm run agent -- --task "Get today\'s USD/IDR rate and gold price, summarize for a treasury report"'}
      />
      <P>
        Requires <M>MOCK_BUYER_ACCOUNT</M> and <M>MOCK_SELLER_ACCOUNT</M> exported and the
        devnet/middleware running. Uses Claude if <M>ANTHROPIC_API_KEY</M> is set, otherwise a
        deterministic <M>MockLlm</M>. The six steps it logs — catalog, decision, budget check,
        payment, report, receipt — are described in{' '}
        <DocLink href="/docs/buyers#buyer-agent">Buyers → The buyer agent</DocLink>.
      </P>

      <H2 id="tests">6 · Run the tests</H2>
      <DocTable
        head={['Command', 'What it runs']}
        rows={[
          [
            <M key="c">npm test</M>,
            'vitest: all package unit suites + the end-to-end loop — 243 tests.',
          ],
          [
            <M key="c">cd contracts/agentgate-registry && cargo odra test</M>,
            '17 OdraVM tests against the registry contract.',
          ],
          [
            <M key="c">npm run typecheck</M>,
            'tsc --noEmit in every package + dashboard + root scripts/e2e.',
          ],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/sellers', label: 'Seller guide' },
          { href: '/docs/buyers', label: 'Buyer guide' },
          { href: '/docs/cli', label: 'CLI reference' },
        ]}
      />
    </>
  );
}
