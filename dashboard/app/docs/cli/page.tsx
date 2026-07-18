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
  PropList,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/cli' },
  title: 'CLI',
  description:
    'Reference for the agentgate CLI: wrap, buy, list, status, pause, resume, demo-accounts and mcp. Every flag, argument, default and example output, verified against packages/cli/src/bin.ts.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="FOR SELLERS"
        title="CLI"
        lede="The agentgate CLI publishes services, buys one paid call to any of them, inspects the on-chain catalog, toggles a service you own, mints faucet-funded demo accounts, and serves AgentGate as an MCP server for agent frameworks."
      />

      {/* ───────────────────────────── invocation ───────────────────────────── */}
      <H2 id="invocation">Invocation</H2>
      <P>The published CLI runs with <M>npx</M> — no install, no clone:</P>
      <CommandBlock text="npx @neargate/cli@latest <command> [args] [options]" />
      <P>
        From a cloned repo you can run it through the workspace script instead (everything after the{' '}
        <M>--</M> is forwarded verbatim to the <M>agentgate</M> binary), or invoke the binary
        directly if it is on your <M>PATH</M>:
      </P>
      <CommandBlock text="npm run agentgate -- <command> [args] [options]" />
      <CommandBlock text="agentgate <command> [args] [options]" />
      <P>
        The entry point is <M>packages/cli/src/bin.ts</M> (a <M>commander</M> program named{' '}
        <M>agentgate</M>). There are eight commands: <DocLink href="#wrap">wrap</DocLink>,{' '}
        <DocLink href="#buy">buy</DocLink>, <DocLink href="#list">list</DocLink>,{' '}
        <DocLink href="#status">status</DocLink>, <DocLink href="#pause">pause</DocLink>,{' '}
        <DocLink href="#resume">resume</DocLink>,{' '}
        <DocLink href="#demo-accounts">demo-accounts</DocLink> and{' '}
        <DocLink href="#mcp">mcp</DocLink>. Every command exits{' '}
        <M>0</M> on success and <M>1</M> on error; AgentGate failures print to stderr as{' '}
        <M>error: &lt;CODE&gt;: &lt;message&gt;</M> (usage mistakes are reported by the
        argument parser without a code).
      </P>

      {/* ───────────────────────────── environment ───────────────────────────── */}
      <H2 id="environment">Environment &amp; flags it reads</H2>
      <P>
        Every command calls <M>loadConfig()</M>, but each config value can be supplied as a{' '}
        <strong>flag or an environment variable</strong> — precedence is{' '}
        <M>flag &gt; env var &gt; built-in default</M>. The published CLI defaults to{' '}
        <M>live</M> mode and the deployed registry hash, so <M>list</M> and <M>status</M> read
        Casper Testnet with no configuration at all; <M>--mode</M>, <M>--node-url</M>,{' '}
        <M>--registry</M>, <M>--pem</M>, <M>--admin-token</M> and <M>--api-key</M> override the
        matching env vars. The table below covers only what the commands here touch; the full
        list lives in <DocLink href="/docs/configuration">Configuration</DocLink>.
      </P>
      <PropList
        items={[
          {
            name: 'AGENTGATE_MODE',
            type: "'mock' | 'live'",
            required: false,
            default: 'live',
            desc: (
              <>
                Selects the chain backend. <M>mock</M> uses the in-process devnet (offline);{' '}
                <M>live</M> targets Casper Testnet. Reads (<M>list</M>, <M>status</M>) need
                no keys; <M>CSPR_CLOUD_API_KEY</M> (via <M>--api-key</M>) is only used to
                fetch attestation history in <M>status</M>.
              </>
            ),
          },
          {
            name: 'MOCK_SELLER_ACCOUNT',
            type: 'string',
            required: false,
            default: '(empty)',
            desc: (
              <>
                Seller/owner signer public key used in <M>mock</M> mode by{' '}
                <M>wrap</M>, <M>pause</M> and <M>resume</M>. Empty &rarr;{' '}
                <M>SIGNER_MISSING</M>. Populate it from <DocLink href="#demo-accounts">demo-accounts</DocLink>.
              </>
            ),
          },
          {
            name: 'SELLER_SIGNER_PEM_PATH',
            type: 'string (path)',
            required: false,
            default: '(empty)',
            desc: (
              <>
                Path to the seller key PEM used in <M>live</M> mode by <M>wrap</M>,{' '}
                <M>pause</M> and <M>resume</M>. Empty &rarr; <M>SIGNER_MISSING</M>.
              </>
            ),
          },
          {
            name: 'AGENTGATE_ADMIN_TOKEN',
            type: 'string',
            required: false,
            default: 'dev-admin-token',
            desc: (
              <>
                Bearer token for the legacy admin mapping{' '}
                <M>POST &lt;gateway&gt;/admin/services</M>, used by <M>wrap</M> in{' '}
                <M>mock</M> mode or against a self-hosted admin gateway. Live wrap does not
                use it — it maps the upstream with an owner-signed request to{' '}
                <M>&lt;gateway&gt;/services/&lt;id&gt;/map</M> instead.
              </>
            ),
          },
          {
            name: 'MIDDLEWARE_PORT',
            type: 'number',
            required: false,
            default: '4021',
            desc: (
              <>
                Feeds the default <M>--gateway</M> in <M>mock</M> mode
                (<M>http://localhost:&lt;MIDDLEWARE_PORT&gt;</M>); <M>live</M> mode defaults{' '}
                <M>--gateway</M> to the hosted <M>https://gateway.example.org</M>.
              </>
            ),
          },
          {
            name: 'DASHBOARD_PORT',
            type: 'number',
            required: false,
            default: '3000',
            desc: (
              <>
                Feeds the dashboard detail link printed by <M>wrap</M> in <M>mock</M> mode
                (<M>http://localhost:&lt;DASHBOARD_PORT&gt;/services/&lt;id&gt;</M>); <M>live</M>{' '}
                mode links to the hosted{' '}
                <M>https://agentgate.example.org/services/&lt;id&gt;</M>.
              </>
            ),
          },
          {
            name: 'DEVNET_URL',
            type: 'string (url)',
            required: false,
            default: 'http://localhost:4030',
            desc: (
              <>
                Mock devnet base URL the faucet is called on by <M>demo-accounts</M> (derived
                from <M>DEVNET_PORT</M>, default <M>4030</M>).
              </>
            ),
          },
        ]}
      />

      <H3 id="config-flags">Config flags</H3>
      <P>
        Each of these overrides the matching environment variable (<M>flag &gt; env &gt; default</M>).{' '}
        <M>--mode</M>, <M>--node-url</M> and <M>--registry</M> are accepted by all eight commands; the
        signer and key flags are read only by the commands that need them.
      </P>
      <DocTable
        head={['Flag', 'Overrides', 'Default', 'Used by']}
        rows={[
          [<M key="f1">--mode {'<mock|live>'}</M>, <M key="e1">AGENTGATE_MODE</M>, <M key="d1">live</M>, 'all commands'],
          [
            <M key="f2">--node-url {'<url>'}</M>,
            <M key="e2">CASPER_NODE_URL</M>,
            <M key="d2">https://node.testnet.casper.network/rpc</M>,
            'all commands',
          ],
          [
            <M key="f3">--registry {'<hash>'}</M>,
            <M key="e3">REGISTRY_CONTRACT_PACKAGE_HASH</M>,
            <span key="d3"><M>hash-10f92725…</M> (the deployed package)</span>,
            'all commands',
          ],
          [
            <M key="f4">--pem {'<path>'}</M>,
            <M key="e4">SELLER_SIGNER_PEM_PATH</M>,
            <M key="d4">(none)</M>,
            'wrap, pause, resume (live writes); for buy and mcp it means the buyer key (env: BUYER_SIGNER_PEM_PATH)',
          ],
          [
            <M key="f5">--admin-token {'<token>'}</M>,
            <M key="e5">AGENTGATE_ADMIN_TOKEN</M>,
            <M key="d5">dev-admin-token</M>,
            'wrap (mock / self-hosted admin)',
          ],
          [
            <M key="f6">--api-key {'<key>'}</M>,
            <M key="e6">CSPR_CLOUD_API_KEY</M>,
            <M key="d6">(none)</M>,
            'status (attestation history)',
          ],
        ]}
      />
      <Callout tone="warn" title="Secrets on the command line">
        <M>--pem</M> is a path (safe), but <M>--admin-token</M> and <M>--api-key</M> put the secret
        itself into shell history and <M>ps</M> output. Prefer the environment variable for those two
        in any shared or CI environment.
      </Callout>

      {/* ───────────────────────────── wrap ───────────────────────────── */}
      <H2 id="wrap">wrap</H2>
      <P>
        Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain. The
        upstream URL is kept private — it is only sent to the gateway mapping API, never to the
        registry. <M>wrap</M> performs two steps: it registers the service on-chain first,
        then maps the upstream on the gateway. In live mode this is a self-service call —{' '}
        <M>wrap</M> signs an ownership challenge with the seller key and POSTs{' '}
        <M>{'{upstreamUrl, publicKeyHex, timestamp, signatureHex}'}</M> to{' '}
        <M>&lt;gateway&gt;/services/&lt;id&gt;/map</M> (no admin token). Mock mode and
        self-hosted admin gateways use the legacy <M>POST &lt;gateway&gt;/admin/services</M>{' '}
        with <M>AGENTGATE_ADMIN_TOKEN</M> instead.
      </P>
      <CommandBlock
        wrap
        text='npx @neargate/cli@latest wrap <upstreamUrl> --price <cspr> --name <name> --pem <path> [options]'
      />
      <DocTable
        head={['Flag / arg', 'Required', 'Default', 'Meaning']}
        rows={[
          [
            <M key="a">{'<upstreamUrl>'}</M>,
            'yes',
            '—',
            'Positional. Upstream API URL to wrap (kept private). Must be a valid http:// or https:// URL.',
          ],
          [
            <M key="p">--price {'<cspr>'}</M>,
            'yes',
            '—',
            'Price per call in CSPR (e.g. 0.5), up to 9 decimal places. A malformed value (non-numeric, negative, or >9 dp) fails with INVALID_AMOUNT; a price of 0 fails with INVALID_PRICE. Stored as motes on-chain.',
          ],
          [<M key="n">--name {'<name>'}</M>, 'yes', '—', 'Service name. Non-empty, no control characters, ≤ 128 chars.'],
          [
            <M key="d">--description {'<d>'}</M>,
            'no',
            <M key="dd">&apos;&apos; (empty)</M>,
            'Service description. No control characters, ≤ 512 chars.',
          ],
          [
            <M key="g">--gateway {'<url>'}</M>,
            'no',
            <M key="gd">https://gateway.example.org (live) · http://localhost:&lt;MIDDLEWARE_PORT&gt; (mock)</M>,
            'Gateway base URL (this base is what gets stored on-chain; readers compute <base>/svc/<id>). No query/fragment; https required for non-localhost hosts in live mode.',
          ],
          [
            <M key="t">--payment-target {'<accountHash>'}</M>,
            'no',
            'derived from the seller signer',
            <span key="td">
              Account-hash that receives payment. Must match <M>account-hash-&lt;64 hex&gt;</M>.
            </span>,
          ],
          [
            <M key="x">--attestor {'<publicKeyHex>'}</M>,
            'no',
            'the seller signer public key',
            <span key="xd">
              Public key allowed to record attestations. Casper hex (<M>01</M>+64 hex or{' '}
              <M>02</M>+66 hex).
            </span>,
          ],
        ]}
      />
      <P>
        <M>wrap</M> also reads the <DocLink href="#config-flags">config flags</DocLink> — most
        importantly <M>--pem</M> (required for live writes) and <M>--admin-token</M> (mock or
        self-hosted admin mapping).
      </P>
      <H3 id="wrap-example">Example</H3>
      <CommandBlock
        wrap
        text='npx @neargate/cli@latest wrap https://api.example.com/gold --price 2.5 --name "Gold Spot Feed" --pem ./key.pem'
      />
      <CodeBlock
        label="output"
        code={[
          'service id:      5',
          'public endpoint: https://gateway.example.org/svc/5',
          'dashboard:       https://agentgate.example.org/services/5',
          'register tx:     <txHash>',
        ].join('\n')}
      />
      <Callout tone="warn" title="The on-chain registration is never rolled back">
        <P>
          Step 1 (registration) and step 2 (gateway mapping) are independent. If the gateway
          mapping fails, the service is already registered on-chain, and the success output
          gains a final line:
        </P>
        <CodeBlock
          code={'note: gateway upstream mapping FAILED — see the warning above for the retry curl.'}
        />
        <P>
          The printed retry hint depends on the path: mock or self-hosted-admin wrap prints a
          runnable curl referencing <M>$AGENTGATE_ADMIN_TOKEN</M>; live (<M>--pem</M>) wrap
          prints no curl (the note&apos;s wording is shared with the admin path) — the mapping
          must be re-created by re-POSTing a fresh owner-signed challenge to{' '}
          <M>&lt;gateway&gt;/services/&lt;id&gt;/map</M>; see{' '}
          <DocLink href="/docs/sellers#ts-admin-map-failed">recovering a failed mapping</DocLink>.
          Do not re-run <M>wrap</M> — it registers a duplicate service. Until the mapping
          exists, the <M>/svc/&lt;id&gt;</M> endpoint will 404.
        </P>
      </Callout>
      <H3 id="wrap-signer">Signer it reads</H3>
      <P>
        The seller signer is resolved from the environment by mode: <M>MOCK_SELLER_ACCOUNT</M>{' '}
        in mock mode, <M>SELLER_SIGNER_PEM_PATH</M> in live mode. Either being empty throws{' '}
        <M>SIGNER_MISSING</M>. When omitted, <M>--payment-target</M> defaults to the account
        hash derived from this signer and <M>--attestor</M> defaults to its public key.
      </P>

      {/* ───────────────────────────── list ───────────────────────────── */}
      <H2 id="list">list</H2>
      <P>
        List the on-chain service catalog joined with scores and trust tiers, in the order the
        chain returns it. Takes no arguments and no command-specific options; the shared{' '}
        <DocLink href="#config-flags">config flags</DocLink> (<M>--mode</M>, <M>--node-url</M>,{' '}
        <M>--registry</M>) still apply.
      </P>
      <CommandBlock text="npx @neargate/cli@latest list" />
      <CodeBlock
        label="output (illustrative — your table shows the live catalog)"
        code={[
          'ID  NAME                  PRICE     TIER      SCORE  ACTIVE  ENDPOINT',
          '1   Gold Spot Feed        0.5 CSPR  reliable  9/10   yes     http://localhost:4021/svc/1',
          '2   Sentiment Feed        1 CSPR    new       2/2    no      http://localhost:4021/svc/2',
        ].join('\n')}
      />
      <P>
        Columns are <M>ID</M>, <M>NAME</M>, <M>PRICE</M>, <M>TIER</M>,{' '}
        <M>SCORE</M> (<M>successCalls/totalCalls</M>), <M>ACTIVE</M> (<M>yes</M>/<M>no</M>) and
        the computed <M>ENDPOINT</M>. When the registry is empty it prints a single hint line
        instead of a table:
      </P>
      <CodeBlock
        code={'no services registered yet — wrap one with `agentgate wrap <upstreamUrl> --price 0.5 --name "My API"`'}
      />
      <Callout tone="info" title="Trust tiers">
        Tiers are derived from the score (see <M>packages/shared/src/trust.ts</M>):{' '}
        <M>new</M> when fewer than 5 total calls; <M>reliable</M> at 5+ calls with a{' '}
        &ge; 90% success ratio; <M>trusted</M> at 25+ calls with a &ge; 95% success ratio.
        Malformed scores stay <M>new</M>.
      </Callout>

      {/* ───────────────────────────── buy ───────────────────────────── */}
      <H2 id="buy">buy</H2>
      <P>
        Buy one call to a service: run the full x402 exchange — request, receive the{' '}
        <M>402</M> invoice, pay it with a native CSPR transfer carrying the nonce as{' '}
        <M>transfer_id</M>, retry with the <M>X-PAYMENT</M> proof — and print the result. The
        response body goes to <strong className="text-white">stdout</strong> (pipeable);
        payment metadata (service, price, payment hash, settlement, status) goes to{' '}
        <strong className="text-white">stderr</strong>. No contract call is involved, and no
        new deployment is needed — payment is a plain native transfer.
      </P>
      <CommandBlock
        wrap
        text="npx @neargate/cli@latest buy <id> --pem <path> [--max <cspr>] [--method <m>] [--body <json>] [--gateway <url>]"
      />
      <DocTable
        head={['Flag / arg', 'Required', 'Default', 'Meaning']}
        rows={[
          [
            <M key="i">{'<id>'}</M>,
            'yes',
            '—',
            'Positional. Service id (1-based, as shown by `agentgate list`).',
          ],
          [
            <M key="m">--max {'<cspr>'}</M>,
            'no',
            'unlimited',
            'Budget cap: refuse to pay any invoice priced above this many CSPR. Checked twice — against the on-chain price before any HTTP, and against the 402 invoice before paying (PRICE_EXCEEDED).',
          ],
          [
            <M key="me">--method {'<m>'}</M>,
            'no',
            <M key="med">GET</M>,
            'HTTP method for the paid request.',
          ],
          [
            <M key="b">--body {'<json>'}</M>,
            'no',
            '—',
            'JSON request body, sent with content-type application/json on both legs. Validated up front (INVALID_INPUT) — the gateway rejects non-JSON bodies before charging.',
          ],
          [
            <M key="g">--gateway {'<url>'}</M>,
            'no',
            "the service's on-chain endpoint",
            'Gateway base URL override; the paid request goes to <base>/svc/<id>.',
          ],
          [
            <M key="pm">--pem {'<path>'}</M>,
            'live mode',
            <M key="pmd">BUYER_SIGNER_PEM_PATH</M>,
            'Buyer signer PEM path. For buy, --pem means the buyer key — SELLER_SIGNER_PEM_PATH is never read.',
          ],
        ]}
      />
      <P>
        Fail-fast guards run <em>before</em> any payment: unknown service (
        <M>SERVICE_NOT_FOUND</M>), paused service (<M>SERVICE_INACTIVE</M>), price above{' '}
        <M>--max</M> (<M>PRICE_EXCEEDED</M>), malformed body (<M>INVALID_INPUT</M>).{' '}
        <M>buy</M> pays exactly the invoice&apos;s <M>maxAmountRequired</M> and never overpays;
        Casper&apos;s ~2.5 CSPR native-transfer floor therefore means invoices below it cannot
        settle on this rail — target services priced ≥ 2.5 CSPR.
      </P>
      <H3 id="buy-example">Example</H3>
      <CommandBlock wrap text="npx @neargate/cli@latest buy 5 --pem ./buyer.pem --max 3" />
      <CodeBlock
        label="stderr (payment metadata) — the response body arrives on stdout"
        code={[
          'service:  #5 RWA FX & Gold Oracle',
          'url:      https://gateway.example.org/svc/5',
          'paid:     2.5 CSPR',
          'payment:  <deployHash>',
          'explorer: https://testnet.cspr.live/transaction/<deployHash>',
          'settled:  ok  (payer account-hash-…)',
          'status:   200',
        ].join('\n')}
      />
      <H3 id="buy-signer">Signer it reads</H3>
      <P>
        The buyer signer is resolved per mode: <M>MOCK_BUYER_ACCOUNT</M> in mock mode (run{' '}
        <DocLink href="#demo-accounts">demo-accounts</DocLink> first), and{' '}
        <M>--pem</M> or <M>BUYER_SIGNER_PEM_PATH</M> in live mode. Note that for <M>buy</M>{' '}
        the <M>--pem</M> flag means the <em>buyer</em> key — it does not touch{' '}
        <M>SELLER_SIGNER_PEM_PATH</M>.
      </P>

      {/* ───────────────────────────── status ───────────────────────────── */}
      <H2 id="status">status</H2>
      <P>
        Show one service in depth: the full record, its score, trust tier and recent
        attestations.
      </P>
      <CommandBlock text="npx @neargate/cli@latest status <id> [--api-key <key>]" />
      <DocTable
        head={['Argument / flag', 'Required', 'Rule']}
        rows={[
          [
            <M key="i">{'<id>'}</M>,
            'yes',
            'Positive integer (1-based). A non-numeric or < 1 value throws INVALID_SERVICE_ID; an id with no on-chain record throws SERVICE_NOT_FOUND.',
          ],
          [
            <M key="k">--api-key {'<key>'}</M>,
            'no',
            'CSPR.cloud key used only to fetch attestation history (overrides CSPR_CLOUD_API_KEY). Without it, the record, score and tier still print but attestation history is skipped.',
          ],
        ]}
      />
      <CodeBlock
        label="output — default, no key (illustrative)"
        code={[
          'service:        #1 Gold Spot Feed',
          'description:    USD spot gold with confidence',
          'endpoint:       http://localhost:4021/svc/1',
          'price:          0.5 CSPR',
          'payment target: account-hash-<64hex>',
          'owner:          account-hash-<64hex>',
          'attestor:       account-hash-<64hex>',
          'trust:          reliable (9/10 calls ok)',
          'attestations:   (set CSPR_CLOUD_API_KEY or pass --api-key to view history)',
        ].join('\n')}
      />
      <P>
        In <M>mock</M> mode <M>owner</M> and <M>attestor</M> print as public-key hex; the live
        contract stores addresses, so live mode prints <M>account-hash-…</M> for both.
      </P>
      <P>
        The record, score and trust tier always print with no keys. Attestation history is the one
        part that needs a <DocLink href="#config-flags">CSPR.cloud key</DocLink>: without{' '}
        <M>--api-key</M> (or <M>CSPR_CLOUD_API_KEY</M>) the last line is the hint above and the
        command stops. Pass the key to fetch the newest attestations:
      </P>
      <CodeBlock
        label="output — with --api-key"
        code={[
          'trust:          reliable (9/10 calls ok)',
          'attestations (latest 10):',
          '  [ok  ] 2026-06-12T10:30:05.123Z  payment a1b2c3d4e5f6  tx b2c3d4e5f6a1',
          '  [FAIL] 2026-06-12T09:14:44.001Z  payment 9f8e7d6c5b4a  tx 8e7d6c5b4a39',
        ].join('\n')}
      />
      <P>
        At most 10 attestations are shown (<M>STATUS_ATTESTATION_LIMIT</M>), newest first, each
        prefixed <M>[ok  ]</M> or <M>[FAIL]</M>; with a key but no attestations yet it prints{' '}
        <M>attestations:   none yet</M>. An inactive service is tagged <M>[INACTIVE]</M> after its
        name, and the <M>description:</M> line is omitted when the description is empty.
      </P>

      {/* ───────────────────────────── pause ───────────────────────────── */}
      <H2 id="pause">pause</H2>
      <P>
        Pause a service you own: signs the registry&apos;s{' '}
        <M>set_active(service_id, false)</M> on-chain (owner only), then re-fetches the record
        and prints the new state. While paused the gateway answers 403 on{' '}
        <M>/svc/&lt;id&gt;</M> and the catalog shows it as inactive. The score is untouched.
      </P>
      <CommandBlock text="npx @neargate/cli@latest pause <id> --pem <path>" />
      <DocTable
        head={['Argument', 'Required', 'Rule']}
        rows={[
          [
            <M key="i">{'<id>'}</M>,
            'yes',
            'Positive integer. Bad id → INVALID_SERVICE_ID; unknown id → SERVICE_NOT_FOUND; signed by a non-owner key → not_authorized (403).',
          ],
        ]}
      />
      <CodeBlock
        label="output"
        code={[
          'service:       #2 Sentiment Feed',
          'active:        no (paused)',
          'set_active tx: <txHash>',
        ].join('\n')}
      />
      <P>
        Like <M>wrap</M>, <M>pause</M> resolves the owner signer from{' '}
        <M>MOCK_SELLER_ACCOUNT</M> (mock) or <M>SELLER_SIGNER_PEM_PATH</M> / <M>--pem</M> (live). If the
        signing key is not the service owner, the chain&apos;s 403 is reworded into a clear
        owner-only <M>not_authorized</M> error.
      </P>

      {/* ───────────────────────────── resume ───────────────────────────── */}
      <H2 id="resume">resume</H2>
      <P>
        Resume a paused service you own: signs <M>set_active(service_id, true)</M> on-chain.
        Same argument rules, owner-only check and signer resolution as <M>pause</M>. Calls flow
        through the paywall again and discovery shows the service on the next catalog read.
      </P>
      <CommandBlock text="npx @neargate/cli@latest resume <id> --pem <path>" />
      <DocTable
        head={['Argument', 'Required', 'Rule']}
        rows={[
          [
            <M key="i">{'<id>'}</M>,
            'yes',
            'Positive integer. Same rules as pause: INVALID_SERVICE_ID / SERVICE_NOT_FOUND / not_authorized.',
          ],
        ]}
      />
      <CodeBlock
        label="output"
        code={[
          'service:       #2 Sentiment Feed',
          'active:        yes',
          'set_active tx: <txHash>',
        ].join('\n')}
      />

      {/* ───────────────────────────── demo-accounts ───────────────────────────── */}
      <H2 id="demo-accounts">demo-accounts</H2>
      <P>
        Create faucet-funded buyer/seller demo accounts on the mock devnet. This command is{' '}
        <strong className="text-white">mock mode only</strong>: in live mode it throws{' '}
        <M>MOCK_ONLY</M>. It generates a buyer and a seller mock public key (<M>01</M> + 64
        random hex chars from 32 CSPRNG bytes) and faucets 1000 CSPR to each via{' '}
        <M>POST &lt;DEVNET_URL&gt;/faucet</M>, so it needs a local mock devnet running
        (<M>npm run dev</M>). Since the CLI defaults to <M>live</M>, pass <M>--mode mock</M>.
      </P>
      <CommandBlock text="npx @neargate/cli@latest demo-accounts --mode mock" />
      <CodeBlock
        label="output"
        code={[
          'buyer:  01<publicKeyHex>  (1000 CSPR)',
          'seller: 01<publicKeyHex>  (1000 CSPR)',
          '',
          '# paste into your shell (used by the buyer agent and `agentgate wrap`):',
          'export MOCK_BUYER_ACCOUNT=01<publicKeyHex>',
          'export MOCK_SELLER_ACCOUNT=01<publicKeyHex>',
        ].join('\n')}
      />
      <P>
        Paste the two <M>export</M> lines into your shell:{' '}
        <M>MOCK_SELLER_ACCOUNT</M> is what <M>wrap</M>, <M>pause</M> and <M>resume</M> sign
        with, and <M>MOCK_BUYER_ACCOUNT</M> is used by the buyer agent. The devnet must be
        running (e.g. <M>npm run dev</M>); otherwise the faucet call fails with{' '}
        <M>FAUCET_UNREACHABLE</M> or, on a hang, <M>GATEWAY_TIMEOUT</M>.
      </P>

      {/* ───────────────────────────── mcp ───────────────────────────── */}
      <H2 id="mcp">mcp</H2>
      <P>
        Serve AgentGate as a <strong className="text-white">Model Context Protocol</strong> stdio
        server, so any MCP-capable agent (Claude Desktop, a custom client, an MCP-aware framework)
        gets the discover → inspect → pay loop as native tools. It speaks JSON-RPC over
        stdin/stdout and stays alive until the client closes the connection.
      </P>
      <CommandBlock text="npx @neargate/cli@latest mcp [--pem <path>]" />
      <P>
        Four tools are registered. The three read tools need no key and — because the published
        CLI defaults to live Testnet — work with zero configuration; only <M>agentgate_buy</M>{' '}
        spends CSPR and needs a buyer signer.
      </P>
      <DocTable
        head={['Tool', 'Arguments', 'What it does']}
        rows={[
          [
            <M key="t1">agentgate_list_services</M>,
            <M key="a1">—</M>,
            'Discover the live on-chain catalog: every service with price, trust tier, payment-backed score, active flag and endpoint. Read-only, no key.',
          ],
          [
            <M key="t2">agentgate_get_service</M>,
            <M key="a2">id</M>,
            'Full on-chain detail for one service id — price, payment target, owner, attestor, active flag, score and tier. Read-only.',
          ],
          [
            <M key="t3">agentgate_get_invoice</M>,
            <M key="a3">id</M>,
            'The machine-readable HTTP 402 invoice (price, nonce, payTo, network) WITHOUT paying, so an agent can decide before it spends. Read-only.',
          ],
          [
            <M key="t4">agentgate_buy</M>,
            <M key="a4">id (+ maxCspr, method, body)</M>,
            'Pay the service’s 402 invoice with a native CSPR transfer and return the response body. Spends real CSPR from the buyer key, capped by maxCspr; refuses unknown/paused services and over-cap invoices before any payment.',
          ],
        ]}
      />
      <P>
        <M>--pem</M> (or <M>BUYER_SIGNER_PEM_PATH</M>) supplies the <em>buyer</em> signer used only
        by <M>agentgate_buy</M> — the read tools ignore it, so <M>mcp</M> starts fine with no key.
        On start the server prints a readiness line to <strong className="text-white">stderr</strong>
        (v0.1.4); <M>stdout</M> is the JSON-RPC channel, so nothing else is ever written there.
      </P>
      <H3 id="mcp-claude-desktop">Claude Desktop</H3>
      <P>
        Wire it into <M>claude_desktop_config.json</M>. No <M>env</M> block is needed — the CLI
        already defaults to live Testnet and the deployed registry:
      </P>
      <CodeBlock
        label="claude_desktop_config.json"
        code={'{ "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "@neargate/cli", "mcp"] } } }'}
      />
      <Callout tone="info" title="Inspect it in 30s — no MCP client">
        From any shell you can drive the server directly: the repo ships{' '}
        <M>scripts/mcp.sh</M> (<M>list</M> / <M>service &lt;id&gt;</M> / <M>invoice &lt;id&gt;</M>),
        and the README&apos;s &ldquo;For judges / reviewers&rdquo; block has a copy-paste{' '}
        <M>npx … mcp</M> one-liner that returns the live catalog with zero setup.
      </Callout>

      {/* ───────────────────────────── errors ───────────────────────────── */}
      <H2 id="error-codes">Error codes</H2>
      <P>
        Errors are printed as <M>error: &lt;CODE&gt;: &lt;message&gt;</M> and exit{' '}
        <M>1</M>. The codes you are most likely to hit:
      </P>
      <DocTable
        head={['Code', 'Status', 'Command(s)', 'Cause']}
        rows={[
          [<M key="c0">CONFIG_INVALID</M>, '500', 'all commands', 'A config value failed validation before the command ran — e.g. --mode is neither mock nor live, or a port/URL env var is malformed.'],
          [<M key="c15">INVALID_AMOUNT</M>, '400', 'wrap', '--price is not a plain decimal (non-numeric, negative, exponent, or more than 9 decimal places).'],
          [<M key="c1">INVALID_PRICE</M>, '400', 'wrap', 'Price is not greater than 0 CSPR.'],
          [<M key="c2">INVALID_INPUT</M>, '400', 'wrap / buy', 'wrap: empty/blank name, or text with control characters or over the length limit. buy: --body is not valid JSON.'],
          [<M key="c3">INVALID_URL</M>, '400', 'wrap', 'upstreamUrl or gateway is not a valid http(s) URL; gateway additionally must not carry a query string or fragment (upstreamUrl may).'],
          [<M key="c4">INSECURE_URL</M>, '400', 'wrap', 'Live mode + non-localhost gateway over http:// (the signed mapping request must not travel in cleartext).'],
          [<M key="c5">INVALID_ACCOUNT_HASH</M>, '400', 'wrap', '--payment-target is not account-hash-<64 hex>.'],
          [<M key="c6">INVALID_PUBLIC_KEY</M>, '400', 'wrap', '--attestor is not a valid Casper public key hex.'],
          [<M key="c7">SIGNER_MISSING</M>, '400', 'wrap / buy / pause / resume', 'Seller commands: missing MOCK_SELLER_ACCOUNT (mock) or SELLER_SIGNER_PEM_PATH (live). buy: missing MOCK_BUYER_ACCOUNT (mock) or --pem / BUYER_SIGNER_PEM_PATH (live).'],
          [<M key="c8">INVALID_SERVICE_ID</M>, '400', 'buy / status / pause / resume', 'Service id is not a positive integer.'],
          [<M key="c9">SERVICE_NOT_FOUND</M>, '404', 'buy / status / pause / resume', 'No on-chain record for that id.'],
          [<M key="c16">SERVICE_INACTIVE</M>, '403', 'buy', 'The service is paused by its owner — refused before any payment.'],
          [<M key="c17">PRICE_EXCEEDED</M>, '402', 'buy', 'The on-chain price or the 402 invoice exceeds --max. No payment is sent.'],
          [<M key="c10">not_authorized</M>, '403', 'pause / resume', 'Signing key is not the service owner.'],
          [<M key="c11">MOCK_ONLY</M>, '400', 'demo-accounts', 'Invoked while the mode is live — pass --mode mock (or set AGENTGATE_MODE=mock).'],
          [<M key="c12">FAUCET_UNREACHABLE</M>, '502', 'demo-accounts', 'Cannot reach the devnet faucet (devnet not running).'],
          [<M key="c13">FAUCET_FAILED</M>, '502', 'demo-accounts', 'Faucet returned non-200, non-JSON, or a malformed balanceMotes.'],
          [<M key="c14">GATEWAY_TIMEOUT</M>, '504', 'demo-accounts', 'Faucet request timed out.'],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/sellers', label: 'Wrap an API' },
          { href: '/docs/api', label: 'HTTP API' },
        ]}
      />
    </>
  );
}
