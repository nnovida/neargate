import type { Metadata } from 'next';
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
  title: 'Docs — Configuration',
  description:
    'Every AgentGate environment variable — names, defaults, modes, validation — plus the mock/live guardrails and the ports table.',
};

export default function ConfigurationPage() {
  return (
    <>
      <DocHeader
        kicker="docs / configuration"
        title="Configuration"
        lede="All configuration is environment variables, loaded once by loadConfig() in @agentgate/shared. Every value has a working mock-mode default — a clean clone runs with zero setup. Validation failures throw CONFIG_INVALID with a precise message."
      />
      <P>
        A commented template with every variable lives at <M>.env.example</M> in the repo root.
        Empty and whitespace-only values are treated as unset (the default applies).
      </P>

      <H2 id="mode">Mode selection</H2>
      <DocTable
        head={['Variable', 'Default', 'Rules', 'Purpose']}
        rows={[
          [
            <M key="v">AGENTGATE_MODE</M>,
            <M key="d">mock</M>,
            <span key="r">
              <M>mock</M> or <M>live</M>
            </span>,
            'Selects the chain backend: in-memory devnet vs Casper Testnet via node RPC + CSPR.cloud.',
          ],
        ]}
      />

      <H2 id="ports">Ports</H2>
      <DocTable
        head={['Variable', 'Default', 'Service']}
        rows={[
          [<M key="v">DEVNET_PORT</M>, <M key="d">4030</M>, 'Mock chain HTTP server.'],
          [<M key="v">ORACLE_PORT</M>, <M key="d">4010</M>, 'RWA feed server.'],
          [
            <M key="v">MIDDLEWARE_PORT</M>,
            <M key="d">4021</M>,
            <span key="d">
              402 paywall gateway; also feeds the default <M>--gateway</M> of{' '}
              <DocLink href="/docs/cli#wrap">agentgate wrap</DocLink>.
            </span>,
          ],
          [
            <M key="v">DASHBOARD_PORT</M>,
            <M key="d">3000</M>,
            'Next.js dashboard — the actual port may shift if 3000 is busy (check the terminal output).',
          ],
        ]}
      />
      <P>All ports are validated to the 0–65535 range; out of range throws CONFIG_INVALID.</P>

      <H2 id="mock">Mock mode</H2>
      <DocTable
        head={['Variable', 'Default', 'Purpose']}
        rows={[
          [
            <M key="v">DEVNET_URL</M>,
            <M key="d">http://localhost:4030</M>,
            <span key="d">
              Mock chain base URL — auto-derived from <M>DEVNET_PORT</M> if not set.
            </span>,
          ],
          [
            <M key="v">MOCK_BUYER_ACCOUNT</M>,
            <M key="d">&apos;&apos;</M>,
            <span key="d">
              Buyer mock public key (<M>01</M> + 64 hex) — set by{' '}
              <DocLink href="/docs/cli#demo-accounts">agentgate demo-accounts</DocLink>.
            </span>,
          ],
          [
            <M key="v">MOCK_SELLER_ACCOUNT</M>,
            <M key="d">&apos;&apos;</M>,
            <span key="d">
              Seller mock public key used by <M>agentgate wrap</M> in mock mode.
            </span>,
          ],
        ]}
      />

      <H2 id="middleware">Middleware</H2>
      <DocTable
        head={['Variable', 'Default', 'Rules', 'Purpose']}
        rows={[
          [
            <M key="v">AGENTGATE_ADMIN_TOKEN</M>,
            <M key="d">dev-admin-token</M>,
            'refused in live mode',
            <span key="d">
              Bearer token for <M>POST /admin/services</M> — see{' '}
              <DocLink href="/docs/api#admin">HTTP API → Admin</DocLink>.
            </span>,
          ],
          [
            <M key="v">INVOICE_TTL_MS</M>,
            <M key="d">300000</M>,
            '1 ≤ x ≤ MAX_SAFE_INTEGER',
            'Invoice/nonce validity window (5 minutes) — also bounds the accepted transfer age.',
          ],
          [
            <M key="v">UPSTREAM_TIMEOUT_MS</M>,
            <M key="d">30000</M>,
            '1 ≤ x ≤ MAX_SAFE_INTEGER',
            'Proxy timeout for upstream API calls.',
          ],
        ]}
      />

      <H2 id="live">Live mode (Casper Testnet)</H2>
      <DocTable
        head={['Variable', 'Default', 'Purpose']}
        rows={[
          [
            <M key="v">CASPER_NODE_URL</M>,
            <M key="d">https://node.testnet.casper.network/rpc</M>,
            'Casper node RPC endpoint.',
          ],
          [
            <M key="v">CSPR_CLOUD_API_URL</M>,
            <M key="d">https://api.testnet.cspr.cloud</M>,
            'CSPR.cloud API endpoint (transfer verification).',
          ],
          [
            <M key="v">CSPR_CLOUD_API_KEY</M>,
            <M key="d">&apos;&apos;</M>,
            <span key="d">
              <strong className="text-white">Required in live mode</strong> — get one at
              console.cspr.cloud. Sent as a raw token (no “Bearer” prefix).
            </span>,
          ],
          [
            <M key="v">CSPR_CLOUD_STREAMING_URL</M>,
            <M key="d">wss://streaming.testnet.cspr.cloud</M>,
            'WebSocket endpoint for event streaming.',
          ],
          [
            <M key="v">CASPER_NETWORK</M>,
            <M key="d">casper-test</M>,
            'Network/chain name string.',
          ],
          [
            <M key="v">REGISTRY_CONTRACT_PACKAGE_HASH</M>,
            <M key="d">&apos;&apos;</M>,
            <span key="d">
              <M>hash-&lt;64hex&gt;</M> after deploy. Empty ⇒ every registry path throws{' '}
              <M>NOT_DEPLOYED</M> — see{' '}
              <DocLink href="/docs/contract#deploy-status">Contract → Deploy status</DocLink>.
            </span>,
          ],
          [
            <M key="v">GATE_SIGNER_PEM_PATH</M>,
            <M key="d">&apos;&apos;</M>,
            'PEM key for the middleware/attestor (live attestations).',
          ],
          [
            <M key="v">BUYER_SIGNER_PEM_PATH</M>,
            <M key="d">&apos;&apos;</M>,
            'PEM key for the buyer agent.',
          ],
          [
            <M key="v">SELLER_SIGNER_PEM_PATH</M>,
            <M key="d">&apos;&apos;</M>,
            <span key="d">
              PEM key for the CLI — required to run <M>agentgate wrap</M> in live mode.
            </span>,
          ],
        ]}
      />

      <H2 id="llm">LLM (buyer agent)</H2>
      <DocTable
        head={['Variable', 'Default', 'Purpose']}
        rows={[
          [
            <M key="v">ANTHROPIC_API_KEY</M>,
            <M key="d">&apos;&apos;</M>,
            'Optional. If set, the buyer agent uses Claude (AnthropicLlm); otherwise the deterministic MockLlm.',
          ],
          [
            <M key="v">LLM_MODEL</M>,
            <M key="d">claude-sonnet-4-6</M>,
            'Model id — only used when ANTHROPIC_API_KEY is set.',
          ],
        ]}
      />

      <H2 id="oracle-agent">Oracle &amp; buyer agent</H2>
      <DocTable
        head={['Variable', 'Default', 'Rules', 'Purpose']}
        rows={[
          [
            <M key="v">ORACLE_STATIC</M>,
            <M key="d">0</M>,
            <span key="r">
              <M>0</M>/<M>1</M>/<M>true</M>/<M>false</M>
            </span>,
            <span key="d">
              <M>1</M> = serve the deterministic fixture (used by <M>npm run demo</M>) instead
              of live sources.
            </span>,
          ],
          [
            <M key="v">BUYER_BUDGET_CSPR</M>,
            <M key="d">5</M>,
            'non-negative CSPR decimal, max 9 dp',
            <span key="d">
              Default max spend per buyer-agent run; must pass <M>csprToMotes()</M> (rejects
              negatives, exponents, &gt; 9 decimals, non-numeric).
            </span>,
          ],
        ]}
      />

      <H2 id="guardrails">Mock/live guardrails</H2>
      <P>
        <M>loadConfig()</M> enforces these invariants and throws{' '}
        <M>AgentGateError(&apos;CONFIG_INVALID&apos;, …, 500)</M> on violation:
      </P>
      <DocTable
        head={['Guardrail', 'Error message / behavior']}
        rows={[
          [
            <span key="g">
              <M>AGENTGATE_MODE</M> must be <M>mock</M> or <M>live</M>
            </span>,
            'CONFIG_INVALID on anything else.',
          ],
          [
            'Live mode requires a CSPR.cloud key',
            <span key="d">
              “live mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)”
            </span>,
          ],
          [
            'Live mode refuses the default admin token',
            <span key="d">
              “live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique token”
            </span>,
          ],
          [
            'URLs must parse with an allowed protocol',
            <span key="d">
              <M>http:</M>, <M>https:</M>, <M>ws:</M>, <M>wss:</M> only.
            </span>,
          ],
          ['Ports must be 0–65535', 'CONFIG_INVALID with min/max shown.'],
          [
            <span key="g">
              <M>BUYER_BUDGET_CSPR</M> must convert to motes
            </span>,
            'CONFIG_INVALID with a hint about mote precision.',
          ],
        ]}
      />

      <H2 id="env-example">.env.example at a glance</H2>
      <CodeBlock
        label=".env.example (repo root)"
        code={`AGENTGATE_MODE=mock
DEVNET_PORT=4030
ORACLE_PORT=4010
MIDDLEWARE_PORT=4021
DASHBOARD_PORT=3000
DEVNET_URL=http://localhost:4030
AGENTGATE_ADMIN_TOKEN=dev-admin-token        # MUST be changed in live mode
INVOICE_TTL_MS=300000
UPSTREAM_TIMEOUT_MS=30000
CASPER_NODE_URL=https://node.testnet.casper.network/rpc
CSPR_CLOUD_API_URL=https://api.testnet.cspr.cloud
CSPR_CLOUD_API_KEY=
CSPR_CLOUD_STREAMING_URL=wss://streaming.testnet.cspr.cloud
CASPER_NETWORK=casper-test
REGISTRY_CONTRACT_PACKAGE_HASH=
GATE_SIGNER_PEM_PATH=
BUYER_SIGNER_PEM_PATH=
SELLER_SIGNER_PEM_PATH=
ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-6
ORACLE_STATIC=0
BUYER_BUDGET_CSPR=5
MOCK_BUYER_ACCOUNT=
MOCK_SELLER_ACCOUNT=`}
      />
      <Callout tone="info" title="money validation everywhere">
        Any CSPR amount anywhere in the system (prices, budgets) allows at most 9 decimal
        places — 1 mote = 1e-9 CSPR — and is processed as a bigint-backed decimal string. See{' '}
        <DocLink href="/docs/protocol#money">Protocol → Money units</DocLink>.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/quickstart', label: 'Quickstart' },
          { href: '/docs/api', label: 'HTTP API' },
          { href: '/docs/contract', label: 'Smart contract' },
        ]}
      />
    </>
  );
}
