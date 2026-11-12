import type { Metadata } from 'next';
import { DEFAULT_DASHBOARD_URL, DEFAULT_GATEWAY_URL } from '@agentgate/shared';
import { CommandBlock } from '@/components/copy';
import { DEFAULT_EXPLORER_URL } from '@/lib/explorer';
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
  Sub,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/cli' },
  title: 'CLI & MCP',
  description:
    'Reference for the neargate CLI — wrap, map, list, buy, status, pause, resume, demo-accounts, escrow, agent-key and mcp — with every flag, the five MCP tools, the Claude Desktop setup and the error codes you can meet.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="USE NEARGATE"
        title="CLI & MCP"
        lede="The neargate CLI publishes services, buys one paid call to any of them (from a deposit or from a prepaid escrow), inspects the on-chain catalog, toggles a service you own, funds an escrow and mints restricted agent keys that can spend only that escrow, mints demo accounts on the offline devnet, and serves NearGate to agent frameworks as an MCP server."
      />

      {/* ───────────────────────────── invocation ───────────────────────────── */}
      <H2 id="invocation">Invocation</H2>
      <P>
        Nothing is published to npm: run the CLI from a clone of the repository. Everything after
        the <M>--</M> is forwarded to the <M>neargate</M> binary:
      </P>
      <CommandBlock text="npm run neargate -- <command> [args] [options]" />
      <P>
        The entry point is <M>packages/cli/src/bin.ts</M> (a <M>commander</M> program named{' '}
        <M>neargate</M>). <M>npm run build -w @neargate/cli</M> bundles it to{' '}
        <M>packages/cli/dist/bin.js</M>, which you can run with <M>node</M> directly — the form the{' '}
        <DocLink href="#mcp-claude-desktop">Claude Desktop</DocLink> config uses. There are eleven
        commands: <DocLink href="#wrap">wrap</DocLink>, <DocLink href="#map">map</DocLink>,{' '}
        <DocLink href="#list">list</DocLink>, <DocLink href="#buy">buy</DocLink>,{' '}
        <DocLink href="#status">status</DocLink>, <DocLink href="#pause">pause</DocLink>,{' '}
        <DocLink href="#resume">resume</DocLink>,{' '}
        <DocLink href="#demo-accounts">demo-accounts</DocLink>, <DocLink href="#escrow">escrow</DocLink>,{' '}
        <DocLink href="#agent-key">agent-key</DocLink> and <DocLink href="#mcp">mcp</DocLink>.
        Every command exits <M>0</M> on success and <M>1</M> on error; failures print one line to
        stderr, <M>error: &lt;CODE&gt;: &lt;message&gt;</M> (see{' '}
        <DocLink href="#error-codes">Error codes</DocLink>); a usage mistake is reported by the
        argument parser without a code.
      </P>

      {/* ───────────────────────────── environment ───────────────────────────── */}
      <H2 id="environment">Environment &amp; flags</H2>
      <P>
        Each setting can be a <strong>flag or an environment variable</strong>; precedence is{' '}
        <M>flag &gt; env var &gt; built-in default</M>. The CLI defaults to <M>live</M> mode, so{' '}
        <M>list</M> and <M>status</M> read NEAR testnet with no key; pass <M>--mode mock</M> (or set{' '}
        <M>AGENTGATE_MODE=mock</M>) to use the offline devnet from <M>npm run dev</M>.
      </P>
      <H3 id="config-flags">Config flags</H3>
      <P>Accepted by every command:</P>
      <PropList
        items={[
          {
            name: '--mode <mock|live>',
            type: 'AGENTGATE_MODE',
            default: 'live',
            desc: 'The chain backend: the offline devnet or NEAR.',
          },
          {
            name: '--rpc <url>',
            type: 'NEAR_RPC_URL',
            desc: 'The NEAR RPC. Default: the RPC of NEAR_NETWORK (testnet: https://rpc.testnet.near.org).',
          },
          {
            name: '--registry <contract id>',
            type: 'REGISTRY_CONTRACT_ID',
            desc: 'The registry contract account. Default: the shared default registry id; the badge at the top of each docs page shows it (not deployed until it is set).',
          },
          {
            name: '--admin-token <token>',
            type: 'AGENTGATE_ADMIN_TOKEN',
            default: 'dev-admin-token',
            desc: (
              <>
                Read by <M>wrap</M> in mock mode only. A flag lands in shell history and{' '}
                <M>ps</M>, so prefer the environment variable.
              </>
            ),
          },
        ]}
      />
      <H3 id="signer-flags">Signer flags and key resolution</H3>
      <P>
        Commands that write to the chain take the account to act as. The same two flags mean the{' '}
        <strong>seller</strong> on <M>wrap</M>, <M>map</M>, <M>pause</M> and <M>resume</M>, and the{' '}
        <strong>buyer</strong> on <M>buy</M>, <M>escrow</M>, <M>agent-key</M> and <M>mcp</M>.
      </P>
      <DocTable
        head={['Flag', 'Seller env', 'Buyer env']}
        rows={[
          [
            <M key="a">--account {'<id>'}</M>,
            <M key="a1">SELLER_ACCOUNT_ID</M>,
            <M key="a2">BUYER_ACCOUNT_ID</M>,
          ],
          [
            <M key="k">--key-file {'<path>'}</M>,
            <M key="k1">SELLER_KEY_PATH</M>,
            <M key="k2">BUYER_KEY_PATH</M>,
          ],
          [
            'no flag (a secret)',
            <M key="s1">SELLER_PRIVATE_KEY</M>,
            <M key="s2">BUYER_PRIVATE_KEY</M>,
          ],
        ]}
      />
      <P>
        In <strong>mock</strong> mode the account is <M>--account</M>, else{' '}
        <M>MOCK_SELLER_ACCOUNT</M> / <M>MOCK_BUYER_ACCOUNT</M> (print a pair with{' '}
        <DocLink href="#demo-accounts">demo-accounts</DocLink>); mock signers carry no key and{' '}
        <M>--key-file</M> is ignored with a note. In <strong>live</strong> mode the key is resolved
        before any chain call, first match wins:
      </P>
      <DocTable
        head={['Source, in order', 'Notes']}
        rows={[
          [
            <span key="r1">
              1 · <M>SELLER_PRIVATE_KEY</M> / <M>BUYER_PRIVATE_KEY</M>
            </span>,
            <span key="n1">
              An <M>ed25519:…</M> secret key. It wins over <M>--key-file</M>, and the CLI says so
              when both are set.
            </span>,
          ],
          [
            <span key="r2">
              2 · <M>--key-file</M>, else <M>SELLER_KEY_PATH</M> / <M>BUYER_KEY_PATH</M>
            </span>,
            <span key="n2">
              A near-cli credentials JSON (<M>account_id</M>, <M>public_key</M>,{' '}
              <M>private_key</M>) whose <M>account_id</M> must match the account.
            </span>,
          ],
          [
            <span key="r3">
              3 · <M>~/.near-credentials/&lt;network&gt;/&lt;account&gt;.json</M>
            </span>,
            'Where the near CLI keeps keys; npm run near:bootstrap writes it here.',
          ],
        ]}
      />
      <P>
        The CLI warns when a key file is readable by group or others (<M>chmod 600</M> it) and never
        prints key material.
      </P>
      <H3 id="other-env">Other variables</H3>
      <PropList
        items={[
          {
            name: 'NEAR_NETWORK',
            type: "'testnet' | 'mainnet'",
            required: false,
            default: 'testnet',
            desc: (
              <>
                Picks the default RPC and explorer and the <M>~/.near-credentials/&lt;network&gt;</M>{' '}
                folder. The published defaults and every example target testnet.
              </>
            ),
          },
          {
            name: 'NEAR_EXPLORER_URL',
            type: 'string (url)',
            required: false,
            default: DEFAULT_EXPLORER_URL,
            desc: (
              <>
                Base of the explorer link <M>buy</M> prints under its payment transaction, in live
                mode.
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
                Mock mode only: the default <M>wrap --gateway</M> is{' '}
                <M>http://localhost:&lt;MIDDLEWARE_PORT&gt;</M>.{' '}
                {DEFAULT_GATEWAY_URL === '' ? (
                  <>
                    In live mode there is no hosted default yet: pass <M>--gateway</M> (without it{' '}
                    <M>wrap</M> stops with <M>GATEWAY_REQUIRED</M>).
                  </>
                ) : (
                  <>
                    In live mode it is the shared <M>{DEFAULT_GATEWAY_URL}</M>.
                  </>
                )}
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
                Mock mode only: the dashboard link <M>wrap</M> prints is{' '}
                <M>http://localhost:&lt;DASHBOARD_PORT&gt;/services/&lt;id&gt;</M>.{' '}
                {DEFAULT_DASHBOARD_URL === '' ? (
                  <>In live mode there is no hosted dashboard yet, so <M>wrap</M> prints no link.</>
                ) : (
                  <>
                    In live mode it points at the shared <M>{DEFAULT_DASHBOARD_URL}</M>.
                  </>
                )}
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
                The offline devnet that mock mode reads and <M>demo-accounts</M> funds from (derived
                from <M>DEVNET_PORT</M>).
              </>
            ),
          },
        ]}
      />

      {/* ───────────────────────────── wrap ───────────────────────────── */}
      <H2 id="wrap">wrap</H2>
      <P>
        Registers a service on-chain and puts the 402 paywall in front of your API. The upstream URL
        is kept private: it is only ever sent to the gateway.
      </P>
      <CommandBlock
        wrap
        text={'npm run neargate -- wrap <upstreamUrl> --price <near> --name <name> [options]'}
      />
      <PropList
        items={[
          { name: '<upstreamUrl>', type: 'url', required: true, desc: 'The http(s) API to wrap.' },
          {
            name: '--price <near>',
            type: 'NEAR decimal',
            required: true,
            desc: (
              <>
                Price per call, at least <M>0.000001</M> NEAR (the registry minimum, else{' '}
                <M>INVALID_PRICE</M>). Buyers attach this plus the flat <M>0.002 NEAR</M> storage
                fee.
              </>
            ),
          },
          {
            name: '--name <name>',
            type: 'string',
            required: true,
            desc: 'Service name, at most 64 bytes (UTF-8), no control characters.',
          },
          {
            name: '--description <d>',
            type: 'string',
            required: false,
            desc: 'At most 280 bytes (UTF-8).',
          },
          {
            name: '--gateway <url>',
            type: 'url',
            required: false,
            desc: (
              <>
                Gateway base URL, stored on-chain (at most 200 bytes, no query string or fragment);
                readers derive the endpoint <M>&lt;gateway&gt;/svc/&lt;id&gt;</M>. Live mode needs{' '}
                <M>https://</M> unless the host is localhost (<M>INSECURE_URL</M>), and, while no
                hosted gateway default is set, the flag itself (<M>GATEWAY_REQUIRED</M>). Mock mode
                defaults to the local gateway.
              </>
            ),
          },
          {
            name: '--payment-target <account>',
            type: 'NEAR account id',
            required: false,
            default: 'the seller account',
            desc: 'The account that receives each price. Live mode checks it exists first (ACCOUNT_NOT_FOUND), because the registry forwards every price there.',
          },
          {
            name: '--attestor <account>',
            type: 'NEAR account id',
            required: false,
            default: 'the seller account',
            desc: 'The account allowed to record attestations besides the owner. In production this is the gateway’s account.',
          },
        ]}
      />
      <P>
        Plus the <DocLink href="#signer-flags">signer flags</DocLink> (seller) and{' '}
        <M>--admin-token</M>. The command validates everything and, in live mode, loads your key and
        checks the payment target <em>before</em> anything is sent; then it calls{' '}
        <M>register_service</M> (attaching the <M>0.12 NEAR</M> registration deposit) and maps the
        upstream on the gateway. In live mode the mapping is a request signed with your key — no
        shared admin token (see <DocLink href="/docs/security#self-map">the self-map signature</DocLink>);
        in mock mode it goes through the gateway’s admin route with the admin token.
      </P>
      <H3 id="wrap-example">Example</H3>
      <CodeBlock
        label="npm run neargate -- wrap http://localhost:4010/feed --price 0.5 --name &quot;RWA FX &amp; Gold Oracle&quot; --mode mock"
        code={[
          'service id:      1',
          'public endpoint: http://localhost:4021/svc/1',
          'dashboard:       http://localhost:3000/services/1',
          'register tx:     <tx hash>',
        ].join('\n')}
      />
      <Callout tone="warn" title="IF THE MAPPING FAILS, DO NOT RE-RUN WRAP">
        The registration is <em>not</em> rolled back when the gateway mapping fails: the service
        exists on-chain and its endpoint answers <M>503</M> until it is mapped. <M>wrap</M> prints
        the exact retry to stderr and notes the failure on stdout. Re-running <M>wrap</M> would
        register a duplicate; use <DocLink href="#map">map</DocLink> instead.
      </Callout>

      {/* ───────────────────────────── map ───────────────────────────── */}
      <H2 id="map">map</H2>
      <P>
        Re-sends only the signed mapping request of <M>wrap</M> for a service you already own; it
        never registers. Live mode only: in mock mode it refuses with <M>LIVE_ONLY</M> and prints
        the admin-route <M>curl</M> to use instead.
      </P>
      <CommandBlock wrap text="npm run neargate -- map <id> <upstreamUrl> --account <owner>" />
      <P>
        It reads the service on-chain, checks that your key’s account is its owner (
        <M>NOT_SERVICE_OWNER</M>) and maps at the gateway the registry records for it, printing{' '}
        <M>service id</M>, <M>gateway</M>, <M>public endpoint</M> and <M>mapping: ok</M>.
      </P>

      {/* ───────────────────────────── list ───────────────────────────── */}
      <H2 id="list">list</H2>
      <P>
        The on-chain catalog with scores and trust tiers. No key. The table goes to stdout (header
        included, so scripts can parse it); the empty-catalog hint goes to stderr.
      </P>
      <CommandBlock text="npm run neargate -- list" />
      <CodeBlock
        label="output"
        code={[
          'id  name                  price(NEAR)  calls  tier  active',
          '1   RWA FX & Gold Oracle  0.5          1/1    new   yes',
        ].join('\n')}
      />
      <P>
        <M>price(NEAR)</M> is the service price (each call also attaches the <M>0.002 NEAR</M>{' '}
        storage fee); <M>calls</M> is successful/total attested calls; <M>tier</M> is{' '}
        <M>new</M>, <M>reliable</M> or <M>trusted</M>.
      </P>

      {/* ───────────────────────────── buy ───────────────────────────── */}
      <H2 id="buy">buy</H2>
      <P>
        Buys one call: fetches the 402 invoice, pays it with a registry <M>pay</M> call (price + the
        storage fee attached), retries with the transaction as proof and prints the result. The
        response body goes to <strong className="text-white">stdout</strong> (pipeable); the receipt
        goes to <strong className="text-white">stderr</strong>.
      </P>
      <CommandBlock wrap text="npm run neargate -- buy <id> --account <buyer> --max <near> [--from-escrow | --gasless]" />
      <PropList
        items={[
          { name: '<id>', type: 'positive integer', required: true, desc: 'The service id (see list).' },
          {
            name: '--max <near>',
            type: 'NEAR decimal',
            required: false,
            desc: (
              <>
                Budget cap on the <strong>total</strong> attached — price + <M>0.002 NEAR</M> —
                checked before anything is paid (<M>BUDGET_EXCEEDED</M>). Without it there is no cap.
              </>
            ),
          },
          {
            name: '--from-escrow',
            type: 'flag',
            required: false,
            desc: (
              <>
                Pay out of your prepaid <DocLink href="#escrow">escrow</DocLink> with{' '}
                <M>pay_from_escrow</M> instead of attaching a deposit to <M>pay</M>: nothing is
                attached and the escrow is debited the same total, price + <M>0.002 NEAR</M>. If the
                escrow holds less, <M>buy</M> fails with <M>ERR_ESCROW_INSUFFICIENT</M> before
                sending anything. <M>--max</M> still caps the total. This is the call a restricted{' '}
                <DocLink href="#agent-key">agent key</DocLink> can sign.
              </>
            ),
          },
          {
            name: '--gasless',
            type: 'flag',
            required: false,
            desc: (
              <>
                Pays gasless; it implies --from-escrow, and the account pays no gas either:{' '}
                <M>buy</M> signs the{' '}
                <M>pay_from_escrow</M> as a NEP-366 delegate and sends it as the proof, and the
                gateway relays it and pays the gas (the{' '}
                <DocLink href="/docs/protocol#gasless">gasless rail</DocLink>). The escrow pays
                price + <M>0.002 NEAR</M>; nothing is sent from the account. The gateway’s 402 must
                offer a relayer, else <M>RELAYER_UNAVAILABLE</M> before anything is signed; the
                escrow checks of <M>--from-escrow</M> run next. An{' '}
                <DocLink href="#agent-key">agent key</DocLink> can sign it. While the gateway
                answers <M>settlement_pending</M> (its relay is settling), <M>buy</M> presents the
                same signed delegate again, waiting the gateway’s Retry-After (1–10 s), until the
                gateway answers definitively, for at most 150 s; it prints one <M>waiting:</M> line
                on stderr meanwhile.
              </>
            ),
          },
          { name: '--method <method>', type: 'string', required: false, default: 'GET', desc: 'HTTP method of the paid request.' },
          { name: '--body <json>', type: 'string', required: false, desc: 'JSON request body to send with the paid request.' },
          {
            name: '--gateway <url>',
            type: 'url',
            required: false,
            default: 'the service’s on-chain endpoint',
            desc: 'Gateway base URL; the request goes to <gateway>/svc/<id>.',
          },
        ]}
      />
      <H3 id="buy-example">Example receipt</H3>
      <CodeBlock
        label="stderr"
        code={[
          'waiting:  the gateway’s relay (tx <tx hash>, <explorer>/txns/<tx hash>) is settling; presenting the same signed delegate again for up to 150 s      (with --gasless, only while its relay settles)',
          'service:  #1 RWA FX & Gold Oracle',
          'url:      http://localhost:4021/svc/1',
          'paid:     0.5 NEAR + 0.002 NEAR storage',
          'from:     escrow (nothing attached; the escrow was debited)      (with --from-escrow or --gasless)',
          'relayed:  gasless — <relayer> relayed the signed pay_from_escrow and paid the gas      (with --gasless only)',
          'payment:  <tx hash>',
          'explorer: <NEAR_EXPLORER_URL>/txns/<tx hash>      (live mode only)',
          'settled:  ok  (payer buyer-1abba006.mock)',
          'status:   200',
        ].join('\n')}
      />
      <P>
        <strong className="text-white">Never pay twice for one call.</strong> If the payment went
        through but the gateway did not serve the call, <M>buy</M> fails with{' '}
        <M>PAID_NOT_SERVED</M> naming the transaction and nonce (with --gasless,{' '}
        <M>GASLESS_NOT_SERVED</M> naming the nonce, whether the escrow paid and, when the gateway
        gave it, the relay transaction); see <DocLink href="#error-codes">Error codes</DocLink>{' '}
        before buying again.
      </P>

      {/* ───────────────────────────── status ───────────────────────────── */}
      <H2 id="status">status</H2>
      <P>
        One service in full: record, price (with the storage fee), payment target, owner, attestor,
        trust tier with the score, and its 10 latest attestations. No key.
      </P>
      <CommandBlock text="npm run neargate -- status <id>" />

      {/* ───────────────────────────── pause / resume ───────────────────────────── */}
      <H2 id="pause">pause</H2>
      <P>
        Owner only: calls <M>set_active(false)</M>. A paused service takes no new payments (the
        registry’s <M>pay</M> panics <M>ERR_SERVICE_INACTIVE</M>) and its gateway answers{' '}
        <M>403 service_inactive</M>. Prints the service, its new state and the transaction.
      </P>
      <CommandBlock text="npm run neargate -- pause <id> --account <owner>" />
      <H2 id="resume">resume</H2>
      <P>
        Owner only: calls <M>set_active(true)</M>; calls flow again.
      </P>
      <CommandBlock text="npm run neargate -- resume <id> --account <owner>" />
      <P>
        Signing as anyone but the owner is rejected by the registry with{' '}
        <M>ERR_NOT_AUTHORIZED</M>, which the CLI rewords into an owner-only message.
      </P>

      {/* ───────────────────────────── escrow ───────────────────────────── */}
      <H2 id="escrow">escrow</H2>
      <P>
        A prepaid balance held in the registry under your account. <M>buy --from-escrow</M> and the
        MCP tool pay each call out of it, attaching nothing, which is what lets a restricted{' '}
        <DocLink href="#agent-key">agent key</DocLink> pay: the escrow is the agent’s spending
        limit. Three subcommands, all taking the config flags; <M>deposit</M> and <M>withdraw</M> take
        the buyer <DocLink href="#signer-flags">signer flags</DocLink>.
      </P>
      <H3 id="escrow-deposit">escrow deposit</H3>
      <CommandBlock text="npm run neargate -- escrow deposit <near> --account <buyer>" />
      <P>
        Calls <M>deposit_escrow</M> with the amount attached. The first deposit of an account must
        be <strong className="text-white">more than</strong> <M>0.002 NEAR</M>: the registry keeps
        that as the escrow entry’s storage fee and credits the rest (otherwise{' '}
        <M>ERR_DEPOSIT_TOO_LOW</M>); later deposits are credited in full. The amount must be above
        zero.
      </P>
      <CodeBlock
        label="output"
        code={[
          'account:    buyer.testnet',
          'deposited:  1 NEAR',
          'escrow:     0.998 NEAR',
          'tx:         <tx hash>',
          'explorer:   <NEAR_EXPLORER_URL>/txns/<tx hash>      (live mode only)',
          "note:       the first deposit keeps 0.002 NEAR as the escrow's storage fee      (first deposit only)",
        ].join('\n')}
      />
      <H3 id="escrow-withdraw">escrow withdraw</H3>
      <CommandBlock text="npm run neargate -- escrow withdraw <near> --account <buyer>" />
      <P>
        Calls <M>withdraw_escrow</M>, which sends the amount back to your account. It attaches
        exactly 1 yocto, so{' '}
        <strong className="text-white">only the account’s full-access key can sign it</strong>: from
        an agent key NEAR rejects the call (<M>TX_FAILED</M>, “Deposit is not allowed with function
        call”). An amount above the escrow is refused with <M>ERR_ESCROW_INSUFFICIENT</M> before
        anything is sent. Prints <M>account</M>, <M>withdrawn</M>, <M>escrow</M> (what is left) and{' '}
        <M>tx</M>.
      </P>
      <H3 id="escrow-balance">escrow balance</H3>
      <CommandBlock text="npm run neargate -- escrow balance [account]" />
      <P>
        Reads an account’s escrow; no key. Without the argument (or <M>--account</M>) it reads the
        buyer account. An account that never deposited holds <M>0 NEAR</M>.
      </P>
      <CodeBlock
        label="output"
        code={['account:  buyer.testnet', 'escrow:   0.498 NEAR'].join('\n')}
      />

      {/* ───────────────────────────── agent-key ───────────────────────────── */}
      <H2 id="agent-key">agent-key</H2>
      <P>
        Live mode only (<M>LIVE_ONLY</M> otherwise: an agent key is a NEAR access key, which the
        offline devnet does not model). Gives an AI agent a key that can spend your escrow and
        nothing else.
      </P>
      <CommandBlock wrap text="npm run neargate -- agent-key add --allowance <near> --account <owner> --key-file <owner key>" />
      <PropList
        items={[
          {
            name: '--allowance <near>',
            type: 'NEAR decimal',
            required: true,
            desc: (
              <>
                The gas the key may spend, above zero (for example <M>0.25</M>). The gas is drawn from
                the account balance, not the escrow, so a leaked key can burn gas from the account
                balance up to its allowance: set it low. It is not the spending limit; the escrow is.
              </>
            ),
          },
        ]}
      />
      <P>
        It takes the buyer <DocLink href="#signer-flags">signer flags</DocLink> for the account’s{' '}
        <strong>full-access</strong> key, which signs the AddKey. It then generates a fresh ed25519
        key, writes <M>{'{account_id, public_key, private_key}'}</M> to{' '}
        <M>~/.near-credentials/&lt;network&gt;/&lt;account&gt;.neargate-agent.json</M> (mode{' '}
        <M>0600</M>; it refuses to overwrite an existing file, <M>AGENT_KEY_EXISTS</M>) and adds the
        public key to the account as a function-call key whose receiver is the registry and whose
        only method is <M>pay_from_escrow</M>. It prints the public key, the path and the agent’s
        next command, never the secret. If NEAR rejects the AddKey the file is removed again; if
        the outcome is unknown (<M>TX_TIMEOUT</M>) the file is kept, because the key may still be
        added: the error names the file and the public key, so check the transaction and delete the
        file before retrying if it failed.
      </P>
      <CodeBlock
        label="output"
        code={[
          'account:     buyer.testnet',
          'public key:  ed25519:…',
          'key file:    ~/.near-credentials/testnet/buyer.testnet.neargate-agent.json',
          "allowance:   0.25 NEAR (the key's gas; it can call pay_from_escrow on the registry and nothing else)",
          'add_key tx:  <tx hash>',
          'explorer:    <NEAR_EXPLORER_URL>/txns/<tx hash>',
          '',
          'the agent spends the escrow with:',
          '  neargate buy <id> --from-escrow --account buyer.testnet --key-file <key file>',
        ].join('\n')}
      />
      <Callout tone="warn" title="WHAT THE KEY CAN DO">
        It can spend the escrow and nothing else: it cannot withdraw, deposit, register, pause or
        move any other balance, and NEAR rejects any other call from it. A leaked agent key can spend
        all of the escrow on any active service, and no more NEAR than that. It can also burn gas
        from the account balance up to its allowance, because its gas is paid by the account, not
        the escrow: keep the allowance low. Keep in the escrow only what the agent may spend; see
        the{' '}
        <DocLink href="/docs/security#agent-keys">security model</DocLink>.
      </Callout>

      {/* ───────────────────────────── demo-accounts ───────────────────────────── */}
      <H2 id="demo-accounts">demo-accounts</H2>
      <P>
        Mock mode only (<M>MOCK_ONLY</M> otherwise): creates a buyer and a seller on the offline
        devnet, funds each with 1000 NEAR from its faucet and prints their balances with ready-to-paste
        export lines. The devnet must be running (<M>npm run dev</M>).
      </P>
      <CommandBlock text="npm run neargate -- demo-accounts --mode mock" />
      <CodeBlock
        label="output (abbreviated)"
        code={[
          'buyer:  buyer-1abba006.mock  (1000 NEAR)',
          'seller: seller-1155b100.mock  (1000 NEAR)',
          '',
          '# paste into your shell (used by the buyer agent and `neargate wrap`):',
          'export MOCK_BUYER_ACCOUNT=buyer-1abba006.mock',
          'export MOCK_SELLER_ACCOUNT=seller-1155b100.mock',
          '# buyer public key: ed25519:…',
          '# seller public key: ed25519:…',
        ].join('\n')}
      />

      {/* ───────────────────────────── mcp ───────────────────────────── */}
      <H2 id="mcp">mcp</H2>
      <P>
        Serves NearGate as a Model Context Protocol <strong>stdio</strong> server, so any
        MCP-capable agent (Claude Desktop, a custom client, an MCP-aware framework) gets NearGate
        discovery and payment as native tools. stdout is the JSON-RPC channel, so the server prints
        nothing else there; a readiness hint goes to stderr. It takes the config flags and the buyer{' '}
        <DocLink href="#signer-flags">signer flags</DocLink>.
      </P>
      <CommandBlock text="npm run neargate -- mcp --account <buyer>" />
      <H3 id="mcp-tools">Tools</H3>
      <DocTable
        head={['Tool', 'Does', 'Spends NEAR']}
        rows={[
          [
            <span key="t1">
              <M>neargate_list_services</M>
              <Sub>no input</Sub>
            </span>,
            'The live catalog: id, name, description, price (with storage fee), tier, score, active flag, endpoint.',
            'no',
          ],
          [
            <span key="t2">
              <M>neargate_get_service</M>
              <Sub>{'{ id }'}</Sub>
            </span>,
            'One service in full: price, payment target, owner, attestor, tier and score.',
            'no',
          ],
          [
            <span key="t3">
              <M>neargate_get_invoice</M>
              <Sub>{'{ id }'}</Sub>
            </span>,
            'Fetches the 402 invoice without paying: price, storage fee, total to attach, payTo, network, nonce, expiry — so an agent can decide first.',
            'no',
          ],
          [
            <span key="t4">
              <M>neargate_buy</M>
              <Sub>{'{ id, maxNear?, fromEscrow?, gasless?, method?, body? }'}</Sub>
            </span>,
            'Pays the invoice with a registry pay call and returns the response body. maxNear caps the total. With fromEscrow it calls pay_from_escrow instead, debiting the prepaid escrow (ERR_ESCROW_INSUFFICIENT, before sending, if it holds less). gasless implies fromEscrow and signs that call as a delegate the gateway relays, paying the gas (RELAYER_UNAVAILABLE when the gateway offers no relayer); the result then says gasless and names the relayer. While the relay settles the tool waits, for at most 150 s; a GASLESS_NOT_SERVED it returns points at the relay tx and neargate_escrow_balance.',
            <strong key="y" className="text-white">
              yes
            </strong>,
          ],
          [
            <span key="t5">
              <M>neargate_escrow_balance</M>
              <Sub>{'{ account? }'}</Sub>
            </span>,
            'The NEAR still prepaid in an escrow (default: the buyer account), so an agent can see its remaining budget before buying. Read-only.',
            'no',
          ],
        ]}
      />
      <P>
        The buyer key is resolved only when <M>neargate_buy</M> runs (and by{' '}
        <M>neargate_escrow_balance</M> when it is given no account), so the three catalog tools work
        with no key configured. Point an agent at a restricted{' '}
        <DocLink href="#agent-key">agent key</DocLink> (<M>--key-file</M>) and it can call{' '}
        <M>neargate_buy</M> with <M>fromEscrow: true</M> (or <M>gasless: true</M>) and nothing
        more. A failing tool returns an error result that leads with the stable
        code (<M>BUDGET_EXCEEDED</M>, <M>SERVICE_INACTIVE</M>, <M>PAID_NOT_SERVED</M>…), so an agent
        can branch on it; the codes are the ones in <DocLink href="#error-codes">Error codes</DocLink>.
      </P>
      <H3 id="mcp-claude-desktop">Claude Desktop</H3>
      <P>
        Build the bundle once with <M>npm run build -w @neargate/cli</M>, then add the server to{' '}
        <M>claude_desktop_config.json</M>, with the absolute path to your clone:
      </P>
      <CodeBlock
        label="claude_desktop_config.json"
        code={JSON.stringify(
          {
            mcpServers: {
              neargate: {
                command: 'node',
                args: ['/path/to/repo/packages/cli/dist/bin.js', 'mcp', '--account', 'buyer.testnet'],
              },
            },
          },
          null,
          2,
        )}
      />
      <P>
        To try the read tools without a client, <M>scripts/mcp.sh</M> drives the server over stdio:{' '}
        <M>scripts/mcp.sh tools</M>, <M>list</M>, <M>service &lt;id&gt;</M>, <M>invoice &lt;id&gt;</M>.
      </P>

      {/* ───────────────────────────── error codes ───────────────────────────── */}
      <H2 id="error-codes">Error codes</H2>
      <P>
        Failures reach you as <M>error: &lt;CODE&gt;: &lt;message&gt;</M> from the CLI, as an error
        result from an MCP tool, and as an <M>AgentGateError</M> with a <M>code</M> from the
        packages. A rejection by the registry keeps the contract’s own <M>ERR_*</M> code and starts
        its message with it; those are listed on the{' '}
        <DocLink href="/docs/contract#errors">contract page</DocLink>. The gateway’s HTTP answers
        (<M>402</M> reasons, <M>403</M>, <M>503</M>) are on{' '}
        <DocLink href="/docs/protocol#verification">How it works</DocLink>.
      </P>

      <H3 id="codes-input">Arguments, config and keys</H3>
      <DocTable
        head={['Code', 'Meaning']}
        rows={[
          [<M key="1">INVALID_INPUT</M>, 'A text flag is blank, has control characters or is over its byte limit (name 64, description 280).'],
          [<M key="2">INVALID_URL</M>, 'A URL is not http(s), has a query string or fragment, or the gateway URL is over 200 bytes.'],
          [<M key="21">GATEWAY_REQUIRED</M>, 'Live wrap with no --gateway while there is no hosted gateway default. Nothing is sent: pass --gateway <your gateway’s base URL>.'],
          [<M key="3">INSECURE_URL</M>, 'Live wrap with a plain http:// gateway that is not localhost: the mapping request would travel in cleartext.'],
          [<M key="4">INVALID_SERVICE_ID</M>, 'The <id> argument is not a positive integer.'],
          [<M key="5">INVALID_ACCOUNT_ID</M>, 'An account flag is not a NEAR account id.'],
          [<M key="6">INVALID_AMOUNT</M>, 'A NEAR amount (--price, --max, maxNear, an escrow amount, --allowance) is not a plain non-negative decimal of at most 24 places, or is above the u128 maximum; an escrow amount or an agent key allowance of zero is refused too.'],
          [<M key="7">INVALID_PRICE</M>, '--price is below the registry minimum of 0.000001 NEAR.'],
          [<M key="8">CONFIG_INVALID</M>, 'A flag or environment variable is invalid — for example live mode with no REGISTRY_CONTRACT_ID.'],
          [<M key="9">SIGNER_MISSING</M>, 'No account for the command’s role: pass --account or set the role’s *_ACCOUNT_ID (mock: MOCK_*_ACCOUNT).'],
          [<M key="10">SIGNER_KEY_INVALID</M>, 'A secret key or key file is not a valid ed25519 NEAR key. The message names the source, never the key.'],
          [<M key="11">SIGNER_KEY_UNREADABLE</M>, 'The key file cannot be read.'],
          [<M key="12">SIGNER_KEY_MISMATCH</M>, 'The key file is for a different account than the one you are signing as.'],
          [<M key="13">ACCOUNT_NOT_FOUND</M>, 'wrap: the payment target does not exist on the network. Create it or pass --payment-target <existing account>; a missing one would strand every payment.'],
          [<M key="14">LIVE_ONLY</M>, 'map or agent-key in mock mode. The mock gateway maps through its admin route, which wrap does for you; agent keys are NEAR access keys, which the devnet does not model.'],
          [<M key="15">MOCK_ONLY</M>, 'demo-accounts outside mock mode.'],
          [<M key="16">NOT_SERVICE_OWNER</M>, 'map: your key’s account is not the service owner.'],
          [<M key="17">MAPPING_FAILED</M>, 'The gateway did not map the upstream (non-2xx, a redirect, a network error or a timeout). The registration stays; retry with map.'],
          [<M key="18">SERVICE_NOT_FOUND</M>, 'No service with that id on this registry.'],
          [<M key="19">SERVICE_INACTIVE</M>, 'buy / neargate_get_invoice: the owner paused the service. Nothing is paid.'],
          [<M key="20">FAUCET_UNREACHABLE</M>, 'demo-accounts cannot reach the devnet faucet. Start it with npm run dev. FAUCET_FAILED means the faucet answered an error; GATEWAY_TIMEOUT that it did not answer in time.'],
        ]}
      />

      <H3 id="codes-escrow">Escrow and agent keys</H3>
      <P>
        The three ERR_* codes below are the registry’s own (see the{' '}
        <DocLink href="/docs/contract#errors">contract page</DocLink>); the CLI and the client
        raise <M>ERR_ESCROW_INSUFFICIENT</M> themselves, before sending, when they can see it
        coming.
      </P>
      <DocTable
        head={['Code', 'Meaning, and what to do']}
        rows={[
          [
            <M key="1">ERR_ESCROW_INSUFFICIENT</M>,
            <span key="1m">
              <M>buy --from-escrow</M> / <M>neargate_buy</M> with <M>fromEscrow</M>: the escrow
              holds less than price + 0.002 NEAR. <M>escrow withdraw</M>: the amount is above the
              escrow. The message states the balance, and ends “nothing was sent” when the CLI or
              client refused before sending.
              <Sub>Top up with escrow deposit, or ask for less.</Sub>
            </span>,
          ],
          [
            <M key="2">ERR_ONE_YOCTO_REQUIRED</M>,
            <span key="2m">
              <M>withdraw_escrow</M> without exactly 1 yocto attached. The CLI always attaches it;
              you only meet this calling the contract by hand.
            </span>,
          ],
          [
            <M key="3">ERR_DEPOSIT_NOT_ALLOWED</M>,
            <span key="3m">
              <M>pay_from_escrow</M> with a deposit attached. The CLI and the client attach none;
              you only meet this calling the contract by hand.
            </span>,
          ],
          [
            <M key="4">AGENT_KEY_EXISTS</M>,
            <span key="4m">
              <M>agent-key add</M>: the key file for this account and network already exists, and is
              never overwritten.
              <Sub>Delete it first if you mean to replace that key.</Sub>
            </span>,
          ],
          [
            <M key="5">AGENT_KEY_UNWRITABLE</M>,
            <span key="5m">
              <M>agent-key add</M> cannot create the key file (permissions, disk). Nothing was added
              to the account.
            </span>,
          ],
        ]}
      />

      <H3 id="codes-client">Buying: invoice and payment</H3>
      <P>
        Raised by <M>buy</M>, <M>neargate_buy</M> and <M>fetchPaid</M> in <M>@agentgate/client</M>.
        Every refusal below happens <em>before</em> a payment is sent, except{' '}
        <M>PAID_NOT_SERVED</M> and <M>GASLESS_NOT_SERVED</M>.
      </P>
      <DocTable
        head={['Code', 'Meaning, and what to do']}
        rows={[
          [
            <M key="1">BUDGET_EXCEEDED</M>,
            <span key="1m">
              The invoice total (price + the 0.002 NEAR storage fee) is above your cap (--max,
              maxNear, or the buyer agent’s budget). Nothing was paid.
              <Sub>Raise the cap or pick a cheaper service.</Sub>
            </span>,
          ],
          [
            <M key="2">BAD_URL</M>,
            <span key="2m">
              The endpoint read from the registry is not an http(s) URL.
              <Sub>The seller registered a bad endpoint; do not use the service.</Sub>
            </span>,
          ],
          [
            <M key="3">FORBIDDEN_HOST</M>,
            <span key="3m">
              Live mode: the endpoint host is private, loopback or link-local, or resolves to one.
              <Sub>The seller’s gateway URL is unusable from the public network.</Sub>
            </span>,
          ],
          [
            <M key="4">BAD_INVOICE</M>,
            <span key="4m">
              The 402 body is not a valid NearGate invoice: not JSON, wrong x402 version, an expired
              invoice, or a price, fee or total that does not add up.
              <Sub>Retry for a fresh invoice; if it persists the gateway is faulty.</Sub>
            </span>,
          ],
          [
            <M key="5">NETWORK_MISMATCH</M>,
            <span key="5m">
              The invoice offers no payment on this client’s network (for example a testnet client
              and a mock gateway).
              <Sub>Point the client and the gateway at the same network.</Sub>
            </span>,
          ],
          [
            <M key="6b">PRICE_MISMATCH</M>,
            <span key="6bm">
              <M>--from-escrow</M> only: the invoice’s total is not the service’s on-chain price +
              0.002 NEAR. <M>pay_from_escrow</M> carries no amount and debits the on-chain price, so
              the client checks the registry before paying and refuses an invoice that differs.
              Nothing was sent.
              <Sub>Do not pay this service from the escrow; the gateway’s invoice is wrong.</Sub>
            </span>,
          ],
          [
            <M key="6">REGISTRY_MISMATCH</M>,
            <span key="6m">
              The invoice’s payTo is not the registry this client settles on.
              <Sub>Check --registry / REGISTRY_CONTRACT_ID.</Sub>
            </span>,
          ],
          [
            <M key="7">SERVICE_MISMATCH</M>,
            <span key="7m">
              The invoice is for a different service id than the one you asked for.
              <Sub>Do not pay; the gateway answered for another service.</Sub>
            </span>,
          ],
          [
            <M key="8">REDIRECT_REFUSED</M>,
            <span key="8m">
              A gateway answered with an HTTP 3xx. NearGate never follows a redirect, because it
              would carry the request past the URL guard.
              <Sub>Use the final URL directly, if you trust it.</Sub>
            </span>,
          ],
          [
            <M key="9">UPSTREAM_TIMEOUT</M>,
            <span key="9m">
              The invoice request got no answer within 30 s. Nothing was paid.
              <Sub>Safe to retry.</Sub>
            </span>,
          ],
          [
            <M key="10">PAID_NOT_SERVED</M>,
            <span key="10m">
              The registry <M>pay</M> went through — the deposit is spent — but the gateway did not
              serve the call. The error names the transaction, the nonce, the service, the amount
              and a reason: <M>refused</M>, <M>settlement_pending</M>, <M>redirect</M> or{' '}
              <M>transport</M>.
              <Sub>
                Do not pay a fresh invoice for it. Re-present the same proof (an X-PAYMENT for that
                transaction and nonce) once the gateway is reachable or the payment has settled.
              </Sub>
            </span>,
          ],
          [
            <M key="11">RELAYER_UNAVAILABLE</M>,
            <span key="11m">
              --gasless only: the gateway’s 402 offers no relayer of <M>pay_from_escrow</M> (no{' '}
              <M>extra.relayer</M>; the gateway runs without RELAYER_ENABLED). Nothing was read or
              signed.
              <Sub>Buy with --from-escrow, which pays the gas from your account.</Sub>
            </span>,
          ],
          [
            <M key="12">GASLESS_NOT_SERVED</M>,
            <span key="12m">
              --gasless only: the gateway did not serve the call. The account sent nothing; the
              escrow paid only if the gateway’s relay landed. <M>buy</M> already presented the same
              signed delegate again for as long as the gateway answered{' '}
              <M>settlement_pending</M>, up to 150 s. The message says whether the escrow paid
              (the error’s <M>escrowPaid</M>: <M>no</M> or <M>unknown</M>) and names the nonce, the
              service, the relay transaction when the gateway named it (with its explorer link in
              live mode) and a reason:{' '}
              <M>refused</M> (the gateway’s 402 error, and after <M>relay_failed</M> its code: the
              registry’s, e.g. <M>ERR_ESCROW_INSUFFICIENT</M>, <M>DELEGATE_REJECTED</M> or{' '}
              <M>RELAYER_ERROR</M>), <M>settlement_pending</M> (the relay was still settling after
              150 s), <M>redirect</M> or <M>transport</M> (the gateway may have relayed it).
              <Sub>
                When the escrow did not pay (<M>no</M>), fix the cause and buy again. When it may
                have (<M>unknown</M>), check the relay transaction on the explorer and{' '}
                <M>npm run neargate -- escrow balance</M> before buying again: buying again signs a
                NEW payment. After <M>invoice_used</M>, always check the escrow balance before
                buying again: it can mean the gateway’s relay landed before the gateway restarted.
              </Sub>
            </span>,
          ],
        ]}
      />

      <H3 id="codes-chain">Chain and RPC (live mode)</H3>
      <DocTable
        head={['Code', 'Meaning, and whether to retry']}
        rows={[
          [
            <M key="1">RPC_TIMEOUT</M>,
            <span key="1m">
              The NEAR RPC did not answer in time and <strong className="text-white">nothing was
              sent</strong>: a read, or a call that failed before its transaction was signed.
              <Sub>Safe to retry.</Sub>
            </span>,
          ],
          [
            <M key="2">RPC_ERROR</M>,
            <span key="2m">
              The RPC is unreachable, answered an HTTP error (the message says rate-limited for a
              429) or failed on the node side. Nothing was sent.
              <Sub>Safe to retry.</Sub>
            </span>,
          ],
          [
            <M key="3">RPC_BAD_RESPONSE</M>,
            <span key="3m">
              The RPC, or the registry behind it, answered in a shape this client cannot use.
              <Sub>Retry once, then check NEAR_RPC_URL.</Sub>
            </span>,
          ],
          [
            <M key="4">NOT_DEPLOYED</M>,
            <span key="4m">
              The registry account holds no neargate-registry contract (or one with a different
              ABI).
              <Sub>Not retryable: fix REGISTRY_CONTRACT_ID.</Sub>
            </span>,
          ],
          [
            <M key="5">TX_TIMEOUT</M>,
            <span key="5m">
              The transaction <strong className="text-white">was sent</strong>, but its outcome is
              unknown: the RPC timed out or failed after the transaction went out. The message
              names the transaction hash and its explorer page,{' '}
              <M>&lt;explorer&gt;/txns/&lt;hash&gt;</M>.
              <Sub>
                Do not retry blindly: the transaction may still land. Check it on the explorer
                first, or a retry can register or pay twice.
              </Sub>
            </span>,
          ],
          [
            <M key="6">TX_FAILED</M>,
            <span key="6m">
              NEAR rejected the transaction, or an action in it failed, outside a contract panic.
              The message carries NEAR’s reason and the transaction hash when there is one.
              <Sub>Not as is: read the reason.</Sub>
            </span>,
          ],
          [
            <M key="7">CONTRACT_ERROR</M>,
            <span key="7m">
              The registry failed without one of its ERR_* codes (gas exhaustion, a wasm trap, a
              panic with no code).
              <Sub>Not as is.</Sub>
            </span>,
          ],
          [
            <M key="8">SIGNER_KEY_NOT_FOUND</M>,
            <span key="8m">
              The key you sign with is not an access key of the signer account on this network.
              <Sub>Use the right key or network.</Sub>
            </span>,
          ],
          [
            <M key="9">SIGNER_ACCOUNT_NOT_FOUND</M>,
            <span key="9m">
              The signer account does not exist on this network.
              <Sub>Create or fund it first.</Sub>
            </span>,
          ],
          [
            <M key="10">ERR_INSUFFICIENT_BALANCE</M>,
            <span key="10m">
              The signer cannot cover the deposit plus gas, or would be left unable to cover its
              own storage.
              <Sub>Fund the account.</Sub>
            </span>,
          ],
          [
            <M key="11">devnet_unreachable</M>,
            <span key="11m">
              Mock mode: the offline devnet is not running (devnet_timeout: it did not answer).
              <Sub>Start it with npm run dev.</Sub>
            </span>,
          ],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/protocol', label: 'How it works' },
          { href: '/docs/contract', label: 'Registry contract' },
        ]}
      />
    </>
  );
}
