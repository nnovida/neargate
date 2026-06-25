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
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Installation',
  description:
    'Requirements, clone-and-install, the workspace layout, mock vs live mode, the environment file, and how to verify your install passes tests, typecheck and the one-shot demo.',
};

export default function InstallationPage() {
  return (
    <>
      <DocHeader
        kicker="docs / installation"
        title="Installation"
        lede="AgentGate is an npm-workspaces monorepo. One install at the repo root builds every package plus the dashboard, and a clean clone runs end to end in mock mode with no keys, no network and no chain access. This page covers requirements, the project layout, the two run modes, the env file, and how to verify the install."
      />

      <H2 id="requirements">Requirements</H2>
      <P>
        The TypeScript stack needs only Node.js and git. The Rust toolchain is{' '}
        <strong className="text-white">optional</strong> — it is required exclusively to build or
        test the Odra smart contracts under <M>contracts/</M>, never for the gateway, CLI, buyer
        agent or dashboard.
      </P>
      <DocTable
        head={['Requirement', 'Version', 'Needed for']}
        rows={[
          [
            <M key="n">Node.js</M>,
            '≥ 22',
            <span key="d">
              Enforced by the root <M>engines.node</M> field. The monorepo uses npm workspaces
              (npm 10+, which ships with Node 22).
            </span>,
          ],
          [
            <M key="g">git</M>,
            'any recent',
            'Cloning the repository.',
          ],
          [
            <M key="r">Rust toolchain</M>,
            'optional',
            <span key="d">
              Only to build/test the contracts. <M>cargo</M> + <M>rustup</M>; a{' '}
              <M>wasm32-unknown-unknown</M> target is needed for{' '}
              <M>cargo odra build</M>. Not required for any TypeScript workflow.
            </span>,
          ],
          [
            <M key="c">cargo-odra</M>,
            'optional',
            <span key="d">
              The Odra contract tool (<M>cargo install cargo-odra</M>). Drives{' '}
              <M>cargo odra test</M> / <M>cargo odra build</M> for{' '}
              <DocLink href="/docs/contract">the registry contract</DocLink>. Not required to run
              AgentGate in mock or live mode.
            </span>,
          ],
        ]}
      />
      <Callout tone="info" title="Contracts are deferred">
        Deploying the registry to Casper Testnet is intentionally out of scope for this build — no
        live contract address exists yet. You can install, run the full payment loop, and pass
        every test without ever touching Rust. The Rust toolchain only matters if you want to run
        the 20 OdraVM contract tests locally.
      </Callout>

      <H2 id="clone-install">Clone and install</H2>
      <P>
        Clone the repository and run a single install from the repo root. npm hoists and links all
        workspaces in one pass.
      </P>
      <CommandBlock
        wrap
        prompt={null}
        text={'git clone <repo-url> agentgate\ncd agentgate\nnpm install'}
      />
      <P>
        After install, no further setup is required for mock mode — every environment variable has
        a working default (see <DocLink href="/docs/configuration">Configuration</DocLink>). The
        repo root <M>package.json</M> declares the workspaces as <M>packages/*</M> and{' '}
        <M>dashboard</M>, and all shared scripts (<M>demo</M>, <M>dev</M>, <M>test</M>,{' '}
        <M>typecheck</M>) run from there.
      </P>

      <H2 id="project-layout">Project layout</H2>
      <P>
        Each workspace is a focused package with a single responsibility. The{' '}
        <M>@agentgate/shared</M> package sits at the bottom (zero runtime deps); everything above
        it talks to the chain through the <M>ChainClient</M> seam, which mock and live modes both
        implement.
      </P>
      <DocTable
        head={['Path', 'Package', 'Purpose']}
        rows={[
          [
            <M key="p">packages/shared</M>,
            <M key="n">@agentgate/shared</M>,
            'Shared types, config loader, bigint money helpers and trust-tier logic — zero runtime dependencies.',
          ],
          [
            <M key="p">packages/chain</M>,
            <M key="n">@agentgate/chain</M>,
            <span key="d">
              The <M>ChainClient</M> abstraction with two implementations:{' '}
              <M>MockChainHttpClient</M> (mock) and <M>LiveCasperClient</M> (Casper Testnet).
            </span>,
          ],
          [
            <M key="p">packages/middleware</M>,
            <M key="n">@agentgate/middleware</M>,
            'The product core — the 402 paywall reverse proxy plus the admin API; verifies payments, burns nonces, proxies upstream, records attestations.',
          ],
          [
            <M key="p">packages/buyer-agent</M>,
            <M key="n">@agentgate/buyer-agent</M>,
            <span key="d">
              The LLM buyer decision loop: discover → decide → pay → retry. Uses Claude
              (<M>AnthropicLlm</M>) when <M>ANTHROPIC_API_KEY</M> is set, otherwise a deterministic{' '}
              <M>MockLlm</M>.
            </span>,
          ],
          [
            <M key="p">packages/cli</M>,
            <M key="n">@agentgate/cli</M>,
            <span key="d">
              The <M>agentgate</M> CLI: <M>wrap</M>, <M>list</M>, <M>status</M>, <M>pause</M>,{' '}
              <M>resume</M>, <M>demo-accounts</M>.
            </span>,
          ],
          [
            <M key="p">packages/oracle</M>,
            <M key="n">@agentgate/oracle</M>,
            'The demo RWA feed (USD/IDR + gold spot + confidence) used as a sample upstream API.',
          ],
          [
            <M key="p">packages/devnet</M>,
            <M key="n">@agentgate/devnet</M>,
            'In-memory mock chain HTTP server used by mock mode — mirrors the Odra registry rules offline.',
          ],
          [
            <M key="p">packages/client</M>,
            <M key="n">@agentgate/client</M>,
            <span key="d">
              The agent-side <M>fetchPaid</M> helper: parse the 402 invoice → pay → retry with
              proof headers.
            </span>,
          ],
          [
            <M key="p">dashboard</M>,
            <M key="n">dashboard</M>,
            'The Next.js app: landing page, service catalog, live activity feed and these docs.',
          ],
          [
            <M key="p">contracts/agentgate-registry</M>,
            <M key="n">Rust / Odra</M>,
            'The on-chain AgentGateRegistry: service discovery, scores and payment attestations.',
          ],
          [
            <M key="p">contracts/spend-guard</M>,
            <M key="n">Rust / Odra</M>,
            'SpendGuard — an on-chain x402 spend-firewall escrow that atomically reverts payments breaking an agent budget policy.',
          ],
        ]}
      />
      <Callout tone="info" title="Workspaces vs contracts">
        Only <M>packages/*</M> and <M>dashboard</M> are npm workspaces — they are installed and
        type-checked by <M>npm install</M> / <M>npm run typecheck</M>. The two{' '}
        <M>contracts/</M> crates are separate Rust/Odra projects with their own Cargo manifests and
        are not part of the Node install at all.
      </Callout>

      <H2 id="modes">Modes — mock vs live</H2>
      <P>
        The <M>AGENTGATE_MODE</M> environment variable (default <M>mock</M>) selects the chain
        backend behind the <M>ChainClient</M> seam. Everything above that seam — the gateway, CLI,
        buyer agent and dashboard — is byte-for-byte identical in both modes.
      </P>
      <DocTable
        head={['Aspect', 'mock', 'live (Casper Testnet)']}
        rows={[
          [
            'Chain backend',
            <span key="m">
              In-memory <M>@agentgate/devnet</M>
            </span>,
            'casper-js-sdk v5 + CSPR.cloud REST',
          ],
          [
            'What you need',
            'Nothing — every value has a default',
            <span key="l">
              <M>CSPR_CLOUD_API_KEY</M> and a non-default <M>AGENTGATE_ADMIN_TOKEN</M> (config
              refuses the default in live)
            </span>,
          ],
          [
            'Signers',
            'Mock account strings (faucet-funded)',
            <span key="l">
              PEM keys: <M>GATE_SIGNER_PEM_PATH</M>, <M>BUYER_SIGNER_PEM_PATH</M>,{' '}
              <M>SELLER_SIGNER_PEM_PATH</M>
            </span>,
          ],
          [
            'Payment verify',
            'Devnet transfer lookup',
            'CSPR.cloud transfer lookup by deploy hash',
          ],
          [
            'Registry',
            'Devnet mirrors the Odra contract rules',
            <span key="l">
              The deployed <M>AgentGateRegistry</M> contract (<M>REGISTRY_CONTRACT_PACKAGE_HASH</M>)
            </span>,
          ],
          [
            'Guardrails',
            'Default admin token OK, SSRF guard off',
            'Default token refused, SSRF guard on',
          ],
        ]}
      />
      <Callout tone="warn" title="Live mode is not yet deployable end to end">
        Live mode requires <M>CSPR_CLOUD_API_KEY</M>, PEM signer keys, and a deployed registry
        contract whose package hash you set in <M>REGISTRY_CONTRACT_PACKAGE_HASH</M>. Because the
        contract deploy is out of scope for this build, there is no published package hash yet —
        live calls that need the registry are gated until one exists. Use{' '}
        <M>AGENTGATE_MODE=mock</M> for everything in these docs.
      </Callout>
      <P>
        The full mode matrix, guardrails and every variable are documented in{' '}
        <DocLink href="/docs/configuration">Configuration</DocLink>.
      </P>

      <H2 id="env-file">Environment file</H2>
      <P>
        A commented template with every variable lives at <M>.env.example</M> in the repo root.
        Copy it to <M>.env</M> to start customizing; mock mode works with the file untouched
        because every value already has a sensible default.
      </P>
      <CommandBlock prompt={null} text="cp .env.example .env" />
      <P>
        Empty and whitespace-only values are treated as unset (the default applies), so you only
        need to fill in the variables you actually change. The most common ones to set:
      </P>
      <DocTable
        head={['Variable', 'Default', 'When to set it']}
        rows={[
          [
            <M key="v">AGENTGATE_MODE</M>,
            <M key="d">mock</M>,
            <span key="w">
              Set to <M>live</M> to target Casper Testnet.
            </span>,
          ],
          [
            <M key="v">ANTHROPIC_API_KEY</M>,
            <span key="d">(unset)</span>,
            <span key="w">
              Set to let the buyer agent use Claude; unset uses the deterministic{' '}
              <M>MockLlm</M>.
            </span>,
          ],
          [
            <M key="v">AGENTGATE_ADMIN_TOKEN</M>,
            <M key="d">dev-admin-token</M>,
            'Must be changed in live mode — config refuses the default.',
          ],
          [
            <M key="v">CSPR_CLOUD_API_KEY</M>,
            <span key="d">(unset)</span>,
            'Required only in live mode.',
          ],
        ]}
      />
      <P>
        For the complete matrix — ports, invoice TTL, upstream timeout, log level, proxy hops,
        node URLs, signer paths and oracle/buyer-agent tuning — see{' '}
        <DocLink href="/docs/configuration">Configuration</DocLink>.
      </P>

      <H2 id="verify">Verify your install</H2>
      <P>
        Three commands prove a clean install works. Run them from the repo root; all run offline
        in mock mode and need no keys.
      </P>

      <H3 id="verify-test">Run the test suite</H3>
      <CommandBlock prompt={null} text="npm test" />
      <P>
        Runs <M>vitest</M> across every package unit suite plus the end-to-end loop — 274 tests.
        A clean install passes all of them.
      </P>
      <CodeBlock
        label="expected (abbreviated)"
        code={'Test Files  17 passed (17)\n     Tests  274 passed (274)\n  Duration  ...s'}
      />

      <H3 id="verify-typecheck">Type-check the workspace</H3>
      <CommandBlock prompt={null} text="npm run typecheck" />
      <P>
        Runs <M>tsc --noEmit</M> in every package and the dashboard, plus the root{' '}
        <M>scripts/</M> and <M>e2e/</M> sources. The whole monorepo is TypeScript strict mode
        (with <M>noUncheckedIndexedAccess</M>), so a green typecheck means zero type errors
        anywhere. Success prints no errors.
      </P>

      <H3 id="verify-demo">Run the one-shot demo</H3>
      <CommandBlock prompt={null} text="npm run demo" />
      <P>
        The fastest end-to-end proof. It boots the devnet, oracle and middleware in-process,
        creates faucet-funded demo accounts, wraps the oracle as a service, runs the buyer agent
        once, records the attestation on-chain, prints both transaction hashes — and exits 0. The
        data is ephemeral (gone when the process exits), so it will not appear in the dashboard;
        use <M>npm run dev:seed</M> for that.
      </P>
      <CodeBlock
        label="what npm run demo prints (abbreviated)"
        code={'DEMO COMPLETE — full loop verified on the mock chain\n  payment deploy hash : <full_deploy_hash>\n  attestation tx hash : <full_tx_hash>\n  amount paid         : 0.5 CSPR\n  final score         : 1/1 (success/total)'}
      />
      <Callout tone="ok" title="Install verified">
        Green <M>npm test</M>, a clean <M>npm run typecheck</M>, and a <M>npm run demo</M> that
        exits 0 with two transaction hashes confirm the install is healthy. Optionally, run the 17
        contract tests with <M>cd contracts/agentgate-registry &amp;&amp; cargo odra test</M> if
        you have the Rust toolchain installed.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/sellers', label: 'Wrap an API' },
          { href: '/docs/configuration', label: 'Configuration' },
        ]}
      />
    </>
  );
}
