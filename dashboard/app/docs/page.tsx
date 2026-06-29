import type { Metadata } from 'next';
import {
  CardGrid,
  Callout,
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
  title: 'Overview',
  description:
    'What AgentGate is, the HTTP 402 + Casper mental model, the seller / buyer / operator roles, mock vs live modes, and a map of the full documentation.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="OVERVIEW"
        title="AgentGate Docs"
        lede="Stripe for AI agents on Casper. Wrap any HTTP API behind an HTTP 402 paywall, register and score it on-chain, and let buying agents pay per call in native CSPR — no accounts, no API keys, no subscriptions."
      />

      <H2 id="what-is-agentgate">What AgentGate is</H2>
      <P>
        AgentGate is an x402-style payment gateway for machine-to-machine APIs. A seller puts any
        HTTP endpoint behind a <M>402 Payment Required</M> paywall and registers it in an on-chain
        Casper registry. A buying agent discovers that service, receives a machine-readable invoice,
        settles it on-chain, then retries with cryptographic proof of payment — and the gateway
        records an on-chain attestation that feeds the service&apos;s trust score. The whole loop is{' '}
        <M>register → 402 → pay → serve → attest → score</M>.
      </P>
      <P>
        Nothing about it is human-shaped. There is no signup form, no credit card, no KYC, and no API
        key to copy into a config file. The only credentials an agent needs are a Casper wallet and
        the ability to make an HTTP request — which is exactly what an autonomous agent already has.
      </P>

      <H3 id="mental-model">The mental model: HTTP 402 + Casper</H3>
      <P>
        HTTP reserved the status code <M>402 Payment Required</M> for decades without a standard way
        to use it. AgentGate gives it a concrete meaning. When an agent calls a paid endpoint with no
        proof, the gateway answers <M>402</M> with a <M>PaymentRequiredResponse</M> (x402 V1) — a
        JSON body with <M>x402Version:1</M>, a human-readable <M>error</M>, and an{' '}
        <M>accepts[]</M> array carrying <M>maxAmountRequired</M>, the <M>payTo</M> account, a
        single-use <M>extra.nonce</M>, and an <M>extra.expiresAtMs</M> timestamp. The agent reads
        the challenge, sends a{' '}
        <strong className="text-white">native CSPR transfer</strong> to <M>payTo</M> with{' '}
        <M>transfer_id = extra.nonce</M>, then retries the request with the{' '}
        <M>X-PAYMENT</M> proof header (base64-encoded <M>PaymentPayload</M>).
        The gateway verifies that transfer on-chain (target, amount, transfer id, and age), burns the
        nonce so it can never be reused, proxies to the seller&apos;s upstream API, and returns the
        response — then records a success attestation that lifts the service&apos;s trust tier.
      </P>
      <Callout tone="info" title="PAYMENT IS NATIVE CSPR">
        Settlement is a plain native CSPR transfer whose <M>transfer_id</M> equals the invoice nonce
        — the &ldquo;Plan B&rdquo; scheme. It is not a CEP-18 token transfer and it does not call any
        vault contract. The gateway never custodies funds; payment goes straight from the buyer to
        the seller&apos;s account.
      </Callout>

      <H2 id="when-to-use">When to use AgentGate</H2>
      <P>
        Reach for AgentGate when the consumer of an API is software that holds a wallet rather than a
        person with a card. Typical fits:
      </P>
      <DocTable
        head={['You want to…', 'AgentGate gives you']}
        rows={[
          [
            'Sell data or compute to autonomous agents',
            'A pay-per-call paywall in front of your existing API — no billing system to build.',
          ],
          [
            'Let an agent buy capabilities mid-task',
            'On-chain discovery plus a 402 invoice the agent can settle in seconds, with proof instead of credentials.',
          ],
          [
            'Charge per request without accounts',
            'Native CSPR settlement that lands directly in your account; the gateway holds nothing.',
          ],
          [
            'Pick providers by reputation',
            'An on-chain attestation trail and trust tier (new → reliable → trusted) computed from real calls.',
          ],
        ]}
      />
      <P>
        It is a poor fit for human-facing checkout flows, subscriptions, or anything that needs
        chargebacks and refunds — those are the human-shaped patterns AgentGate deliberately
        replaces.
      </P>

      <H2 id="roles">The roles: seller, buyer, operator</H2>
      <P>
        Three actors meet at the gateway. Each has its own guide; this is the one-paragraph version
        of each.
      </P>
      <H3 id="role-seller">Seller — wraps an API</H3>
      <P>
        A seller owns an upstream HTTP API and wants to charge per call. Running{' '}
        <M>agentgate wrap</M> once registers the service on-chain (name, price in motes, payment
        target, attestor) and maps the private upstream URL on the gateway. After that, every call to
        the public <M>/svc/:id</M> endpoint is metered and paid. Full walkthrough in{' '}
        <DocLink href="/docs/sellers">Wrap an API</DocLink>.
      </P>
      <H3 id="role-buyer">Buyer — builds an agent that consumes a service</H3>
      <P>
        A buyer writes an agent that discovers services in the on-chain catalog, calls{' '}
        <M>/svc/:id</M>, handles the <M>402</M>, pays with a native CSPR transfer carrying the nonce,
        and retries with proof headers. You can do this with the bundled LLM buyer agent, the client
        SDK&apos;s <M>fetchPaid</M> helper, or plain <M>curl</M>. See{' '}
        <DocLink href="/docs/buyers">Build an agent</DocLink>.
      </P>
      <H3 id="role-operator">Operator — runs the gateway</H3>
      <P>
        An operator runs the middleware (the 402 reverse proxy + admin API) and, in live mode, the
        chain plumbing. The operator sets the admin token, the SSRF policy on upstream URLs, and the
        chain backend, and is responsible for deploying the registry contract before going live. See{' '}
        <DocLink href="/docs/deployment">Deploy to production</DocLink>.
      </P>

      <H2 id="modes">Mock vs live modes</H2>
      <P>
        A single environment variable — <M>AGENTGATE_MODE</M> (default <M>mock</M>) — selects the
        chain backend behind the <M>ChainClient</M> seam. Everything above that seam is identical, so
        you build and test offline and flip one flag to go on-chain.
      </P>
      <DocTable
        head={['Concern', 'mock (default)', 'live (Casper Testnet)']}
        rows={[
          [
            'Chain backend',
            <span key="m">
              In-memory devnet (<M>@agentgate/devnet</M>) at <M>:4030</M>
            </span>,
            'casper-js-sdk v5 + CSPR.cloud REST',
          ],
          [
            'Registry',
            'Devnet mirrors the Odra contract rules in memory',
            <span key="l">
              Deployed <M>AgentGateRegistry</M> contract
            </span>,
          ],
          [
            'Payment verify',
            'Devnet transfer lookup',
            <span key="v">
              CSPR.cloud <M>GET /transfers?deploy_hash=</M>
            </span>,
          ],
          ['Signers', 'Mock account strings', 'PEM keys'],
          [
            'Guardrails',
            'Default admin token allowed; SSRF guard off',
            'Default token refused; SSRF guard on',
          ],
        ]}
      />
      <Callout tone="warn" title="LIVE MODE PREREQUISITES">
        Live mode requires <M>CSPR_CLOUD_API_KEY</M> and a non-default <M>AGENTGATE_ADMIN_TOKEN</M>{' '}
        (both enforced by config), plus a deployed registry whose package hash is set as{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M>. Deploying that contract is documented but intentionally
        out of scope for this build — there is no live contract address yet. Until it is deployed,
        live chain reads and contract writes are gated behind <M>NOT_DEPLOYED</M>. See{' '}
        <DocLink href="/docs/contract">Smart contracts</DocLink>.
      </Callout>

      <H2 id="get-started">Browse the docs — Get started</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/quickstart',
            title: 'Quickstart',
            desc: 'Run the offline one-shot demo (register → 402 → pay → serve → attest → score) in about 60 seconds, then bring the stack up with seeded data and open the dashboard.',
          },
          {
            href: '/docs/installation',
            title: 'Installation',
            desc: 'Node ≥ 22 prerequisites, npm install, the monorepo package layout, and the dev scripts that boot the devnet, oracle, and middleware.',
          },
        ]}
      />

      <H2 id="guides">Guides</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/sellers',
            title: 'Wrap an API',
            desc: 'Put a 402 paywall in front of your upstream in one command, set a per-call price in CSPR, register on-chain, and collect payments straight to your account.',
          },
          {
            href: '/docs/buyers',
            title: 'Build an agent',
            desc: 'Discover services on-chain, parse the 402, pay with a native CSPR transfer, and retry with proof — via the buyer agent, the client SDK, or plain curl.',
          },
          {
            href: '/docs/deployment',
            title: 'Deploy to production',
            desc: 'Host the dashboard, middleware, and oracle; configure live-mode guardrails; and follow the registry deploy runbook (deploy itself is deferred).',
          },
        ]}
      />

      <H2 id="concepts">Concepts</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/protocol',
            title: 'How it works',
            desc: 'The x402 V1 payment protocol end to end: PaymentRequiredResponse fields, X-PAYMENT / X-PAYMENT-RESPONSE headers, on-chain verification, single-use nonce burning, and the attestation that feeds the trust score.',
          },
          {
            href: '/docs/architecture',
            title: 'Architecture',
            desc: 'The monorepo packages, the ChainClient seam that swaps mock and live, the middleware reverse proxy, and how each piece fits together.',
          },
          {
            href: '/docs/security',
            title: 'Security model',
            desc: 'Single-use nonces, admin-token enforcement, the SSRF guard on upstream URLs, on-chain payment verification, and the trust system that makes attestations meaningful.',
          },
        ]}
      />

      <H2 id="reference">Reference</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/cli',
            title: 'CLI',
            desc: 'agentgate wrap, list, status, pause, resume, and demo-accounts — flags, environment, output, and exit codes.',
          },
          {
            href: '/docs/api',
            title: 'HTTP API',
            desc: 'Every surface: the middleware paywall and admin API, the oracle feed, the mock devnet routes, and the dashboard /api endpoints.',
          },
          {
            href: '/docs/sdk',
            title: 'Client SDK',
            desc: 'The agent-side fetchPaid helper that parses a 402, pays, and retries — signatures, options, and return shapes.',
          },
          {
            href: '/docs/configuration',
            title: 'Configuration',
            desc: 'Every environment variable, the mock vs live guardrails, and the ports table for the full stack.',
          },
          {
            href: '/docs/contract',
            title: 'Smart contracts',
            desc: 'AgentGateRegistry entrypoints, events, error codes, storage layout, build/test commands, and deploy status.',
          },
          {
            href: '/docs/errors',
            title: 'Error codes',
            desc: 'The full table of 402 and gateway error codes, what each one means, and how a buying agent should respond.',
          },
        ]}
      />

      <NextLinks links={[{ href: '/docs/quickstart', label: 'Next: Quickstart' }]} />
    </>
  );
}
