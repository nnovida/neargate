import type { Metadata } from 'next';
import {
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_ACCOUNT_ID,
  DEFAULT_GATEWAY_URL,
  DEFAULT_REGISTRY_CONTRACT_ID,
} from '@agentgate/shared';
import { CommandBlock } from '@/components/copy';
import { CLI_INSTALL } from '@/lib/cli';
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
  alternates: { canonical: '/docs/quickstart' },
  title: 'Quickstart',
  description:
    'Try the live NearGate deployment on NEAR testnet, then go from a clean clone to a verified register → 402 → pay → serve → attest → score loop in about a minute, offline on the mock chain; view it in the dashboard, drive a wrap and a buy by hand, and run the NEAR testnet scripts.',
};

/** The hosted deployment exists only when the shared defaults name it. */
const HOSTED = DEFAULT_GATEWAY_URL !== '' && DEFAULT_REGISTRY_CONTRACT_ID !== '';

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="GET STARTED"
        title="Quickstart"
        lede="Try the live deployment on NEAR testnet, or go from a clone to a working payment loop in about a minute. Everything from the offline demo up to the testnet section runs in mock mode against an in-process devnet — no keys and no NEAR account needed."
      />

      {HOSTED ? (
        <>
          <H2 id="live">Try the live deployment</H2>
          <P>
            NearGate runs on NEAR testnet: the registry <M>{DEFAULT_REGISTRY_CONTRACT_ID}</M>, the
            gateway at <M>{DEFAULT_GATEWAY_URL}</M>
            {DEFAULT_DASHBOARD_URL !== '' ? (
              <>
                {' '}and this dashboard at <M>{DEFAULT_DASHBOARD_URL}</M>
              </>
            ) : null}
            , with gasless relaying on. Service #1, <em>USD exchange rates</em> at 0.01 NEAR, is
            live: see it in the <DocLink href="/catalog">catalog</DocLink> or on{' '}
            <DocLink href="/services/1">/services/1</DocLink>. Its unpaid call answers the x402
            invoice, with no install:
          </P>
          <CommandBlock wrap text={`curl -i ${DEFAULT_GATEWAY_URL}/svc/1`} />
          <P>
            The CLI is on npm and targets this deployment by default; <M>list</M> and{' '}
            <M>status</M> need no key. Install it once, then run it from any folder:
          </P>
          <CommandBlock text={CLI_INSTALL} />
          <CommandBlock text="neargate list" />
          <CommandBlock text="neargate status 1" />
          <P>
            Without installing, <M>npx -y @neargate/cli status 1</M> runs the same command. In a
            clone of the repository, run it from the repository root as{' '}
            <M>npm run neargate -- status 1</M>: that script exists only there, so in any other
            folder npm answers <M>Missing script: &quot;neargate&quot;</M>.
          </P>
          <P>
            To buy a call you need a funded testnet account whose key is in{' '}
            <M>~/.near-credentials/testnet/</M>; the near CLI’s faucet sponsor creates one:
          </P>
          <CommandBlock
            wrap
            text="near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet create"
          />
          <CommandBlock wrap text="neargate buy 1 --max 0.02 --account <you>.testnet" />
          <P>
            It pays 0.01 NEAR + 0.002 NEAR storage to the registry, prints the rates on stdout and a
            receipt with the explorer link on stderr; the gateway then attests the call and the
            score on <DocLink href="/services/1">/services/1</DocLink> grows. To put your own API
            behind this gateway, <DocLink href="/docs/cli#wrap">wrap</DocLink> it with{' '}
            <M>--attestor {DEFAULT_GATEWAY_ACCOUNT_ID || '<gateway account>'}</M> so the
            gateway’s attestations count.
          </P>
        </>
      ) : null}

      <H2 id="prerequisites">Prerequisites</H2>
      <P>
        The offline path needs a recent Node.js and nothing else: the demo boots its own in-memory
        devnet, sample oracle and gateway inside one process.
      </P>
      <DocTable
        head={['Requirement', 'Version', 'Notes']}
        rows={[
          [
            <M key="n">Node.js</M>,
            '≥ 22.22.2',
            'Declared in the root package.json engines field. The repository is an npm workspace, so one npm install at the root covers every package and the dashboard.',
          ],
          [
            <M key="k">ANTHROPIC_API_KEY</M>,
            'optional',
            'Not needed for any step before the testnet section. Set it only if you want the buyer agent to use Claude instead of the deterministic MockLlm.',
          ],
          [
            'near CLI, cargo-near',
            'testnet scripts only',
            <span key="d">
              <M>npm run near:bootstrap</M> uses the <M>near</M> CLI to create accounts;{' '}
              <M>npm run near:deploy</M> also builds the contract with <M>cargo near</M>. See{' '}
              <DocLink href="#testnet">Testnet scripts</DocLink>.
            </span>,
          ],
        ]}
      />
      <Callout tone="info" title="Two modes, one code path">
        <M>AGENTGATE_MODE</M> selects the chain backend: <M>mock</M> (the in-process devnet, no
        NEAR at all; the local stack and the demo use it) or <M>live</M> (NEAR testnet; the hosted
        gateway and dashboard use it). The <M>neargate</M> CLI defaults to <M>live</M>, so the
        manual CLI commands below pass <M>--mode mock</M>.
        Everything above the chain seam is identical. See{' '}
        <DocLink href="/docs#modes">Mock vs live modes</DocLink>.
      </Callout>

      <H2 id="offline-demo">60-second offline demo</H2>
      <P>
        The fastest proof the whole system works end to end. Install once, then run the one-shot
        demo. It exits <M>0</M> after printing the loop’s two transaction hashes — the payment and
        the attestation — recorded on the in-process mock chain.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Install the workspace',
            body: <>From the repository root, one install resolves every package and the dashboard.</>,
            code: 'npm install',
          },
          {
            title: 'Run the loop',
            body: (
              <>
                Boots devnet + oracle (static fixture) + gateway <em>in-process</em>, creates
                faucet-funded buyer and seller accounts, wraps the oracle as service #1 at 0.5
                NEAR, buys one call exactly like <M>neargate buy</M> does, lets the gateway record
                the attestation and prints six lines.
              </>
            ),
            code: 'npm run demo',
          },
        ]}
      />
      <CodeBlock
        label="npm run demo"
        code={[
          'registered service #1',
          '402 invoice: 0.5 NEAR + 0.002 NEAR storage',
          'paid: tx <payment tx hash>',
          'served: 200',
          'attested: tx <attestation tx hash>',
          'score: 1/1 (new)',
        ].join('\n')}
      />
      <Callout tone="ok" title="The proof is in two hashes">
        The <strong className="text-white">payment</strong> and the{' '}
        <strong className="text-white">attestation</strong> are the loop’s two transactions: the
        buyer’s registry <M>pay</M> call and the gateway’s <M>record_attestation</M> call.{' '}
        <M>1/1</M> is the score that results (success/total); the tier stays <M>new</M> until a
        service has at least five attested calls.
      </Callout>
      <Callout tone="warn" title="The demo is ephemeral">
        <M>npm run demo</M> boots its own in-memory chain, runs the loop and exits — its data is
        gone before you could open a browser, so it will <em>not</em> appear in the dashboard. To
        view a populated, running stack use <M>npm run dev:seed</M> below.
      </Callout>

      <H2 id="dashboard">See it live in the dashboard</H2>
      <P>
        Where <M>demo</M> is a one-shot, <M>dev:seed</M> brings up the same stack and{' '}
        <strong className="text-white">keeps it running</strong> until Ctrl+C, pre-populated with
        one wrapped service and one real paid call, so the dashboard shows data the moment you open
        it. Use two terminals.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Terminal 1 — boot and seed the stack',
            body: (
              <>
                Boots devnet + oracle + gateway, then wraps the oracle at 0.5 NEAR and runs one
                paid call (score 1/1). Plain <M>npm run dev</M> does the same without the seeding
                step. Unlike the demo, this oracle fetches live FX and gold rates when it can reach
                its public sources and falls back to its fixed sample when offline (
                <M>ORACLE_STATIC=1</M> always serves the sample).
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
                Usually <M>http://localhost:3000</M>. If that port is taken Next.js moves to the
                next free one and prints it — open the URL terminal 2 shows (Next.js does not read{' '}
                <M>DASHBOARD_PORT</M>).
              </>
            ),
          },
        ]}
      />
      <P>Terminal 1 ends with a summary like this:</P>
      <CodeBlock
        label="npm run dev:seed (abbreviated)"
        code={[
          'NearGate dev stack is up (mock mode) — SEEDED and ready to view.',
          '',
          '  service #1   http://localhost:4021/svc/1',
          '  paid call    0.502 NEAR spent (price + storage) · tx <payment tx hash>…',
          '  attestation  <attestation tx hash>…',
          '  score        1/1 (success/total)',
          '',
          '▶ Open the dashboard:  npm run dev:dashboard   →  http://localhost:3000',
        ].join('\n')}
      />
      <P>
        The dashboard polls the running stack: the <DocLink href="/catalog">catalog</DocLink> (id,
        name, price in NEAR, trust tier, score, active flag), the{' '}
        <DocLink href="/activity">activity feed</DocLink> (registrations, payments, attestations)
        and per-service pages such as <DocLink href="/services/1">/services/1</DocLink>. On the
        mock chain transaction hashes are plain text; against NEAR testnet they link to nearblocks.
      </P>

      <H2 id="manual-wrap">Your first manual wrap and buy</H2>
      <P>
        Stop the seeded stack (Ctrl+C) first — both stacks bind the same ports — then start an{' '}
        <em>empty</em> one, export the demo accounts it prints, wrap an API as a seller, and buy a
        call as a buyer.
      </P>
      <H3 id="manual-stack">Start an empty stack and export accounts</H3>
      <CommandBlock text="npm run dev" />
      <P>
        This boots devnet, oracle and gateway and stays up, then prints two ready-to-paste export
        lines for a faucet-funded buyer and seller (1000 NEAR each). Paste them into the shell you
        run the next commands from:
      </P>
      <CodeBlock
        code={'export MOCK_BUYER_ACCOUNT=buyer-<8 hex>.mock\nexport MOCK_SELLER_ACCOUNT=seller-<8 hex>.mock'}
      />
      <P>
        You can mint a fresh pair any time with{' '}
        <M>npm run neargate -- demo-accounts --mode mock</M>.
      </P>
      <H3 id="manual-wrap-cmd">Wrap an API (seller side)</H3>
      <CommandBlock
        wrap
        text={'npm run neargate -- wrap http://localhost:4010/feed --price 0.5 --name "RWA FX & Gold Oracle" --mode mock'}
      />
      <P>
        This registers the service on-chain and maps the upstream on the gateway (in mock mode with
        the admin token). It prints the service id, the public <M>/svc/&lt;id&gt;</M> endpoint, a
        dashboard link and the register tx hash. Every flag is in{' '}
        <DocLink href="/docs/cli#wrap">CLI → wrap</DocLink>.
      </P>
      <H3 id="manual-buy">Buy a call (buyer side)</H3>
      <CommandBlock wrap text="npm run neargate -- buy 1 --max 1 --mode mock" />
      <P>
        Pays the service’s 402 invoice with a registry <M>pay</M> call — price plus the{' '}
        <M>0.002 NEAR</M> storage fee, capped at <M>--max 1</M> NEAR in total — and prints the
        response body on stdout and a receipt on stderr. Or let the buyer agent choose a service
        itself:
      </P>
      <CommandBlock
        wrap
        text={'npm run agent -- --task "Get today\'s USD/IDR rate and gold price, summarize for a treasury report" --budget 1'}
      />
      <P>
        With no <M>ANTHROPIC_API_KEY</M> the agent uses the deterministic <M>MockLlm</M>; with one
        it asks Claude to choose, but the budget check and the payment are the same code either way.
      </P>
      <Callout tone="ok" title="Watch the score climb">
        Buy again with a different buyer and refresh the dashboard — each served call adds an
        attestation and bumps the score (2/2, 3/3, …). A payment made by the service’s own owner or
        payment target is served but never attested, so it cannot raise the score.
      </Callout>

      <H2 id="testnet">Testnet scripts</H2>
      <P>
        These root scripts take the same loop to NEAR testnet: the operator path, the one that set up
        the hosted deployment. Run them from a clone (they are not part of the npm packages). The TypeScript
        scripts (<M>dev:live</M>, <M>near:seed</M>, <M>smoke:live</M>) read the root <M>.env</M>.
        Copy <M>.env.example</M>, then change what it ships for mock mode:
      </P>
      <CodeBlock
        label=".env (live)"
        code={[
          'AGENTGATE_MODE=live',
          '# empty = the deployed default registry; set it to the one near:deploy printed',
          'REGISTRY_CONTRACT_ID=<prefix>-registry.testnet',
          'GATEWAY_ACCOUNT_ID=<prefix>-gateway.testnet',
          'SELLER_ACCOUNT_ID=<prefix>-seller.testnet',
          'BUYER_ACCOUNT_ID=<prefix>-buyer.testnet',
          '# a long random token: live mode refuses dev-admin-token',
          'AGENTGATE_ADMIN_TOKEN=<random>',
          '# near:seed: the public https URL of the gateway (stored on-chain for good)',
          'GATEWAY_PUBLIC_URL=https://<gateway host>',
        ].join('\n')}
      />
      <P>
        The two shell scripts (<M>near:bootstrap</M>, <M>near:deploy</M>) do not read{' '}
        <M>.env</M>: set <M>NEARGATE_PREFIX</M>, <M>FORCE_REDEPLOY</M> and <M>DRY_RUN</M> in the
        shell. The prefix defaults to <M>neargate-&lt;MMDD&gt;</M>, today’s date, so set it if you
        run them on different days.
      </P>
      <DocTable
        head={['Script', 'What it does']}
        rows={[
          [
            <M key="b">npm run near:bootstrap</M>,
            <span key="bd">
              Creates the four accounts <M>&lt;prefix&gt;-registry.testnet</M>,{' '}
              <M>-seller</M>, <M>-gateway</M> and <M>-buyer</M> through the near CLI faucet sponsor,
              each with a fresh key saved to <M>~/.near-credentials/testnet/</M>. Idempotent: an
              existing account is skipped. <M>NEARGATE_PREFIX</M> sets the prefix.
            </span>,
          ],
          [
            <M key="d">npm run near:deploy</M>,
            <span key="dd">
              Builds <M>neargate-registry</M> with <M>cargo near</M>, deploys it onto the registry
              account with <M>new</M> (no arguments, no admin) and reads <M>services_count</M> back.
              The account must hold at least 3 NEAR first (<M>MIN_REGISTRY_BALANCE_NEAR</M>). It
              refuses an account that already holds a contract unless <M>FORCE_REDEPLOY=1</M>, which
              upgrades the code only: it skips <M>new</M> and keeps the existing state.
            </span>,
          ],
          [
            <M key="l">npm run dev:live</M>,
            <span key="ld">
              Starts the gateway in live mode against the deployed registry; it prints the registry,
              the attestor account and the next steps. It needs the live <M>.env</M> above and the
              gateway account’s key (<M>GATEWAY_PRIVATE_KEY</M>, <M>GATEWAY_KEY_PATH</M> or{' '}
              <M>~/.near-credentials</M>).
            </span>,
          ],
          [
            <M key="s">npm run near:seed</M>,
            <span key="sd">
              One real register → pay → attest triple: the seller wraps a public upstream at 0.01
              NEAR, the buyer buys one call, then the script polls the gateway’s{' '}
              <DocLink href="/docs/protocol#receipts">receipt</DocLink> until the attestation is
              recorded. It needs a running gateway reachable at <M>GATEWAY_PUBLIC_URL</M>, because
              the registry stores that URL for good, and registers <M>GATEWAY_ACCOUNT_ID</M> as the
              service’s attestor, so that must be the account the gateway at that URL signs with.
              Each run registers a new service.
            </span>,
          ],
          [
            <M key="m">npm run smoke:live</M>,
            <span key="md">
              A read-only check of the live deployment: lists the services, shows one (
              <M>SMOKE_SERVICE_ID</M>, default 1), and requests an unpaid invoice from its gateway,
              which must answer a valid 402. Nothing is paid or signed. It needs only{' '}
              <M>AGENTGATE_MODE=live</M>.
            </span>,
          ],
        ]}
      />
      <Callout tone="info" title="DRY_RUN=1">
        <M>near:bootstrap</M> and <M>near:deploy</M> accept <M>DRY_RUN=1</M>: they print every
        command instead of running it, send nothing and never contact the network. Use it to see
        exactly what a run would do.
      </Callout>
      <CodeBlock label="see what a bootstrap would do" code="DRY_RUN=1 npm run near:bootstrap" />

      <NextLinks
        links={[
          { href: '/docs/cli', label: 'CLI & MCP' },
          { href: '/docs/protocol', label: 'How it works' },
        ]}
      />
    </>
  );
}
