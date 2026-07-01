import { docMeta } from '@/lib/seo';
import { DOCS_VERSION, REGISTRY_HASH_SHORT } from '@/lib/version';
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
        lede={
          <>
            Notable changes to AgentGate, newest first. Current: CLI v{DOCS_VERSION.cli} · SDK v
            {DOCS_VERSION.sdk} · registry {REGISTRY_HASH_SHORT} on {DOCS_VERSION.network}.
          </>
        }
      />

      <H2 id="2026-07-01">2026-07-01 — Self-service mapping &amp; docs hardening</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
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
          OpenGraph/Twitter cards, JSON-LD, in-docs <M>⌘K</M> search, and this changelog.
        </li>
      </ul>

      <H2 id="2026-06-30">2026-06-30 — CLI published to npm</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <M>@neargate/cli</M> v{DOCS_VERSION.cli} published — run it with{' '}
          <M>npx @neargate/cli</M>, no install or clone.
        </li>
        <li>
          The published CLI defaults to <M>live</M> mode and the deployed registry hash, so{' '}
          <M>list</M> and <M>status</M> read Casper Testnet with no configuration. See{' '}
          <DocLink href="/docs/cli">CLI</DocLink>.
        </li>
      </ul>

      <H2 id="2026-06-29">2026-06-29 — Live on Casper Testnet</H2>
      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-mut">
        <li>
          <M>AgentGateRegistry</M> deployed to Casper Testnet (network <M>{DOCS_VERSION.network}</M>),
          package hash <M>{REGISTRY_HASH_SHORT}</M>. The full{' '}
          <M>register → 402 → pay → serve → attest → score</M> loop runs on-chain. See{' '}
          <DocLink href="/docs/contract">Smart contracts</DocLink>.
        </li>
        <li>Hosted gateway and dashboard brought online so agents can transact without local setup.</li>
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
