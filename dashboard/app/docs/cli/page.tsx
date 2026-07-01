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
  title: 'CLI',
  description:
    'Reference for the agentgate CLI: wrap, list, status, pause, resume and demo-accounts. Every flag, argument, default and example output, verified against packages/cli/src/bin.ts.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="CLI"
        lede="The agentgate CLI publishes services, inspects the on-chain catalog, toggles a service you own, and mints faucet-funded demo accounts."
      />

      {/* ───────────────────────────── invocation ───────────────────────────── */}
      <H2 id="invocation">Invocation</H2>
      <P>
        Run the CLI from the repo root through the workspace script. Everything after the{' '}
        <M>--</M> is forwarded verbatim to the <M>agentgate</M> binary:
      </P>
      <CommandBlock text="npm run agentgate -- <command> [args] [options]" />
      <P>
        The underlying entry point is <M>packages/cli/src/bin.ts</M> (a <M>commander</M>{' '}
        program named <M>agentgate</M>). If you have the workspace binary on your{' '}
        <M>PATH</M> you can invoke it directly instead:
      </P>
      <CommandBlock text="agentgate <command> [args] [options]" />
      <P>
        There are six commands: <DocLink href="#wrap">wrap</DocLink>,{' '}
        <DocLink href="#list">list</DocLink>, <DocLink href="#status">status</DocLink>,{' '}
        <DocLink href="#pause">pause</DocLink>, <DocLink href="#resume">resume</DocLink> and{' '}
        <DocLink href="#demo-accounts">demo-accounts</DocLink>. Every command exits{' '}
        <M>0</M> on success and <M>1</M> on error; failures print to stderr as{' '}
        <M>error: &lt;CODE&gt;: &lt;message&gt;</M>.
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
            default: 'mock',
            desc: (
              <>
                Selects the chain backend. <M>mock</M> uses the in-process devnet (offline);{' '}
                <M>live</M> targets Casper Testnet and additionally requires{' '}
                <M>CSPR_CLOUD_API_KEY</M>.
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
                Bearer token for the gateway admin mapping <M>POST &lt;gateway&gt;/admin/services</M>{' '}
                used by <M>wrap</M>. Live mode refuses the shipped default.
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
                Feeds the default <M>--gateway</M> (<M>http://localhost:&lt;MIDDLEWARE_PORT&gt;</M>).
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
                Feeds the printed dashboard detail link in <M>wrap</M> output
                (<M>http://localhost:&lt;DASHBOARD_PORT&gt;/services/&lt;id&gt;</M>).
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

      {/* ───────────────────────────── wrap ───────────────────────────── */}
      <H2 id="wrap">wrap</H2>
      <P>
        Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain. The
        upstream URL is kept private — it is only sent to the gateway admin API, never to the
        registry. <M>wrap</M> performs two steps: it registers the service on-chain first,
        then POSTs the <M>{'{serviceId, upstreamUrl}'}</M> mapping to{' '}
        <M>&lt;gateway&gt;/admin/services</M>.
      </P>
      <CommandBlock
        wrap
        text='npm run agentgate -- wrap <upstreamUrl> --price <cspr> --name <name> [options]'
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
            'Price per call in CSPR (e.g. 0.5), up to 9 decimal places. A malformed value (non-numeric or >9 dp) fails with INVALID_AMOUNT; a non-positive value fails with INVALID_PRICE. Stored as motes on-chain.',
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
            <M key="gd">http://localhost:&lt;MIDDLEWARE_PORT&gt;</M>,
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
      <H3 id="wrap-example">Example</H3>
      <CommandBlock
        wrap
        text='npm run agentgate -- wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"'
      />
      <CodeBlock
        label="output"
        code={[
          'service id:      1',
          'public endpoint: http://localhost:4021/svc/1',
          'dashboard:       http://localhost:3000/services/1',
          'register tx:     <txHash>',
        ].join('\n')}
      />
      <Callout tone="warn" title="The on-chain registration is never rolled back">
        <P>
          Step 1 (registration) and step 2 (gateway mapping) are independent. If the gateway
          mapping fails, the service is already registered on-chain. <M>wrap</M> prints a
          warning with the exact retry curl to stderr (it references{' '}
          <M>$AGENTGATE_ADMIN_TOKEN</M> rather than inlining the secret), and the success
          output gains a final line:
        </P>
        <CodeBlock
          code={'note: gateway upstream mapping FAILED — see the warning above for the retry curl.'}
        />
        <P>
          Until the mapping exists, <M>http://localhost:4021/svc/1</M> will 404.
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
        chain returns it. Takes no arguments and no options.
      </P>
      <CommandBlock text="npm run agentgate -- list" />
      <CodeBlock
        label="output"
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

      {/* ───────────────────────────── status ───────────────────────────── */}
      <H2 id="status">status</H2>
      <P>
        Show one service in depth: the full record, its score, trust tier and recent
        attestations.
      </P>
      <CommandBlock text="npm run agentgate -- status <id>" />
      <DocTable
        head={['Argument', 'Required', 'Rule']}
        rows={[
          [
            <M key="i">{'<id>'}</M>,
            'yes',
            'Positive integer (1-based). A non-numeric or < 1 value throws INVALID_SERVICE_ID; an id with no on-chain record throws SERVICE_NOT_FOUND.',
          ],
        ]}
      />
      <CodeBlock
        label="output"
        code={[
          'service:        #1 Gold Spot Feed',
          'description:    USD spot gold with confidence',
          'endpoint:       http://localhost:4021/svc/1',
          'price:          0.5 CSPR',
          'payment target: account-hash-<64hex>',
          'owner:          01<publicKeyHex>',
          'attestor:       01<publicKeyHex>',
          'trust:          reliable (9/10 calls ok)',
          'attestations (latest 10):',
          '  [ok  ] 2026-06-12T10:30:05.123Z  payment a1b2c3d4e5f6  tx b2c3d4e5f6a1',
          '  [FAIL] 2026-06-12T09:14:44.001Z  payment 9f8e7d6c5b4a  tx 8e7d6c5b4a39',
        ].join('\n')}
      />
      <P>
        At most 10 attestations are shown (<M>STATUS_ATTESTATION_LIMIT</M>), newest first, each
        prefixed <M>[ok  ]</M> or <M>[FAIL]</M>. With none, it prints{' '}
        <M>attestations:   none yet</M> and stops. An inactive service is tagged{' '}
        <M>[INACTIVE]</M> after its name, and the <M>description:</M> line is omitted when the
        description is empty.
      </P>

      {/* ───────────────────────────── pause ───────────────────────────── */}
      <H2 id="pause">pause</H2>
      <P>
        Pause a service you own: signs the registry&apos;s{' '}
        <M>set_active(service_id, false)</M> on-chain (owner only), then re-fetches the record
        and prints the new state. While paused the gateway answers 403 on{' '}
        <M>/svc/&lt;id&gt;</M> and the catalog shows it as inactive. The score is untouched.
      </P>
      <CommandBlock text="npm run agentgate -- pause <id>" />
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
        <M>MOCK_SELLER_ACCOUNT</M> (mock) or <M>SELLER_SIGNER_PEM_PATH</M> (live). If the
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
      <CommandBlock text="npm run agentgate -- resume <id>" />
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
        <M>POST &lt;DEVNET_URL&gt;/faucet</M>. Takes no arguments or options.
      </P>
      <CommandBlock text="npm run agentgate -- demo-accounts" />
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

      {/* ───────────────────────────── errors ───────────────────────────── */}
      <H2 id="error-codes">Error codes</H2>
      <P>
        Errors are printed as <M>error: &lt;CODE&gt;: &lt;message&gt;</M> and exit{' '}
        <M>1</M>. The codes you are most likely to hit:
      </P>
      <DocTable
        head={['Code', 'Status', 'Command(s)', 'Cause']}
        rows={[
          [<M key="c1">INVALID_PRICE</M>, '400', 'wrap', 'Price is not greater than 0 CSPR.'],
          [<M key="c2">INVALID_INPUT</M>, '400', 'wrap', 'Empty/blank name, or text with control characters or over the length limit.'],
          [<M key="c3">INVALID_URL</M>, '400', 'wrap', 'upstreamUrl / gateway is not a valid http(s) URL (or carries a query/fragment).'],
          [<M key="c4">INSECURE_URL</M>, '400', 'wrap', 'Live mode + non-localhost gateway over http:// (would leak the admin token).'],
          [<M key="c5">INVALID_ACCOUNT_HASH</M>, '400', 'wrap', '--payment-target is not account-hash-<64 hex>.'],
          [<M key="c6">INVALID_PUBLIC_KEY</M>, '400', 'wrap', '--attestor is not a valid Casper public key hex.'],
          [<M key="c7">SIGNER_MISSING</M>, '400', 'wrap / pause / resume', 'Mock mode missing MOCK_SELLER_ACCOUNT, or live mode missing SELLER_SIGNER_PEM_PATH.'],
          [<M key="c8">INVALID_SERVICE_ID</M>, '400', 'status / pause / resume', 'Service id is not a positive integer.'],
          [<M key="c9">SERVICE_NOT_FOUND</M>, '404', 'status / pause / resume', 'No on-chain record for that id.'],
          [<M key="c10">not_authorized</M>, '403', 'pause / resume', 'Signing key is not the service owner.'],
          [<M key="c11">MOCK_ONLY</M>, '400', 'demo-accounts', 'Run in live mode (set AGENTGATE_MODE=mock).'],
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
