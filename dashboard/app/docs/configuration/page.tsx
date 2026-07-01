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
  title: 'Configuration',
  description:
    'Complete reference for every AgentGate environment variable: names, defaults, validation rules, which are required in live mode, and the loadConfig() guardrails that refuse an unsafe live configuration.',
};

export default function ConfigurationPage() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Configuration"
        lede="Every AgentGate setting is an environment variable read once by loadConfig() in @agentgate/shared. This page documents exactly what that function reads, its defaults, its validation, and which values are mandatory in live mode."
      />

      <P>
        All configuration is environment variables — there is no config file. A single function,
        <M>loadConfig(env = process.env)</M> in <M>packages/shared/src/config.ts</M>, is the source
        of truth: it reads each variable, validates it, applies defaults, and returns a validated
        <M>AgentGateConfig</M>. Every value has a working <M>mock</M>-mode default, so a fresh clone
        runs with zero setup. A commented template listing every variable lives at
        <M>.env.example</M> in the repo root.
      </P>
      <P>
        Two cross-cutting rules apply to <em>every</em> variable. First, empty and whitespace-only
        values count as <strong>unset</strong> — <M>readStr()</M> trims the raw value and falls back
        to the default when the result is the empty string. Second, any invalid value throws an
        <M>AgentGateError</M> with code <M>CONFIG_INVALID</M> and HTTP status <M>500</M>, carrying a
        precise message that names the offending variable and what was expected.

      </P>

      <H2 id="core">Core</H2>
      <P>
        <M>AGENTGATE_MODE</M> selects the chain backend. It is the one switch that changes how the
        whole system behaves and which other variables become mandatory.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Allowed', 'Meaning']}
        rows={[
          [
            <M key="v">AGENTGATE_MODE</M>,
            <M key="d">mock</M>,
            <span key="a">
              <M>mock</M> or <M>live</M>
            </span>,
            <span key="m">
              <M>mock</M> = in-process devnet, fully offline. <M>live</M> = Casper Testnet via node
              RPC + CSPR.cloud. Any other value throws <M>CONFIG_INVALID</M> (
              <M>AGENTGATE_MODE must be &quot;mock&quot; or &quot;live&quot;</M>).
            </span>,
          ],
        ]}
      />

      <H2 id="ports">Ports</H2>
      <P>
        Four service ports. Each is parsed by <M>readPort()</M> and validated to the inclusive range
        <M>0–65535</M>; a non-integer or out-of-range value throws <M>CONFIG_INVALID</M>.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Service']}
        rows={[
          [<M key="v">DEVNET_PORT</M>, <M key="d">4030</M>, 'Mock chain (in-process devnet) HTTP server.'],
          [<M key="v">ORACLE_PORT</M>, <M key="d">4010</M>, 'Oracle / RWA feed server.'],
          [
            <M key="v">MIDDLEWARE_PORT</M>,
            <M key="d">4021</M>,
            <span key="s">
              402 paywall gateway. For a self-hosted gateway, pass{' '}
              <M>--gateway http://localhost:4021</M> to{' '}
              <DocLink href="/docs/cli">agentgate wrap</DocLink>; the published CLI otherwise
              defaults <M>--gateway</M> to the hosted gateway.
            </span>,
          ],
          [
            <M key="v">DASHBOARD_PORT</M>,
            <M key="d">3000</M>,
            'Next.js dashboard. Next may shift to another port if 3000 is busy — watch the terminal output.',
          ],
        ]}
      />
      <P>
        <M>DEVNET_URL</M> is the base URL the rest of the system uses to reach the mock chain. It is
        not a fixed string default: if unset it is derived from <M>DEVNET_PORT</M> as
        <M>http://localhost:&lt;DEVNET_PORT&gt;</M>. It must be a valid <M>http:</M> or <M>https:</M>
        URL.
      </P>

      <H2 id="middleware">Middleware</H2>
      <P>
        Settings for the 402 gateway itself — auth, invoice lifetime, upstream timeout, and proxy
        trust.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Validation', 'Meaning']}
        rows={[
          [
            <M key="v">AGENTGATE_ADMIN_TOKEN</M>,
            <M key="d">dev-admin-token</M>,
            'refused in live mode',
            <span key="m">
              Bearer token for the admin API (e.g. <M>POST /admin/services</M>). The shipped default
              is <M>dev-admin-token</M> (exported as <M>DEFAULT_ADMIN_TOKEN</M>);{' '}
              <M>loadConfig()</M> throws if live mode is left on this value.
            </span>,
          ],
          [
            <M key="v">INVOICE_TTL_MS</M>,
            <M key="d">300000</M>,
            <span key="r">
              integer <M>1 … MAX_SAFE_INTEGER</M>
            </span>,
            'Invoice / nonce validity window in milliseconds (default 5 minutes). Also bounds the accepted age of an on-chain transfer.',
          ],
          [
            <M key="v">UPSTREAM_TIMEOUT_MS</M>,
            <M key="d">30000</M>,
            <span key="r">
              integer <M>1 … MAX_SAFE_INTEGER</M>
            </span>,
            'Timeout in milliseconds for the proxied request to the upstream API (default 30 seconds).',
          ],
          [
            <M key="v">TRUST_PROXY</M>,
            <M key="d">0</M>,
            <span key="r">
              integer <M>0 … 10</M>
            </span>,
            <span key="m">
              Number of trusted reverse-proxy hops in front of the gateway (Express{' '}
              <M>trust proxy</M>). <M>0</M> trusts none (<M>req.ip</M> is the direct socket peer).
              Behind a single platform proxy (Railway/Vercel) set <M>1</M> so rate limiting keys off
              the real client IP. Never set it higher than the real hop count, or{' '}
              <M>X-Forwarded-For</M> becomes spoofable.
            </span>,
          ],
        ]}
      />

      <H2 id="live-casper">Live mode &amp; Casper</H2>
      <P>
        These configure the Casper Testnet integration. They all have sensible Testnet defaults, but
        a few become <strong>mandatory</strong> the moment <M>AGENTGATE_MODE=live</M> (see the
        guardrails callout below). URLs are protocol-checked: the RPC and API endpoints must be
        <M>http:</M>/<M>https:</M>, the streaming endpoint must be <M>ws:</M>/<M>wss:</M>.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Required in live?', 'Meaning']}
        rows={[
          [
            <M key="v">CASPER_NODE_URL</M>,
            <M key="d">https://node.testnet.casper.network/rpc</M>,
            'no (has default)',
            'Casper node JSON-RPC endpoint. Must be a valid http/https URL.',
          ],
          [
            <M key="v">CSPR_CLOUD_API_URL</M>,
            <M key="d">https://api.testnet.cspr.cloud</M>,
            'no (has default)',
            'CSPR.cloud REST API base (used for transfer verification). Must be a valid http/https URL.',
          ],
          [
            <M key="v">CSPR_CLOUD_API_KEY</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            <strong key="r" className="text-white">
              yes
            </strong>,
            <span key="m">
              CSPR.cloud API key. Live mode refuses to start while this is empty (
              <M>get one at console.cspr.cloud</M>). Sent as a raw token — no <M>Bearer</M> prefix.
            </span>,
          ],
          [
            <M key="v">CSPR_CLOUD_STREAMING_URL</M>,
            <M key="d">wss://streaming.testnet.cspr.cloud</M>,
            'no (has default)',
            'CSPR.cloud WebSocket streaming endpoint. Must be a valid ws/wss URL.',
          ],
          [
            <M key="v">CASPER_NETWORK</M>,
            <M key="d">casper-test</M>,
            'no (has default)',
            'Network / chain name string used when constructing deploys. casper-test is Testnet.',
          ],
          [
            <M key="v">REGISTRY_CONTRACT_PACKAGE_HASH</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            'effectively (for registry use)',
            <span key="m">
              Package hash of the deployed AgentGateRegistry contract (<M>hash-&lt;64hex&gt;</M>).
              For Casper Testnet live mode set this to{' '}
              <M>hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9</M>. Not
              enforced by <M>loadConfig()</M>, but when left empty every live registry call returns{' '}
              <M>NOT_DEPLOYED</M> (fallback only — the registry is live on Testnet). See{' '}
              <DocLink href="/docs/contract">Smart contract</DocLink>.
            </span>,
          ],
          [
            <M key="v">GATE_SIGNER_PEM_PATH</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            'yes (to write attestations)',
            'Path to the PEM key for the middleware / attestor — signs live on-chain attestations. Needed for any live write from the gateway.',
          ],
          [
            <M key="v">BUYER_SIGNER_PEM_PATH</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            'yes (for the buyer agent)',
            'Path to the PEM key the buyer agent uses to sign its CSPR payment transfers in live mode.',
          ],
          [
            <M key="v">SELLER_SIGNER_PEM_PATH</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            'yes (for the CLI / seller)',
            'Path to the PEM key for the CLI / seller — required to run agentgate wrap (register a service) in live mode.',
          ],
        ]}
      />
      <Callout tone="info" title="Signer paths are not validated at load time">
        <M>loadConfig()</M> reads the three <M>*_PEM_PATH</M> values as plain strings and does not
        check that the files exist or parse — they are only consumed by the component that needs to
        sign. An empty path therefore loads fine; the failure surfaces later when that signer is
        actually used.
      </Callout>

      <H2 id="llm">LLM (buyer agent)</H2>
      <P>
        The buyer agent can reason with Claude or fall back to a deterministic mock. Selection is
        driven purely by whether <M>ANTHROPIC_API_KEY</M> is set: non-empty selects{' '}
        <M>AnthropicLlm</M>, empty selects <M>MockLlm</M>.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Required in live?', 'Meaning']}
        rows={[
          [
            <M key="v">ANTHROPIC_API_KEY</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            'no (optional)',
            'If set, the buyer agent uses Claude (AnthropicLlm). If empty, it uses the deterministic MockLlm — useful for offline demos and tests.',
          ],
          [
            <M key="v">LLM_MODEL</M>,
            <M key="d">claude-sonnet-4-6</M>,
            'no (optional)',
            'Model id passed to AnthropicLlm. Only consulted when ANTHROPIC_API_KEY is set; ignored under MockLlm.',
          ],
        ]}
      />

      <H2 id="oracle">Oracle</H2>
      <P>
        A single boolean controls the oracle feed source. It is parsed by <M>readBool01()</M>, which
        accepts <M>0</M>/<M>1</M> or <M>true</M>/<M>false</M> (case-insensitive); anything else
        throws <M>CONFIG_INVALID</M>.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Accepted', 'Meaning']}
        rows={[
          [
            <M key="v">ORACLE_STATIC</M>,
            <M key="d">0</M>,
            <span key="a">
              <M>0</M>/<M>1</M>/<M>true</M>/<M>false</M>
            </span>,
            <span key="m">
              <M>1</M> = serve deterministic fixture data (offline demo); <M>0</M> = serve from live
              sources.
            </span>,
          ],
        ]}
      />

      <H2 id="buyer">Buyer</H2>
      <P>
        One budget cap for a buyer-agent run. It is validated by passing it through{' '}
        <M>csprToMotes()</M>, which enforces the system-wide money rules.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Validation', 'Meaning']}
        rows={[
          [
            <M key="v">BUYER_BUDGET_CSPR</M>,
            <M key="d">5</M>,
            'non-negative CSPR decimal, max 9 dp',
            <span key="m">
              Maximum total CSPR the buyer agent may spend in one run. Must be a non-negative decimal
              string with at most 9 decimal places (1 mote = 1e-9 CSPR); negatives, exponents,{' '}
              <M>&gt; 9</M> decimals, or non-numeric values throw <M>CONFIG_INVALID</M>.
            </span>,
          ],
        ]}
      />

      <H2 id="mock-accounts">Mock accounts</H2>
      <P>
        Demo identities used only in <M>mock</M> mode. Both default to empty and are read as plain
        strings (no validation at load time).
      </P>
      <DocTable
        head={['Variable', 'Default', 'Meaning']}
        rows={[
          [
            <M key="v">MOCK_BUYER_ACCOUNT</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            <span key="m">
              Buyer mock public key (typically <M>01</M> + 64 hex). Populated by{' '}
              <DocLink href="/docs/cli">agentgate demo-accounts</DocLink>.
            </span>,
          ],
          [
            <M key="v">MOCK_SELLER_ACCOUNT</M>,
            <span key="d">
              <M>&apos;&apos;</M> (empty)
            </span>,
            <span key="m">
              Seller mock public key used by <M>agentgate wrap</M> in mock mode.
            </span>,
          ],
        ]}
      />

      <H2 id="logging">Logging</H2>
      <P>
        Log verbosity is read separately by the shared logger (<M>packages/shared/src/logger.ts</M>),
        not by <M>loadConfig()</M>. <M>createLogger()</M> reads <M>LOG_LEVEL</M> at construction
        time, lower-cases it, and falls back to <M>info</M> for any unrecognized value (it never
        throws). The logger also redacts fields whose key looks sensitive (token, api-key, password,
        pem, private-key, etc.) before writing each JSON line.
      </P>
      <DocTable
        head={['Variable', 'Default', 'Accepted', 'Meaning']}
        rows={[
          [
            <M key="v">LOG_LEVEL</M>,
            <M key="d">info</M>,
            <span key="a">
              <M>debug</M> / <M>info</M> / <M>warn</M> / <M>error</M>
            </span>,
            'Minimum level emitted (case-insensitive). Unknown values silently fall back to info — this variable cannot fail config loading.',
          ],
        ]}
      />

      <H2 id="live-guardrails">Live-mode guardrails</H2>
      <P>
        When <M>AGENTGATE_MODE=live</M>, <M>loadConfig()</M> runs extra checks after parsing and
        refuses to start on an unsafe configuration. These are the hard stops:
      </P>
      <Callout tone="warn" title="Live mode REFUSES to start when…">
        <P>
          <strong>The default admin token is still set.</strong> If{' '}
          <M>AGENTGATE_ADMIN_TOKEN</M> equals <M>dev-admin-token</M> (
          <M>DEFAULT_ADMIN_TOKEN</M>), it throws{' '}
          <M>
            live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique token
          </M>
          .
        </P>
        <P>
          <strong>The CSPR.cloud key is empty.</strong> If <M>CSPR_CLOUD_API_KEY</M> is empty it
          throws <M>live mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)</M>.
        </P>
        <P>
          <strong>Signers are missing.</strong> <M>GATE_SIGNER_PEM_PATH</M> (and the buyer/seller
          equivalents) are not validated by <M>loadConfig()</M> itself, but a live deployment cannot
          write attestations, pay, or register services without them — leaving{' '}
          <M>GATE_SIGNER_PEM_PATH</M> empty means the gateway has no key to sign on-chain
          attestations. Provide all three before going live.
        </P>
      </Callout>
      <DocTable
        head={['Guardrail', 'Where', 'Error / consequence']}
        rows={[
          [
            <span key="g">
              <M>AGENTGATE_MODE</M> must be <M>mock</M> or <M>live</M>
            </span>,
            'always',
            <span key="e">
              <M>CONFIG_INVALID</M> on any other value.
            </span>,
          ],
          [
            'CSPR.cloud key required',
            'live only',
            <span key="e">
              <M>CONFIG_INVALID</M> if <M>CSPR_CLOUD_API_KEY</M> is empty.
            </span>,
          ],
          [
            'Default admin token refused',
            'live only',
            <span key="e">
              <M>CONFIG_INVALID</M> if <M>AGENTGATE_ADMIN_TOKEN</M> is still <M>dev-admin-token</M>.
            </span>,
          ],
          [
            'URLs must parse with an allowed protocol',
            'always',
            <span key="e">
              <M>http:</M>/<M>https:</M> for RPC &amp; API, <M>ws:</M>/<M>wss:</M> for streaming.
            </span>,
          ],
          [
            'Ports in range',
            'always',
            <span key="e">
              <M>CONFIG_INVALID</M> unless <M>0 … 65535</M>.
            </span>,
          ],
          [
            <span key="g">
              <M>BUYER_BUDGET_CSPR</M> convertible to motes
            </span>,
            'always',
            <span key="e">
              <M>CONFIG_INVALID</M> with a precision hint if it fails <M>csprToMotes()</M>.
            </span>,
          ],
        ]}
      />

      <H2 id="env-example">.env.example at a glance</H2>
      <P>
        The repo-root template, reproduced here. Mock-mode defaults are filled in; live-only secrets
        are intentionally blank.
      </P>
      <CodeBlock
        label=".env.example (repo root)"
        code={
          'AGENTGATE_MODE=mock\n' +
          '# --- ports ---\n' +
          'DEVNET_PORT=4030\n' +
          'ORACLE_PORT=4010\n' +
          'MIDDLEWARE_PORT=4021\n' +
          'DASHBOARD_PORT=3000\n' +
          '# --- mock mode ---\n' +
          'DEVNET_URL=http://localhost:4030\n' +
          '# --- middleware ---\n' +
          'AGENTGATE_ADMIN_TOKEN=dev-admin-token   # MUST be changed in live mode\n' +
          'INVOICE_TTL_MS=300000\n' +
          'UPSTREAM_TIMEOUT_MS=30000\n' +
          'LOG_LEVEL=info                          # debug|info|warn|error\n' +
          'TRUST_PROXY=0                           # trusted reverse-proxy hops (set 1 behind one proxy)\n' +
          '# --- live mode (Casper Testnet) ---\n' +
          'CASPER_NODE_URL=https://node.testnet.casper.network/rpc\n' +
          'CSPR_CLOUD_API_URL=https://api.testnet.cspr.cloud\n' +
          'CSPR_CLOUD_API_KEY=\n' +
          'CSPR_CLOUD_STREAMING_URL=wss://streaming.testnet.cspr.cloud\n' +
          'CASPER_NETWORK=casper-test\n' +
          'REGISTRY_CONTRACT_PACKAGE_HASH=\n' +
          'GATE_SIGNER_PEM_PATH=                   # middleware/attestor key\n' +
          'BUYER_SIGNER_PEM_PATH=                  # buyer agent key\n' +
          'SELLER_SIGNER_PEM_PATH=                 # CLI / seller key\n' +
          '# --- LLM ---\n' +
          'ANTHROPIC_API_KEY=\n' +
          'LLM_MODEL=claude-sonnet-4-6\n' +
          '# --- oracle ---\n' +
          'ORACLE_STATIC=0                         # 1 = deterministic fixture data\n' +
          '# --- buyer agent ---\n' +
          'BUYER_BUDGET_CSPR=5\n' +
          '# --- demo accounts (mock mode only) ---\n' +
          'MOCK_BUYER_ACCOUNT=\n' +
          'MOCK_SELLER_ACCOUNT='
        }
      />
      <Callout tone="info" title="One rule for every CSPR amount">
        Any CSPR value anywhere in the system (prices, budgets) allows at most 9 decimal places — 1
        mote = 1e-9 CSPR — and is processed as a bigint-backed decimal string. See{' '}
        <DocLink href="/docs/protocol">Protocol → Money units</DocLink>.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/security', label: 'Security model' },
          { href: '/docs/deployment', label: 'Deploy to production' },
        ]}
      />
    </>
  );
}
