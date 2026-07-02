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
