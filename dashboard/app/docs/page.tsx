import type { Metadata } from 'next';
import {
  CardGrid,
  Callout,
  DocHeader,
  DocLink,
  DocTable,
  H2,
  M,
  NextLinks,
  P,
  StepFlow,
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Docs — Overview',
  description:
    'What AgentGate is, how the 402 payment loop works, and where to go next: quickstart, seller and buyer guides, protocol, API, CLI, contract and configuration reference.',
};

export default function DocsOverviewPage() {
  return (
    <>
      <DocHeader
        kicker="documentation"
        title="AgentGate Docs"
        lede="Everything you need to wrap an API behind a 402 paywall, pay for one as an agent, and read what AgentGate writes on-chain — from the five-minute quickstart to the full protocol and contract reference."
      />

      <H2 id="what-is-agentgate">What is AgentGate?</H2>
      <P>
        AgentGate is Stripe for AI agents on Casper: it wraps any HTTP API into a pay-per-call
        service behind an HTTP <M>402 Payment Required</M> paywall, registered and scored
        on-chain. Sellers run one command to publish a service with a price; buying agents
        discover it in the on-chain catalog, pay per call in native CSPR, and get the response —
        no cards, no KYC, no API keys.
      </P>
      <P>
        Payment is a native CSPR transfer that carries the invoice nonce as its{' '}
        <M>transfer_id</M> (the “Plan B” settlement scheme). The gateway verifies that transfer
        on-chain — against the in-memory devnet in mock mode, or via CSPR.cloud on Casper
        Testnet in live mode — then proxies the request to the seller&apos;s upstream API and
        records a reputation attestation back on-chain.
      </P>

      <H2 id="the-problem">The problem: agents can&apos;t pay APIs</H2>
      <P>
        Every useful API today is gated by a human-shaped funnel: sign up with an email, add a
        credit card, pass KYC, copy an API key into a config file. An autonomous agent can do
        none of that mid-task. It can, however, hold a wallet and make an HTTP request — so
        AgentGate turns “Payment Required” into a machine-readable invoice the agent can settle
        on-chain in seconds, with cryptographic proof instead of credentials.
      </P>

      <H2 id="how-it-works">How it works — the six-step loop</H2>
      <P>
        Every paid call runs the same loop: <M>register → 402 → pay → serve → attest → score</M>.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Register',
            body: (
              <>
                The seller runs <M>agentgate wrap</M> once. The service — name, price in motes,
                payment target, attestor — is written to the on-chain registry, and the upstream
                URL is mapped privately on the gateway. See{' '}
                <DocLink href="/docs/sellers">Sellers</DocLink>.
              </>
            ),
            code: 'npx agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"',
          },
          {
            title: '402 challenge',
            body: (
              <>
                A buying agent calls the public endpoint <M>/svc/:id</M> with no proof attached.
                The gateway answers <M>402</M> with a fresh <M>Invoice402</M>: price, payment
                target and a single-use nonce. See{' '}
                <DocLink href="/docs/protocol">Protocol</DocLink>.
              </>
            ),
            code: 'GET /svc/1 → 402 { priceMotes, paymentTarget, nonce, expiresAt }',
          },
          {
            title: 'Pay',
            body: (
              <>
                The agent sends a native CSPR transfer to the payment target with{' '}
                <M>transfer_id = nonce</M>. This is the first of the two on-chain transactions
                in the loop.
              </>
            ),
            code: 'transfer { to: paymentTarget, amountMotes: priceMotes, transferId: nonce }',
          },
          {
            title: 'Serve',
            body: (
              <>
                The agent retries the same request with <M>X-Payment-Deploy-Hash</M> and{' '}
                <M>X-Payment-Nonce</M> headers. The gateway verifies the transfer on-chain
                (target, amount, transfer_id, age), burns the nonce atomically, and proxies the
                request to the upstream API.
              </>
            ),
            code: 'GET /svc/1 + proof headers → 200 OK (upstream response)',
          },
          {
            title: 'Attest',
            body: (
              <>
                After responding, the gateway asynchronously records an attestation on-chain:
                the payment deploy hash plus a success flag. This is the second on-chain
                transaction of the loop.
              </>
            ),
            code: 'record_attestation(serviceId, paymentDeployHash, success)',
          },
          {
            title: 'Score',
            body: (
              <>
                The registry bumps the service&apos;s <M>totalCalls</M>/<M>successCalls</M>{' '}
                counters and the trust tier (<M>new</M> → <M>reliable</M> → <M>trusted</M>)
                recomputes. Buyers read it from the{' '}
                <DocLink href="/catalog">catalog</DocLink> on the next discovery pass.
              </>
            ),
            code: 'score 1/1 · tier recomputed from successCalls/totalCalls',
          },
        ]}
      />

      <H2 id="two-sided">A two-sided marketplace</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/sellers',
            title: 'Sellers',
            desc: 'Wrap an upstream API in one command, set a per-call price in CSPR, and collect payments straight to your account — the gateway never holds your funds.',
          },
          {
            href: '/docs/buyers',
            title: 'Buyers',
            desc: 'Agents discover services on-chain, pay per call with a native CSPR transfer, and retry with proof. Via the buyer agent, the client SDK, or plain curl.',
          },
        ]}
      />

      <H2 id="on-chain">What&apos;s real on-chain</H2>
      <P>
        Per paid call, exactly <strong className="text-white">two transactions</strong> land on
        the chain:
      </P>
      <DocTable
        head={['TX', 'What it is', 'Proof']}
        rows={[
          [
            <M key="t1">1 · payment</M>,
            'Native CSPR transfer from the buyer to the service’s paymentTarget, carrying transfer_id = invoice nonce.',
            'payment deploy hash',
          ],
          [
            <M key="t2">2 · attestation</M>,
            'record_attestation call by the gateway: payment deploy hash + success flag, bumping the service score.',
            'attestation tx hash',
          ],
        ]}
      />
      <P>
        Registration itself (<M>register_service</M>) is a one-time third transaction at wrap
        time. <M>npm run demo</M> prints both loop hashes plus the final <M>1/1</M> score as its
        proof lines — see <DocLink href="/docs/quickstart">Quickstart</DocLink>.
      </P>

      <H2 id="architecture">Architecture at a glance</H2>
      <DocTable
        head={['Package', 'Role', 'Port']}
        rows={[
          [<M key="p">packages/shared</M>, 'Types · config · bigint money · trust tiers (zero runtime deps)', '—'],
          [<M key="p">packages/devnet</M>, 'In-memory mock chain HTTP server', <M key="v">:4030</M>],
          [<M key="p">packages/chain</M>, 'ChainClient seam: MockChainHttpClient + LiveCasperClient', '—'],
          [<M key="p">packages/middleware</M>, 'The product core — 402 paywall reverse proxy + admin API', <M key="v">:4021</M>],
          [<M key="p">packages/client</M>, 'Agent-side fetchPaid (parse 402 → pay → retry)', '—'],
          [<M key="p">packages/oracle</M>, 'Demo RWA feed: USD/IDR + gold spot + confidence', <M key="v">:4010</M>],
          [<M key="p">packages/buyer-agent</M>, 'LLM decision loop (AnthropicLlm / MockLlm)', '—'],
          [<M key="p">packages/cli</M>, 'agentgate wrap | list | status | demo-accounts', '—'],
          [<M key="p">dashboard/</M>, 'Next.js 14 landing + catalog + live activity', <M key="v">:3000</M>],
          [<M key="p">contracts/</M>, 'AgentGateRegistry (Rust/Odra) — registry, scores, attestations', '—'],
        ]}
      />

      <H2 id="modes">Mock vs live mode</H2>
      <P>
        One env var — <M>AGENTGATE_MODE</M> (default <M>mock</M>) — selects the chain backend.
        Both modes share identical code above the <M>ChainClient</M> seam.
      </P>
      <DocTable
        head={['Concern', 'Mock (default)', 'Live (Casper Testnet)']}
        rows={[
          [
            'Chain backend',
            <span key="m">
              <M>@agentgate/devnet</M> in-memory REST server at <M>:4030</M>
            </span>,
            'casper-js-sdk v5 + node RPC + CSPR.cloud REST',
          ],
          [
            'Registry',
            'Devnet in-memory state mirroring the Odra contract rules exactly',
            <span key="l">
              Deployed AgentGateRegistry contract (requires <M>REGISTRY_CONTRACT_PACKAGE_HASH</M>)
            </span>,
          ],
          [
            'Payment verification',
            <M key="m">GET /chain/transfers/:deployHash</M>,
            <span key="l">
              CSPR.cloud <M>GET /transfers?deploy_hash=…</M>
            </span>,
          ],
          [
            'Signers',
            <span key="m">
              <M>{"{ kind: 'mock', publicKey }"}</M>
            </span>,
            <span key="l">
              <M>{"{ kind: 'pem', pemPath }"}</M> (ed25519 or secp256k1)
            </span>,
          ],
          [
            'Account hash',
            <span key="m">
              <M>account-hash-</M> + sha256(publicKey) hex
            </span>,
            'Native Casper account-hash',
          ],
          ['Settle delay', '0 ms (synchronous devnet)', '~3000 ms default'],
          [
            'Admin token',
            <span key="m">
              Default <M>dev-admin-token</M> allowed
            </span>,
            'Default token refused — a strong unique token is required',
          ],
          ['SSRF guard on upstreams', 'Off (local demos OK)', 'On (private/loopback hosts rejected)'],
        ]}
      />
      <Callout tone="info" title="contract deploy status">
        Live mode reads and contract writes are gated behind <M>NOT_DEPLOYED</M> until the
        registry contract is deployed and <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> is set — see{' '}
        <DocLink href="/docs/contract#deploy-status">Contract → Deploy status</DocLink>.
      </Callout>

      <H2 id="explore">Explore the docs</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/quickstart',
            title: 'Quickstart',
            desc: 'Clone, install, run the one-shot demo, then bring the stack up with seeded data and open the dashboard.',
          },
          {
            href: '/docs/protocol',
            title: 'AgentGate-402 protocol',
            desc: 'Invoice402 fields, proof headers, the four verification checks, single-use nonce burning and the full error-code table.',
          },
          {
            href: '/docs/api',
            title: 'HTTP API reference',
            desc: 'Every surface: middleware paywall + admin, oracle feed, mock devnet routes and the dashboard /api endpoints.',
          },
          {
            href: '/docs/cli',
            title: 'CLI reference',
            desc: 'agentgate wrap, list, status and demo-accounts — flags, env, output and exit codes.',
          },
          {
            href: '/docs/contract',
            title: 'Smart contract',
            desc: 'AgentGateRegistry entrypoints, events, error codes, storage layout, build/test commands and deploy status.',
          },
          {
            href: '/docs/configuration',
            title: 'Configuration',
            desc: 'Every environment variable, the mock/live guardrails and the ports table.',
          },
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/quickstart', label: 'Quickstart' },
          { href: '/catalog', label: 'Browse the catalog' },
          { href: '/activity', label: 'Live activity' },
        ]}
      />
    </>
  );
}
