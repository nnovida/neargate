import type { Metadata } from 'next';
import {
  Callout,
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
  title: 'Architecture',
  description:
    'How AgentGate fits together: the monorepo packages and their roles, the ChainClient seam that swaps mock and live backends, the 402 reverse-proxy data flow, where state lives, and the tech stack.',
};

export default function ArchitecturePage() {
  return (
    <>
      <DocHeader
        kicker="CONCEPTS"
        title="Architecture"
        lede="AgentGate is a TypeScript monorepo whose pieces meet at two seams: an HTTP 402 reverse proxy (the gateway) and a single ChainClient interface with a mock and a live implementation. This page maps the components, the data flow between them, and where every piece of state lives."
      />

      <H2 id="component-map">Component map</H2>
      <P>
        The repo is a workspace of focused packages plus a Next.js dashboard and the on-chain
        contracts. Each package does one job and talks to a small set of neighbours. The product
        core is the <M>middleware</M> (the 402 paywall reverse proxy); everything else either feeds
        it, consumes it, or observes it.
      </P>
      <DocTable
        head={['Component', 'Role', 'Talks to']}
        rows={[
          [
            <M key="c">packages/cli</M>,
            <>
              The <M>agentgate</M> seller CLI: <M>wrap</M>, <M>list</M>, <M>status</M>,{' '}
              <M>pause</M>, <M>resume</M>, <M>demo-accounts</M>. Registers a service on-chain and
              maps its upstream URL on the gateway.
            </>,
            <>
              <M>chain</M> (register / setActive) and the gateway admin API (map upstream)
            </>,
          ],
          [
            <M key="c">packages/buyer-agent</M>,
            <>
              An LLM decision loop (<M>AnthropicLlm</M> or the deterministic <M>MockLlm</M>) that
              discovers a service, decides to buy, and drives the pay-and-retry loop.
            </>,
            <>
              <M>chain</M> (discover catalog + scores) and the <M>client</M> SDK to pay/retry
            </>,
          ],
          [
            <M key="c">packages/client</M>,
            <>
              The agent-side SDK. <M>fetchPaid</M> parses a <M>402</M>, sends the CSPR transfer with{' '}
              <M>transfer_id = nonce</M>, then retries with proof headers.
            </>,
            <>
              the gateway <M>/svc/:id</M> endpoint and <M>chain.transfer</M>
            </>,
          ],
          [
            <M key="c">packages/middleware</M>,
            <>
              The product core: a 402 paywall reverse proxy plus a token-guarded admin API. Issues
              invoices, verifies transfers, burns nonces, proxies to the upstream, attests.
            </>,
            <>
              <M>chain</M> (verify / attest / read service), the seller&apos;s upstream API, and the{' '}
              <M>client</M>/buyers over HTTP
            </>,
          ],
          [
            <M key="c">packages/oracle</M>,
            <>
              An example upstream: a demo RWA feed (USD/IDR + gold spot + a confidence value). Stands
              in for the seller&apos;s real API so the full loop is runnable offline.
            </>,
            <>
              nothing on-chain — it is a plain HTTP API the gateway proxies to
            </>,
          ],
          [
            <M key="c">packages/devnet</M>,
            <>
              The mock chain: an in-process HTTP server that mirrors the registry rules in memory and
              exposes them over a small REST API (services, scores, attestations, transfers, balance).
            </>,
            <>
              the <M>MockChainHttpClient</M> only (it is the backend the mock client reads/writes)
            </>,
          ],
          [
            <M key="c">packages/chain</M>,
            <>
              The <M>ChainClient</M> seam itself: <M>MockChainHttpClient</M> (mock) and{' '}
              <M>LiveCasperClient</M> (live). One interface, two interchangeable backends.
            </>,
            <>
              <M>devnet</M> REST (mock) or a Casper node + CSPR.cloud (live)
            </>,
          ],
          [
            <M key="c">packages/shared</M>,
            <>
              Zero-runtime-dependency primitives: types (<M>ChainClient</M>, <M>Invoice402</M>,
              records), config loading/validation, bigint-safe money helpers, the logger, the trust
              tiers, and the SSRF/net guard helpers.
            </>,
            <>
              imported by every other package; talks to nothing
            </>,
          ],
          [
            <M key="c">dashboard</M>,
            <>
              A Next.js app: landing page, on-chain service catalog, live activity feed, and these
              docs. Read-only observability over a running stack.
            </>,
            <>
              the gateway and <M>chain</M> reads through its own server routes
            </>,
          ],
          [
            <M key="c">contracts</M>,
            <>
              The on-chain registry: <M>AgentGateRegistry</M> (Rust/Odra) holding services, scores,
              and attestations. The live <M>ChainClient</M> reads from and writes to it.
            </>,
            <>
              the Casper network; read/written by <M>LiveCasperClient</M>
            </>,
          ],
        ]}
      />

      <H2 id="chainclient-seam">The ChainClient seam</H2>
      <P>
        Every chain interaction in AgentGate goes through one TypeScript interface,{' '}
        <M>ChainClient</M> (defined in <M>packages/shared/src/types.ts</M>). It declares the reads —{' '}
        <M>getService</M>, <M>listServices</M>, <M>getScore</M>, <M>listAttestations</M>,{' '}
        <M>listRecentActivity</M>, <M>getBalance</M>, <M>verifyTransfer</M> — and the writes —{' '}
        <M>registerService</M>, <M>recordAttestation</M>, <M>setActive</M>, <M>transfer</M> — plus an
        optional <M>ping</M> readiness probe and a <M>network</M> string. Nothing above this seam
        knows whether it is talking to a mock chain or to Casper.
      </P>
      <P>
        There are exactly two implementations of that interface, both in{' '}
        <M>packages/chain</M>. Which one is constructed is selected at startup by{' '}
        <M>AGENTGATE_MODE</M> (default <M>mock</M>); the gateway, CLI, buyer agent, and dashboard all
        receive an injected <M>ChainClient</M> and are identical regardless of backend.
      </P>
      <DocTable
        head={['Aspect', 'MockChainHttpClient', 'LiveCasperClient']}
        rows={[
          [
            <M key="n">network</M>,
            <M key="m">&apos;mock&apos;</M>,
            <>
              configured network name (e.g. <M>casper-test</M>)
            </>,
          ],
          [
            'Backend',
            <>
              the in-process <M>@agentgate/devnet</M> REST server
            </>,
            <>
              a Casper node JSON-RPC endpoint plus the CSPR.cloud REST API
            </>,
          ],
          [
            'Reads',
            <>
              one HTTP GET per call onto a devnet route (e.g. <M>/chain/services/:id</M>)
            </>,
            <>
              CSPR.cloud REST (transfers, account balance, deploys, contract-package resolution)
            </>,
          ],
          [
            'Writes',
            <>
              HTTP POST to devnet (e.g. <M>/chain/register-service</M>, <M>/chain/transfers</M>)
            </>,
            <>
              signed transactions submitted to the node via casper-js-sdk
              (<M>ContractCallBuilder</M> for contract entry points, <M>NativeTransferBuilder</M> for
              payments)
            </>,
          ],
          [
            'Signer',
            <>
              a mock signer carrying only a public-key string (no key material)
            </>,
            <>
              a PEM private key loaded from <M>gateSignerPemPath</M> / the wallet PEM
            </>,
          ],
          [
            'Settlement',
            <>
              synchronous — devnet transfers settle immediately, so <M>verifyTransfer</M> never
              returns <M>pending</M>
            </>,
            <>
              asynchronous — a real transfer may still be settling, returning <M>pending</M> until it
              is final
            </>,
          ],
        ]}
      />
      <Callout tone="warn" title="LIVE BACKEND IS DEPLOY-GATED">
        <M>LiveCasperClient</M> needs a deployed registry whose package hash is set as{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M>. Until that exists, contract reads and writes throw{' '}
        <M>NOT_DEPLOYED</M> (HTTP 503). Several CSPR.cloud response shapes and the Odra state-key
        derivation carry <M>⚠️ verify-against-deployed-contract</M> notes in the source, because the
        deploy itself is intentionally out of scope for this build. See{' '}
        <DocLink href="/docs/contract">Smart contracts</DocLink>.
      </Callout>

      <H2 id="data-flow">Request and data flow</H2>
      <P>
        The end-to-end loop is <M>register → discover → 402 → pay → serve → attest → score</M>. It
        crosses every seam: the CLI and chain set things up, the buyer and client drive the request,
        and the middleware orchestrates verification and proxying.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Seller registers',
            body: (
              <>
                The CLI calls <M>chain.registerService</M> (name, price in motes, payment target,
                attestor), getting back a <M>serviceId</M>. It then maps the private upstream URL to
                that id on the gateway via <M>POST /admin/services</M> (admin token required). The
                service record lives on-chain; the upstream URL never does.
              </>
            ),
          },
          {
            title: 'Buyer discovers',
            body: (
              <>
                A buying agent reads the catalog through <M>chain.listServices</M> /{' '}
                <M>getScore</M> (or the dashboard) and picks a service by price and trust tier. It
                only ever learns the public gateway URL (<M>/svc/:id</M>), never the upstream.
              </>
            ),
          },
          {
            title: '402 challenge',
            body: (
              <>
                The agent calls <M>/svc/:id</M> with no proof. The gateway resolves the service
                (60s cache), confirms it is active and mapped, and answers <M>402</M> with a fresh{' '}
                <M>Invoice402</M> — <M>priceMotes</M>, <M>paymentTarget</M>, a single-use{' '}
                <M>nonce</M>, and <M>expiresAt</M> — persisting the invoice in the store.
              </>
            ),
          },
          {
            title: 'Pay',
            body: (
              <>
                The client SDK sends a native CSPR transfer to <M>paymentTarget</M> with{' '}
                <M>transfer_id = nonce</M> (via <M>chain.transfer</M>) and retries{' '}
                <M>/svc/:id</M> carrying <M>X-Payment-Deploy-Hash</M> and <M>X-Payment-Nonce</M>.
              </>
            ),
          },
          {
            title: 'Verify, burn, serve',
            body: (
              <>
                The gateway validates the invoice, then calls <M>chain.verifyTransfer</M> (target,
                amount, transfer id, age). On success it burns the nonce <em>before</em> proxying —
                single-use even if the upstream fails — then proxies to the upstream and returns its
                response. A <M>pending</M> verdict keeps the same invoice alive for a retry.
              </>
            ),
          },
          {
            title: 'Attest and score',
            body: (
              <>
                After responding, the gateway fires a non-blocking{' '}
                <M>chain.recordAttestation</M> (success := upstream 2xx), retried once on failure.
                The attestation updates the on-chain score, which the trust tier and the dashboard
                read back.
              </>
            ),
          },
        ]}
      />
      <P>
        Two security checks bracket the money. Before issuing an invoice the gateway refuses a request
        body it cannot faithfully forward (only JSON is relayed) so the buyer is never billed for a
        call the upstream cannot receive; and in live mode it re-resolves the upstream host against
        the SSRF guard at request time to defeat DNS rebinding. See{' '}
        <DocLink href="/docs/security">Security model</DocLink> and{' '}
        <DocLink href="/docs/protocol">How it works</DocLink>.
      </P>

      <H2 id="state-and-storage">State and storage</H2>
      <P>
        AgentGate keeps three distinct kinds of state, deliberately separated so that no single
        component owns everything.
      </P>
      <DocTable
        head={['State', 'Where it lives', 'Owner / lifecycle']}
        rows={[
          [
            'Service registry, scores, attestations',
            <>
              On-chain. In live mode this is the <M>AgentGateRegistry</M> contract dictionary; in
              mock mode the devnet mirrors the same rules in memory.
            </>,
            'The chain (authoritative); read through ChainClient.',
          ],
          [
            'Upstream URL map (serviceId → private URL)',
            <>
              A JSON file on the gateway host (default <M>data/upstreams.json</M> under the
              middleware package; overridable via <M>upstreamsFile</M>).
            </>,
            'The operator. Loaded at boot (re-applying the SSRF guard) and flushed on shutdown.',
          ],
          [
            'Invoices (nonce → invoice)',
            <>
              In memory in the gateway process — the default <M>MemoryInvoiceStore</M> with a TTL
              sweep (a custom <M>InvoiceStore</M> can be injected).
            </>,
            'The gateway. Single-use: a nonce is burned on first successful verify.',
          ],
        ]}
      />
      <P>
        The split matters: the chain is the source of truth for what a service is and how trustworthy
        it is; the upstream map is the one secret the gateway holds (the real backend URL, which is
        never exposed in any response); and invoices are short-lived, single-use, and never need to
        outlive the process.
      </P>

      <H2 id="mock-vs-live">Mock vs live backends</H2>
      <P>
        The same code path runs in both modes — only the constructed <M>ChainClient</M> differs.{' '}
        <M>mock</M> is the default and is fully offline: it boots the in-memory devnet, accepts the
        default admin token, and leaves the SSRF guard off so localhost demos work. <M>live</M>{' '}
        targets Casper Testnet through casper-js-sdk and CSPR.cloud, refuses the default admin token,
        turns the SSRF guard on, and requires real signing keys.
      </P>
      <Callout tone="info" title="ONE SEAM, NO LEAKAGE">
        Because the difference is isolated to <M>packages/chain</M>, you develop and test the entire
        loop offline against the devnet, then flip <M>AGENTGATE_MODE</M> to <M>live</M> to go
        on-chain. The middleware, CLI, buyer agent, and dashboard need no changes. Full env-var
        details are in <DocLink href="/docs/configuration">Configuration</DocLink>.
      </Callout>

      <H2 id="tech-stack">Tech stack</H2>
      <P>
        The stack is intentionally small and standard: a single language for the application tier,
        plain HTTP between components, and Rust only where the chain demands it.
      </P>
      <DocTable
        head={['Layer', 'Technology', 'Notes']}
        rows={[
          [
            'Runtime',
            <>
              Node <M>≥ 22</M>
            </>,
            'Uses the built-in fetch and AbortSignal.timeout; no polyfills.',
          ],
          [
            'Language',
            'TypeScript (ESM, strict mode)',
            'One language across CLI, agent, SDK, gateway, oracle, devnet, and shared.',
          ],
          [
            'HTTP services',
            'Express',
            <>
              The gateway and devnet are Express apps; the gateway adds <M>helmet</M> and per-route
              rate limiting.
            </>,
          ],
          [
            'Dashboard',
            'Next.js (App Router)',
            'Server components read the stack through their own server routes.',
          ],
          [
            'Smart contract',
            'Rust + Odra',
            <>
              The <M>AgentGateRegistry</M> module; built and tested with <M>cargo odra</M>.
            </>,
          ],
          [
            'Chain',
            'Casper (Testnet)',
            <>
              Live writes via casper-js-sdk to a node; live reads via the CSPR.cloud REST API.
            </>,
          ],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/security', label: 'Next: Security model' },
          { href: '/docs/contract', label: 'Smart contracts' },
        ]}
      />
    </>
  );
}
