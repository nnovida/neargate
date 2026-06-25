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
  StepFlow,
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Quickstart',
  description:
    'From a clean clone to a verified register → 402 → pay → serve → attest → score loop in about a minute. Run the offline demo, view it live in the dashboard, then drive your first manual wrap by hand. Mock mode — no testnet keys or network required.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="GET STARTED"
        title="Quickstart"
        lede="Go from clone to a working payment loop in about a minute. Everything here runs in mock mode against an in-process devnet — no keys, no network, no chain access required."
      />

      <H2 id="prerequisites">Prerequisites</H2>
      <P>
        The offline path needs nothing but a recent Node.js. There is no API key, no wallet, and
        no network call to a real chain — the demo boots its own in-memory devnet, oracle and
        gateway inside one process.
      </P>
      <DocTable
        head={['Requirement', 'Version', 'Notes']}
        rows={[
          [
            <M key="n">Node.js</M>,
            '≥ 22',
            'Enforced by the root package.json engines field. The monorepo uses npm workspaces, so a single install at the root covers every package plus the dashboard.',
          ],
          [
            'npm',
            'ships with Node 22',
            'No global installs needed — all commands run through npm run scripts.',
          ],
          [
            <M key="k">ANTHROPIC_API_KEY</M>,
            'optional',
            'Not required for any step on this page. Set it only if you want the buyer agent to use Claude instead of the deterministic MockLlm.',
          ],
          [
            'Rust toolchain',
            'optional',
            <span key="d">
              Only needed to build or test the registry contract. The auto-pinned toolchain is
              covered in <DocLink href="/docs/contract">Smart contracts</DocLink>.
            </span>,
          ],
        ]}
      />
      <Callout tone="info" title="Two modes, one code path">
        <M>AGENTGATE_MODE</M> selects the chain backend behind the <M>ChainClient</M> seam:{' '}
        <M>mock</M> (default — the in-process devnet used throughout this page, fully offline) or{' '}
        <M>live</M> (Casper Testnet, which needs PEM keys and a CSPR.cloud API key). Everything
        above the seam is identical. See <DocLink href="/docs/configuration">Configuration</DocLink>.
      </Callout>

      <H2 id="offline-demo">60-second offline demo</H2>
      <P>
        The fastest proof the whole system works end to end. Install once, then run the one-shot
        demo. It exits <M>0</M> after printing both real on-chain transaction hashes.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Install the workspace',
            body: <>One install at the repo root resolves every workspace package and the dashboard.</>,
            code: 'npm install',
          },
          {
            title: 'Run the loop',
            body: (
              <>
                Boots devnet + oracle (static fixture) + middleware <em>in-process</em>, creates
                faucet-funded buyer and seller accounts, wraps the oracle as service #1 at 0.5
                CSPR, runs the buyer agent once with the deterministic <M>MockLlm</M>, records the
                attestation on-chain, prints both tx hashes and exits 0.
              </>
            ),
            code: 'npm run demo',
          },
        ]}
      />
      <P>The full loop — register, 402, pay, serve, attest, score — prints like this:</P>
      <CodeBlock
        label="npm run demo (abbreviated)"
        code={"════════════════════════════════════════════════════════════════════════\n  AGENTGATE DEMO — register → 402 → pay → serve → attest → score\n════════════════════════════════════════════════════════════════════════\n\nstack up: devnet :4030 · oracle :4010 (static fixture) · middleware :4021\n\nseller: 01a1b2c3d4e5f6… (1000.0 CSPR)\nbuyer:  01f9e8d7c6b5a4… (1000.0 CSPR)\n\nwrapped service #1 at http://127.0.0.1:4021/svc/1 (register tx 0123456789ab…)\n\n════════════════════════════════════════════════════════════════════════\n  DEMO COMPLETE in 1.2s — full loop verified on the mock chain\n════════════════════════════════════════════════════════════════════════\n  payment deploy hash : <full_payment_deploy_hash>\n  attestation tx hash : <full_attestation_tx_hash>\n  amount paid         : 0.5 CSPR\n  final score         : 1/1 (success/total)\n  service public URL  : http://127.0.0.1:4021/svc/1\n  dashboard           : http://localhost:3000/services/1  (start it with `npm run dev:dashboard`)\n════════════════════════════════════════════════════════════════════════"}
      />
      <Callout tone="ok" title="The proof is in two hashes">
        The <strong className="text-white">payment deploy hash</strong> and the{' '}
        <strong className="text-white">attestation tx hash</strong> are the two real on-chain
        transactions of the loop — the buyer&apos;s native CSPR transfer and the gateway&apos;s{' '}
        <M>record_attestation</M> call. <M>1/1 (success/total)</M> is the trust score that results.
        That is the entire product in four lines, and the script exits 0.
      </Callout>
      <Callout tone="warn" title="The demo is ephemeral">
        <M>npm run demo</M> boots its own in-memory chain, runs the loop and exits — its data is
        gone by the time you could open a browser, so it will <em>not</em> appear in the dashboard.
        To view a live, populated stack use <M>npm run dev:seed</M> below instead.
      </Callout>

      <H2 id="dashboard">See it live in the dashboard</H2>
      <P>
        Where <M>demo</M> is a one-shot, <M>dev:seed</M> brings up the same stack and{' '}
        <strong className="text-white">keeps it running</strong> until Ctrl+C, pre-populated with
        one wrapped service and one real paid call so the dashboard shows live data the instant you
        open it. Use two terminals.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Terminal 1 — boot and seed the stack',
            body: (
              <>
                Boots devnet + oracle + middleware, then wraps the oracle at 0.5 CSPR and runs one
                paid call (score 1/1). The stack stays up. Plain <M>npm run dev</M> does the same
                without the seeding step.
              </>
            ),
            code: 'npm run dev:seed',
          },
          {
            title: 'Terminal 2 — start the dashboard',
            body: <>Launches the Next.js dashboard against the running stack.</>,
            code: 'npm run dev:dashboard',
          },
          {
            title: 'Open the URL it prints',
            body: (
              <>
                The default is <M>http://localhost:3000</M>. Use the URL the terminal actually
                prints (see the port note below).
              </>
            ),
          },
        ]}
      />
      <P>Terminal 1 prints a ready-to-view summary once seeding completes:</P>
      <CodeBlock
        label="npm run dev:seed (abbreviated)"
        code={"devnet      → http://localhost:4030\noracle      → http://localhost:4010/feed\nmiddleware  → http://localhost:4021\n\nseeding the dashboard (wrap → 402 → pay → serve → attest)…\n\n────────────────────────────────────────────────────────────────────────\nAgentGate dev stack is up (mock mode) — SEEDED and ready to view.\n\n  service #1   http://localhost:4021/svc/1\n  paid call    0.5 CSPR · deploy 0123456789abcdef…\n  attestation  0123456789abcdef…\n  score        1/1 (success/total)\n\n▶ Open the dashboard:  npm run dev:dashboard   →  http://localhost:3000\n  (the stack stays up; the dashboard polls it live every 5s)\n\nCtrl+C stops everything.\n────────────────────────────────────────────────────────────────────────"}
      />
      <Callout tone="warn" title="Port note: 3000 may shift to 3001">
        The dashboard targets port 3000 (<M>DASHBOARD_PORT</M>), but if 3000 is already taken
        Next.js silently moves to the next free port — typically <M>http://localhost:3001</M>.
        Always open the URL printed in the <M>dev:dashboard</M> terminal rather than hard-coding
        3000.
      </Callout>
      <P>
        Once open, the dashboard polls the running stack every 5 seconds: the{' '}
        <DocLink href="/catalog">catalog</DocLink> (ID, name, price, trust tier, score, active
        flag), the <DocLink href="/activity">activity feed</DocLink> (registrations, payments,
        attestations) and per-service detail pages such as{' '}
        <DocLink href="/services/1">/services/1</DocLink>.
      </P>

      <H2 id="manual-wrap">Your first manual wrap</H2>
      <P>
        Now drive each side of the marketplace by hand. Start an <em>empty</em> stack (no seeding),
        export the demo accounts it prints, wrap an API as a seller, then run the buyer agent
        against it.
      </P>
      <H3 id="manual-stack">Start an empty stack and export accounts</H3>
      <CommandBlock text="npm run dev" />
      <P>
        This boots devnet, oracle and middleware and stays up, then prints two ready-to-paste
        export lines for a faucet-funded buyer and seller (1000 CSPR each). Paste them into the
        shell you will run the next commands from:
      </P>
      <CodeBlock
        code={"export MOCK_BUYER_ACCOUNT=<buyerPublicKeyHex>\nexport MOCK_SELLER_ACCOUNT=<sellerPublicKeyHex>"}
      />
      <Callout tone="info" title="Where the accounts come from">
        <M>npm run dev</M> seeds the devnet faucet and prints the exports for you. You can also
        mint a fresh pair any time with <M>npm run agentgate -- demo-accounts</M>. Both the buyer
        agent and <M>agentgate wrap</M> read these env vars to find their mock signer.
      </Callout>
      <H3 id="manual-wrap-cmd">Wrap an API (seller side)</H3>
      <CommandBlock
        wrap
        text={'npm run agentgate -- wrap http://localhost:4010/feed --price 0.5 --name "RWA FX & Gold Oracle"'}
      />
      <P>
        This registers the service on-chain (name, gateway URL, price in motes, payment target,
        attestor) <em>and</em> maps the upstream URL on the gateway over the authenticated admin
        API. On success it prints the service id, the public <M>/svc/&lt;id&gt;</M> endpoint, a
        dashboard link and the register tx hash. Every flag is documented in{' '}
        <DocLink href="/docs/sellers">Wrap an API</DocLink> and{' '}
        <DocLink href="/docs/cli">CLI → wrap</DocLink>.
      </P>
      <H3 id="manual-agent">Run the buyer agent (buyer side)</H3>
      <CommandBlock
        wrap
        text={'npm run agent -- --task "Get today\'s USD/IDR rate and gold price, summarize for a treasury report"'}
      />
      <P>
        The agent discovers the catalog from the chain, picks a service, runs a budget check, hits{' '}
        <M>/svc/&lt;id&gt;</M> to get the 402 invoice, pays with a native CSPR transfer carrying
        the nonce, retries with the payment proof, consumes the data and writes its receipt. It
        requires <M>MOCK_BUYER_ACCOUNT</M> exported (and the stack running). Add{' '}
        <M>--budget &lt;cspr&gt;</M> to cap spend. With no <M>ANTHROPIC_API_KEY</M> set it uses the
        deterministic <M>MockLlm</M>; set the key to let it use Claude instead. See{' '}
        <DocLink href="/docs/buyers">Build an agent</DocLink>.
      </P>
      <Callout tone="ok" title="Watch the score climb">
        Re-run the buyer agent and refresh the dashboard — each successful paid call adds an
        attestation and bumps the service score (2/2, 3/3, …), which feeds its trust tier.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/installation', label: 'Installation' },
          { href: '/docs/sellers', label: 'Wrap an API' },
        ]}
      />
    </>
  );
}
