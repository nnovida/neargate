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
  alternates: { canonical: '/docs' },
  title: 'Overview',
  description:
    'What AgentGate is, the HTTP 402 + Casper mental model, the seller / buyer / operator roles, mock vs live modes, and a map of the full documentation.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="GET STARTED"
        title="AgentGate Docs"
        lede="Stripe for AI agents on Casper. Wrap any HTTP API behind an HTTP 402 paywall, register and score it on-chain, and let buying agents pay per call — native CSPR by default, or a CEP-18 token via the official Casper x402 facilitator — with no accounts, no API keys, no subscriptions. This page gives you the mental model, then routes you by role — seller, buyer, or gateway operator — to the right guide."
      />

      <H2 id="what-is-agentgate">What AgentGate is</H2>
      <P>
        AgentGate is an <DocLink href="/docs/protocol">x402</DocLink>-style payment gateway — x402
        is the open convention for settling HTTP <M>402 Payment Required</M> challenges with
        on-chain payments — for machine-to-machine APIs. A seller puts any
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
      <Callout tone="info" title="TWO PAYMENT RAILS: NATIVE CSPR + OFFICIAL FACILITATOR">
        <P>
          <strong className="text-white">Native CSPR (default).</strong> Settlement is a plain native
          CSPR transfer whose <M>transfer_id</M> equals the invoice nonce — the buyer broadcasts it and
          the gateway verifies it on-chain. It does not call any vault contract; the gateway never
          custodies funds, and payment goes straight to the seller&apos;s account. Casper enforces a{' '}
          <M>2.5 CSPR</M> network minimum on live native transfers, so native-rail services should
          price at ≥ 2.5 CSPR.
        </P>
        <P>
          <strong className="text-white">Official facilitator (opt-in, per service).</strong> A service
          listed in <M>FACILITATOR_SERVICES</M> instead settles through the official Casper x402{' '}
          <M>facilitator</M> (CSPR.cloud): a <strong className="text-white">CEP-18</strong> token moved
          by an <strong className="text-white">EIP-712</strong> authorization (x402 v2,{' '}
          <M>PAYMENT-SIGNATURE</M> header), with gas sponsored by the facilitator. CEP-18 has no
          2.5-CSPR floor, so this rail supports true sub-CSPR micropayments. The live deployment
          settles in <M>WCSPR</M> (Wrapped CSPR, mintable 1:1 from CSPR on <M>testnet.cspr.trade</M>),
          though the rail accepts any CEP-18 token. Either way the gateway custodies nothing. See{' '}
          <DocLink href="/docs/deployment">Deploy</DocLink> and the{' '}
          <DocLink href="/docs/changelog">changelog</DocLink>.
        </P>
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
        <M>/svc/:id</M>, handles the <M>402</M>, pays (a native CSPR transfer carrying the nonce, or —
        on facilitator-enabled services — a CEP-18 EIP-712 authorization), and retries with proof
        headers. You can do this with one command (<M>npx @neargate/cli@latest
        buy</M>), an MCP-capable agent via the <DocLink href="/docs/cli#mcp">MCP server</DocLink>, the
        bundled LLM buyer agent, the client SDK&apos;s <M>fetchPaid</M> helper, or plain <M>curl</M>. See{' '}
        <DocLink href="/docs/buyers">Build an agent</DocLink>.
      </P>
      <H3 id="role-operator">Operator — runs the gateway</H3>
      <P>
        An operator runs the gateway (the 402 reverse proxy + admin API — the{' '}
        <M>@agentgate/middleware</M> package) and, in live mode, the chain plumbing. The operator
        sets the admin token, the SSRF policy on upstream URLs, and the chain backend, and points{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> at a deployed <M>AgentGateRegistry</M> before going
        live — on Casper Testnet the contract is already deployed, so most operators just set the
        hash (deploying your own registry is covered in{' '}
        <DocLink href="/docs/contract">Smart contracts</DocLink>). See{' '}
        <DocLink href="/docs/deployment">Deploy to production</DocLink>.
      </P>

      <H2 id="modes">Mock vs live modes</H2>
      <P>
        A single environment variable — <M>AGENTGATE_MODE</M> — selects the chain backend behind the{' '}
        <M>ChainClient</M> seam. The stack (gateway, buyer agent, dashboard) defaults to <M>mock</M> via{' '}
        <M>loadConfig()</M>, while the published <M>npx</M> CLI defaults to <M>live</M>. Everything above
        the seam is identical, so you build and test offline and flip one flag to go on-chain.
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
            'Devnet mirrors the registry contract rules (written in Odra, Casper’s Rust framework) in memory',
            <span key="l">
              Deployed <M>AgentGateRegistry</M> contract
            </span>,
          ],
          [
            'Payment verify',
            'Devnet transfer lookup',
            <span key="v">
              CSPR.cloud <M>GET /deploys/&lt;hash&gt;/transfers</M>
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
        (both enforced by config), plus the registry package hash set as{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M>. The <M>AgentGateRegistry</M> contract is LIVE on
        Casper Testnet (network <M>casper-test</M>) — package hash{' '}
        <M>hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9</M>. If{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> is unset (e.g. a fresh checkout with no .env), the
        gateway falls back to <M>NOT_DEPLOYED</M> (503). See{' '}
        <DocLink href="/docs/contract">Smart contracts</DocLink>. These prerequisites apply only
        when you run the gateway/stack yourself — the public gateway is already hosted at{' '}
        <M>https://gateway.example.org</M>, and the published CLI defaults the registry hash and
        reads Casper Testnet with no keys.
      </Callout>

      <H2 id="get-started">Get started</H2>
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
            desc: 'Node ≥ 22 prerequisites, npm install, the monorepo package layout, and the dev scripts that boot the devnet, the sample oracle upstream (an FX & gold price API used in the demo), and the gateway.',
          },
        ]}
      />

      <H2 id="for-sellers">For sellers</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/sellers',
            title: 'Wrap an API',
            desc: 'Put a 402 paywall in front of your upstream in one command, set a per-call price in CSPR, register on-chain, and collect payments straight to your account.',
          },
          {
            href: '/docs/cli',
            title: 'CLI',
            desc: 'agentgate wrap, buy, list, status, pause, resume, demo-accounts, and the mcp server — flags, environment, output, and exit codes.',
          },
        ]}
      />

      <H2 id="for-buyers">For buyers</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/buyers',
            title: 'Build an agent',
            desc: 'Discover services on-chain, parse the 402, pay with a native CSPR transfer, and retry with proof — via the one-command buy CLI, the LLM buyer agent, the client SDK, or plain curl.',
          },
          {
            href: '/docs/sdk',
            title: 'Client SDK',
            desc: 'The agent-side fetchPaid helper that parses a 402, pays, and retries — signatures, options, and return shapes.',
          },
        ]}
      />

      <H2 id="run-a-gateway">Run a gateway</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/deployment',
            title: 'Deploy to production',
            desc: 'Host the dashboard, gateway, and oracle; configure live-mode guardrails; and set REGISTRY_CONTRACT_PACKAGE_HASH to connect to the live AgentGateRegistry on Casper Testnet.',
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
            href: '/docs/api',
            title: 'HTTP API',
            desc: 'Both surfaces: the gateway — health probes, the /svc/:id paywall proxy, self-service mapping and the admin API — plus the dashboard’s read-only /api routes.',
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
          {
            href: '/docs/changelog',
            title: 'Changelog',
            desc: 'Notable changes to the CLI, gateway, smart contracts and docs — newest first.',
          },
        ]}
      />

      <NextLinks links={[{ href: '/docs/quickstart', label: 'Quickstart' }]} />
    </>
  );
}
