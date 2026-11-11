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
    'What NearGate is, the HTTP 402 + NEAR mental model, the seller / buyer / operator roles, mock vs live modes, and a map of the documentation.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="GET STARTED"
        title="NearGate Docs"
        lede="Stripe for AI agents on NEAR. Wrap any HTTP API behind an HTTP 402 paywall, register and score it on-chain, and let buying agents pay per call in native NEAR, with no accounts, no API keys and no subscriptions. This page gives you the mental model, then routes you by role — seller, buyer or gateway operator."
      />

      <H2 id="what-is-neargate">What NearGate is</H2>
      <P>
        NearGate is an <DocLink href="/docs/protocol">x402</DocLink>-style payment gateway — x402 is
        the open convention for settling HTTP <M>402 Payment Required</M> challenges with on-chain
        payments — for machine-to-machine APIs. A seller puts any HTTP endpoint behind a{' '}
        <M>402</M> paywall and registers it in the on-chain <M>neargate-registry</M> contract. A
        buying agent discovers the service, receives a machine-readable invoice, pays it through
        the registry, then retries with the transaction hash as proof — and the gateway records an
        on-chain attestation that feeds the service’s trust score. The whole loop is{' '}
        <M>register → 402 → pay → serve → attest → score</M>.
      </P>
      <P>
        Nothing about it is human-shaped. There is no signup form, no credit card, no KYC and no API
        key to copy into a config file. The only credential an agent needs is a NEAR account and its
        key, plus the ability to make an HTTP request.
      </P>

      <H3 id="mental-model">The mental model: HTTP 402 + NEAR</H3>
      <P>
        When an agent calls a paid endpoint with no proof, the gateway answers <M>402</M> with a{' '}
        <M>PaymentRequiredResponse</M> (x402 V1): <M>x402Version: 1</M>, an <M>error</M> text and an{' '}
        <M>accepts[]</M> entry carrying <M>maxAmountRequired</M> (the price plus the storage fee, in
        yoctoNEAR), <M>payTo</M> (the registry account), a single-use <M>extra.nonce</M> and{' '}
        <M>extra.expiresAtMs</M>. The agent calls the registry’s{' '}
        <M>pay(service_id, nonce)</M> with <M>maxAmountRequired</M> attached, then retries the
        request with an <M>X-PAYMENT</M> header (base64 JSON naming the transaction, the nonce and
        the payer). The gateway checks the registry’s payment record for that nonce, burns the nonce
        so it can never be reused, proxies to the seller’s upstream API and returns the response,
        then records a success attestation on-chain.
      </P>
      <Callout tone="info" title="PAYMENTS GO THROUGH THE REGISTRY">
        <P>
          The buyer never pays the seller directly. <M>pay</M> forwards exactly the service price
          to the seller’s <M>payment_target</M>, keeps a flat <M>0.002 NEAR</M> storage fee for the
          payment record, and refunds anything attached above <M>price + 0.002 NEAR</M>. Because
          the registry itself holds the payment record, an attestation can only exist for a real
          payment — see the <DocLink href="/docs/security">security model</DocLink>. The gateway
          never custodies funds.
        </P>
      </Callout>

      <H2 id="when-to-use">When to use NearGate</H2>
      <P>
        Reach for NearGate when the consumer of an API is software that holds a NEAR account rather
        than a person with a card. Typical fits:
      </P>
      <DocTable
        head={['You want to…', 'NearGate gives you']}
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
            'Native NEAR settlement that lands directly in your payment-target account; the gateway holds nothing.',
          ],
          [
            'Pick providers by reputation',
            'A payment-backed attestation trail and a trust tier (new → reliable → trusted) computed from real paid calls.',
          ],
        ]}
      />
      <P>
        It is a poor fit for human-facing checkout flows, subscriptions, or anything that needs
        chargebacks and refunds — those are the human-shaped patterns NearGate deliberately replaces.
      </P>

      <H2 id="roles">The roles: seller, buyer, operator</H2>
      <P>Three actors meet at the gateway. Each has its own commands; this is the short version.</P>
      <H3 id="role-seller">Seller — wraps an API</H3>
      <P>
        A seller owns an upstream HTTP API and wants to charge per call. Running{' '}
        <M>neargate wrap</M> once calls <M>register_service</M> on the registry (name, description,
        gateway URL, price, payment target, attestor; <M>0.12 NEAR</M> deposit) and maps the
        private upstream URL on the gateway (live mode: with a request signed by the owner’s
        key). After that, every call to the public <M>/svc/:id</M> endpoint is metered and paid. See{' '}
        <DocLink href="/docs/cli#wrap">CLI → wrap</DocLink>.
      </P>
      <H3 id="role-buyer">Buyer — an agent that consumes a service</H3>
      <P>
        A buyer discovers services in the on-chain catalog, calls <M>/svc/:id</M>, handles the{' '}
        <M>402</M>, pays through the registry and retries with proof. You can do that with one
        command (<M>neargate buy</M>), any MCP-capable agent through the{' '}
        <DocLink href="/docs/cli#mcp">MCP server</DocLink>, the bundled buyer agent, or the{' '}
        <M>@agentgate/client</M> package’s <M>fetchPaid</M> helper. The{' '}
        <DocLink href="/docs/protocol">protocol page</DocLink> spells out every step for a
        hand-rolled client.
      </P>
      <H3 id="role-operator">Operator — runs the gateway</H3>
      <P>
        An operator runs the gateway (the 402 reverse proxy — the <M>@agentgate/middleware</M>{' '}
        package) against a deployed registry. In live mode the gateway needs a NEAR account of its
        own: it signs the attestations and is registered as each service’s attestor. The operator
        sets <M>REGISTRY_CONTRACT_ID</M>, the gateway account and key, and a non-default admin
        token. The <DocLink href="/docs/quickstart#testnet">quickstart</DocLink> lists the testnet
        scripts that create the accounts, deploy the contract and seed a first service.
      </P>

      <H2 id="modes">Mock vs live modes</H2>
      <P>
        A single environment variable — <M>AGENTGATE_MODE</M> — selects the chain backend behind the{' '}
        <M>ChainClient</M> seam. The stack (gateway, buyer agent, dashboard) defaults to <M>mock</M>,
        while the <M>neargate</M> CLI defaults to <M>live</M>. Everything above the seam is the same,
        so you build and test offline and flip one variable to go on-chain.
      </P>
      <DocTable
        head={['Concern', 'mock (default for the stack)', 'live (NEAR testnet)']}
        rows={[
          [
            'Chain backend',
            <span key="m">
              In-memory devnet (<M>@agentgate/devnet</M>) at <M>:4030</M>, network{' '}
              <M>near-mock</M>
            </span>,
            <span key="l">
              The NEAR RPC (<M>NEAR_RPC_URL</M>), network <M>near-testnet</M>
            </span>,
          ],
          [
            'Registry',
            'The devnet applies the registry contract’s rules in memory',
            <span key="r">
              The deployed <M>neargate-registry</M> contract (<M>REGISTRY_CONTRACT_ID</M>)
            </span>,
          ],
          [
            'Payment check',
            'The devnet’s payment record for the nonce',
            <span key="v">
              The registry’s <M>get_payment</M> view, plus the RPC’s record of the <M>pay</M>{' '}
              transaction
            </span>,
          ],
          [
            'Signers',
            'Mock account ids, no keys',
            'ed25519 keys: a near-cli credentials file, a key file, or a secret key in the environment',
          ],
          [
            'Explorer links',
            'None (no explorer indexes the devnet)',
            <span key="e">
              nearblocks (<M>NEAR_EXPLORER_URL</M>)
            </span>,
          ],
          [
            'Guardrails',
            'Default admin token allowed; SSRF guard off so localhost upstreams work',
            'Default admin token refused; SSRF guard on',
          ],
        ]}
      />
      <Callout tone="warn" title="LIVE MODE PREREQUISITES">
        Live mode needs <M>REGISTRY_CONTRACT_ID</M> — with it unset the chain client refuses to
        start with <M>CONFIG_INVALID</M>. The registry badge at the top of each docs page reads{' '}
        <M>not deployed</M> until a default registry id is set. The gateway also needs{' '}
        <M>GATEWAY_ACCOUNT_ID</M> with a key and a non-default <M>AGENTGATE_ADMIN_TOKEN</M>; both are
        enforced by config. Reading the catalog (<M>neargate list</M>, <M>status</M>) needs no key.
      </Callout>

      <H2 id="get-started">Where to go next</H2>
      <CardGrid
        cards={[
          {
            href: '/docs/quickstart',
            title: 'Quickstart',
            desc: 'Run the offline demo (register → 402 → pay → serve → attest → score), bring the stack up with seeded data and open this dashboard, then the testnet scripts.',
          },
          {
            href: '/docs/cli',
            title: 'CLI & MCP',
            desc: 'neargate wrap, map, list, buy, status, pause, resume, demo-accounts and the MCP server: every flag, the four MCP tools, and the error codes you can meet.',
          },
          {
            href: '/docs/protocol',
            title: 'How it works',
            desc: 'The x402 flow on NEAR end to end: the 402 body, the registry pay call, the X-PAYMENT proof, verification, the single-use nonce, attestations and the gateway’s receipts endpoint.',
          },
          {
            href: '/docs/security',
            title: 'Security model',
            desc: 'What the chain enforces and what the gateway reports: payment-backed scores, the self-map signature, the SSRF guard, redirects and budget caps.',
          },
          {
            href: '/docs/contract',
            title: 'Registry contract',
            desc: 'The neargate-registry ABI: change methods, views, constants, limits, events and every ERR_* code.',
          },
        ]}
      />

      <NextLinks links={[{ href: '/docs/quickstart', label: 'Quickstart' }]} />
    </>
  );
}
