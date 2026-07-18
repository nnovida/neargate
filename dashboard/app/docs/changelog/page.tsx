import { docMeta } from '@/lib/seo';
import { DocHeader, H2, M, P, DocLink, NextLinks } from '@/components/docs';

export const metadata = docMeta(
  '/docs/changelog',
  'Changelog',
  'Notable changes to AgentGate — the CLI, gateway, smart contracts and docs — newest first.',
);

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Changelog"
        lede="Notable changes to AgentGate — the CLI, gateway, smart contracts and docs — newest first."
      />

      <H2 id="2026-07-18-v015">2026-07-18 — CLI v0.1.5: official Casper x402 facilitator rail</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">Official x402 rail (opt-in, per service).</strong> AgentGate
          now also speaks the official Casper x402 stack — <M>CEP-18</M> + <M>EIP-712</M> settled
          through the CSPR.cloud <M>facilitator</M> — alongside the native-CSPR rail. A service listed
          in <M>FACILITATOR_SERVICES</M> runs its whole <M>402 → pay → settle → attest</M> loop through
          the facilitator (x402 v2, <M>PAYMENT-SIGNATURE</M> header); every other service stays on the
          native rail, byte-unchanged. No contract redeploy — the settle tx hash is recorded as the
          on-chain attestation.
        </li>
        <li>
          <strong className="text-white">Buyer.</strong> <M>agentgate buy</M> auto-detects a
          facilitator invoice (by <M>x402Version</M>) and signs an EIP-712 authorization with the buyer
          key — new <M>--key-algo</M> flag (default <M>secp256k1</M>); the MCP <M>agentgate_buy</M> tool
          supports it too. CEP-18 has no native-transfer floor, so this unlocks true sub-CSPR
          micropayments.
        </li>
        <li>
          <strong className="text-white">Gateway.</strong> A facilitator-enabled service verifies and
          settles via the CSPR.cloud facilitator (gas sponsored by the facilitator), then proxies and
          attests. Config: <M>FACILITATOR_URL</M>, <M>BUYER_KEY_ALGO</M>, <M>FACILITATOR_SERVICES</M>.
          Proven end-to-end on Casper Testnet.
        </li>
      </ul>

      <H2 id="2026-07-18-v014">2026-07-18 — CLI v0.1.4</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">MCP readiness hint.</strong> When the{' '}
          <M>agentgate mcp</M> server starts it now prints a readiness line to <M>stderr</M> — so
          an agent harness (or a human) can tell the stdio server is up instead of guessing from
          silence. <M>stdout</M> stays reserved for the JSON-RPC stream, so the transport is
          unchanged; running it bare in a terminal no longer looks like a hang.
        </li>
      </ul>

      <H2 id="2026-07-18-v013">2026-07-18 — CLI v0.1.3: MCP server</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">MCP server — <M>agentgate mcp</M>.</strong> AgentGate is
          now a Model Context Protocol stdio server, so any MCP-capable agent (Claude Desktop, a
          custom client, an MCP-aware framework) gets AgentGate as native tools:{' '}
          <M>agentgate_list_services</M>, <M>agentgate_get_service</M>,{' '}
          <M>agentgate_get_invoice</M> (all read-only, no key) and <M>agentgate_buy</M> (pays a
          402 invoice in native CSPR from the buyer key, capped by <M>maxCspr</M>). The published
          CLI defaults to live Testnet, so the read tools work with zero configuration. See{' '}
          <DocLink href="/docs/cli#mcp">the mcp reference</DocLink>.
        </li>
        <li>
          <strong className="text-white">Durable attestation queue.</strong> A served-and-paid
          call whose on-chain attestation had not confirmed before a deploy or crash was
          previously under-counted. Attestations are now persisted and{' '}
          <strong className="text-white">replayed on boot</strong> — idempotent on-chain via the
          registry&apos;s seen-payments dedup — so trust scores never silently lose a paid call.
        </li>
      </ul>

      <H2 id="2026-07-07">2026-07-07 — Security &amp; community standards</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">CodeQL clean.</strong> Resolved every CodeQL alert (a
          ReDoS pattern, a URL-validation check, and workflow permissions) — the repository scans
          with zero open alerts.
        </li>
        <li>
          <strong className="text-white">Community health.</strong> Added the GitHub
          community-standards files — <M>CONTRIBUTING.md</M>, <M>CODE_OF_CONDUCT.md</M> and{' '}
          <M>SECURITY.md</M> — and enabled Dependabot.
        </li>
      </ul>

      <H2 id="2026-07-02-buy">2026-07-02 — CLI v0.1.2: `agentgate buy`</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">New command: <M>buy</M>.</strong> One command runs the
          whole buyer exchange — fetch the <M>402</M> invoice, pay it with a native CSPR
          transfer (<M>transfer_id</M> = nonce), retry with the <M>X-PAYMENT</M> proof — and
          prints the response body to stdout with the payment receipt on stderr.{' '}
          <M>--max</M> caps what it may pay; unknown/paused services and over-cap invoices are
          refused before any payment. See <DocLink href="/docs/cli#buy">the buy reference</DocLink>.
        </li>
        <li>
          The buyer signer is <M>MOCK_BUYER_ACCOUNT</M> (mock) or <M>--pem</M> /{' '}
          <M>BUYER_SIGNER_PEM_PATH</M> (live) — for <M>buy</M>, <M>--pem</M> means the buyer
          key, not the seller key.
        </li>
      </ul>

      <H2 id="2026-07-02">2026-07-02 — CLI v0.1.1</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <M>@neargate/cli</M> v0.1.1 published — <M>wrap</M> in live mode now prints the
          hosted dashboard link for the wrapped service instead of a localhost URL.
        </li>
        <li>
          A fresh-machine wrap walkthrough ships in the repo (<M>docs/WRAP-QUICKSTART.md</M>).
        </li>
      </ul>

      <H2 id="2026-07-01-security">2026-07-01 — Gateway security hardening</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">Invoice persistence.</strong> New optional{' '}
          <M>INVOICE_STORE_PATH</M> env var enables a file-backed invoice store so issued
          invoices survive a gateway restart. See{' '}
          <DocLink href="/docs/configuration">Configuration</DocLink>.
        </li>
        <li>
          <strong className="text-white">Stricter payment verification.</strong> A payment must
          now carry the invoice&apos;s <M>transfer_id</M> and the payment target on the same
          transfer; the amount and age checks bind to that transfer.
        </li>
        <li>
          <strong className="text-white">Trust-score integrity.</strong> Calls paid from the
          seller&apos;s own account are served but never attested (wash-trade guard),
          gateway-level upstream failures are no longer scored, and attestation submission
          retries with exponential backoff.
        </li>
      </ul>

      <H2 id="2026-07-01">2026-07-01 — CLI on npm, self-service mapping &amp; docs hardening</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <strong className="text-white">CLI on npm.</strong> <M>@neargate/cli</M> v0.1.0
          published — run it with <M>npx @neargate/cli</M>, no install or clone. The
          published CLI defaults to <M>live</M> mode and the deployed registry hash, so{' '}
          <M>list</M> and <M>status</M> read Casper Testnet with no configuration. See{' '}
          <DocLink href="/docs/cli">CLI</DocLink>.
        </li>
        <li>
          <strong className="text-white">Hosted endpoints.</strong> Gateway (
          <M>gateway.example.org</M>) and dashboard (<M>agentgate.example.org</M>) brought
          online so agents can transact without local setup.
        </li>
        <li>
          <strong className="text-white">Self-service gateway mapping.</strong> <M>wrap</M> now maps
          the upstream with an owner-signed request to <M>/services/&lt;id&gt;/map</M> — a live wrap
          needs only <M>--pem</M>, no admin token.
        </li>
        <li>
          <strong className="text-white">Role-oriented docs.</strong> The sidebar and overview map
          are organized by role (For sellers / For buyers / Run a gateway) from a single source of
          truth.
        </li>
        <li>
          <strong className="text-white">Docs accessibility + accuracy pass.</strong> Skip-to-content
          link, keyboard focus rings, AA-contrast parameter tables, copy buttons on every code block,
          a CLI config-flags reference, a corrected <M>status</M> no-key example, and fixed
          cross-links.
        </li>
        <li>
          <strong className="text-white">Discovery.</strong> Added a sitemap, robots, canonical URLs,
          OpenGraph/Twitter cards, JSON-LD, in-docs <M>⌘K</M>/<M>Ctrl-K</M> search, and this
          changelog.
        </li>
      </ul>

      <H2 id="2026-06-30">2026-06-30 — CLI made publish-ready</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          The CLI was renamed <M>@agentgate/cli</M> → <M>@neargate/cli</M> and bundled into a
          publishable package ahead of the next day&apos;s npm release.
        </li>
      </ul>

      <H2 id="2026-06-29">2026-06-29 — Live on Casper Testnet</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <M>AgentGateRegistry</M> deployed to Casper Testnet (network <M>casper-test</M>),
          package hash <M>hash-10f92725…</M>. The full{' '}
          <M>register → 402 → pay → serve → attest → score</M> loop runs on-chain. See{' '}
          <DocLink href="/docs/contract">Smart contracts</DocLink>.
        </li>
      </ul>

      <NextLinks
        links={[
          { href: '/docs/quickstart', label: 'Quickstart' },
          { href: '/docs/contract', label: 'Smart contracts' },
        ]}
      />
    </>
  );
}
