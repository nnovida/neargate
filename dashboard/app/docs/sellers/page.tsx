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
  StepFlow,
} from '@/components/docs';

export const metadata = { title: 'Wrap an API' };

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="GUIDE"
        title="Wrap an API"
        lede="Turn any HTTP API into a pay-per-call service: register it on-chain and map it to your private upstream on the gateway with a single agentgate wrap command."
      />

      <H2 id="what-wrapping-does">What wrapping does</H2>
      <P>
        Wrapping an API performs two distinct side effects, in order. First it{' '}
        <strong className="text-white">registers the service on-chain</strong> in the Casper
        registry contract via a <M>register_service</M> transaction. The registry stores your
        service&apos;s name, description, price (in motes), payment target, attestor, owner, and
        an active flag — and crucially the <em>gateway base URL</em>, not your real upstream.
        Second it <strong className="text-white">maps the upstream on the gateway</strong> by
        POSTing the new <M>serviceId</M> together with your private <M>upstreamUrl</M> to{' '}
        <M>POST &lt;gateway&gt;/admin/services</M> with the admin Bearer token.
      </P>
      <P>
        Your upstream URL is never written on-chain. It is sent only to the gateway admin API and
        lives only in the gateway&apos;s private mapping. Everyone reading the registry sees the
        canonical public endpoint computed as <M>&lt;gateway&gt;/svc/&lt;serviceId&gt;</M> — the
        404-or-proxy facade through which buyers actually call your API.
      </P>
      <DocTable
        head={['Side effect', 'Where', 'What is stored']}
        rows={[
          [
            <M key="a">register_service</M>,
            'Casper registry (on-chain)',
            'name, description, gateway base URL, priceMotes, paymentTarget, attestor, owner, active=true. Readers compute the public endpoint as <base>/svc/<id>.',
          ],
          [
            <M key="b">POST /admin/services</M>,
            'gateway (private map)',
            'The serviceId -> upstreamUrl mapping. This is the only place your real upstream URL exists.',
          ],
        ]}
      />

      <H2 id="prerequisites">Prerequisites</H2>
      <P>
        Wrapping signs an on-chain transaction, so you need a <strong className="text-white">seller
        signer</strong>. Which one depends on <M>AGENTGATE_MODE</M>:
      </P>
      <DocTable
        head={['Mode', 'Signer env var', 'How to get one']}
        rows={[
          [
            <M key="a">mock</M>,
            <M key="b">MOCK_SELLER_ACCOUNT</M>,
            <span key="c">
              A devnet public key. Run <DocLink href="/docs/cli">agentgate demo-accounts</DocLink>{' '}
              and paste the printed export lines into your shell.
            </span>,
          ],
          [
            <M key="d">live</M>,
            <M key="e">SELLER_SIGNER_PEM_PATH</M>,
            'Path to your Casper key PEM (ed25519 or secp256k1) on Testnet.',
          ],
        ]}
      />
      <P>
        If the required variable is unset, <M>agentgate wrap</M> aborts before any side effect with{' '}
        <M>SIGNER_MISSING</M>. The mock-mode message points you at{' '}
        <M>agentgate demo-accounts</M>; the live-mode message tells you to set{' '}
        <M>SELLER_SIGNER_PEM_PATH</M>. You also need the gateway running and a matching{' '}
        <M>AGENTGATE_ADMIN_TOKEN</M> so the upstream-mapping step can authenticate.
      </P>

      <H2 id="wrap-your-api">Wrap your API</H2>
      <P>
        Run wrap from the repo root. The only positional argument is your upstream URL; everything
        else is a flag.
      </P>
      <CommandBlock
        wrap
        text={
          'npm run agentgate -- wrap https://api.example.com/gold ' +
          '--price 0.5 --name "Gold Spot Feed" ' +
          '--description "Live gold spot price, refreshed every 10s" ' +
          '--gateway http://localhost:4021'
        }
      />
      <P>Arguments and flags:</P>
      <PropList
        items={[
          {
            name: '<upstreamUrl>',
            type: 'positional',
            required: true,
            desc: (
              <>
                The upstream API URL to wrap. Must be a valid <M>http://</M> or <M>https://</M>{' '}
                URL. Kept private — only ever sent to the gateway admin API, never written
                on-chain.
              </>
            ),
          },
          {
            name: '--price <cspr>',
            type: 'string',
            required: true,
            desc: (
              <>
                Price per call in CSPR as a decimal string (e.g. <M>0.5</M>). Must be{' '}
                <strong className="text-white">greater than 0</strong> and at most 9 decimal
                places; it is converted to motes and stored on-chain. A non-positive price is
                rejected with <M>INVALID_PRICE</M>.
              </>
            ),
          },
          {
            name: '--name <name>',
            type: 'string',
            required: true,
            desc: (
              <>
                Human-readable service name shown in the catalog. Non-empty, no control
                characters, at most 128 characters (<M>MAX_NAME_LENGTH</M>).
              </>
            ),
          },
          {
            name: '--description <d>',
            type: 'string',
            required: false,
            default: "'' (empty)",
            desc: (
              <>
                Optional description for catalog listings. When provided: no control characters,
                at most 512 characters (<M>MAX_DESCRIPTION_LENGTH</M>).
              </>
            ),
          },
          {
            name: '--gateway <url>',
            type: 'url',
            required: false,
            default: 'http://localhost:<MIDDLEWARE_PORT|4021>',
            desc: (
              <>
                Gateway base URL. This — not the upstream — is the <M>endpointUrl</M> stored
                on-chain; the public endpoint becomes <M>&lt;gateway&gt;/svc/&lt;id&gt;</M>. Must
                be a base URL with no query string or fragment. In live mode a non-loopback host{' '}
                <strong className="text-white">must</strong> use <M>https://</M> (the admin token
                is POSTed here).
              </>
            ),
          },
          {
            name: '--payment-target <accountHash>',
            type: 'string',
            required: false,
            default: 'derived from the seller signer',
            desc: (
              <>
                Account that receives buyer payments, in <M>account-hash-&lt;64 hex&gt;</M> form.
                Defaults to the account hash derived from your signer. Invalid formats are
                rejected with <M>INVALID_ACCOUNT_HASH</M>.
              </>
            ),
          },
          {
            name: '--attestor <publicKeyHex>',
            type: 'string',
            required: false,
            default: 'the seller signer public key',
            desc: (
              <>
                Casper public key hex allowed to record attestations for this service — normally
                the gateway signer. Defaults to your signer&apos;s public key. Must be{' '}
                <M>01</M>+64 hex (ed25519) or <M>02</M>+66 hex (secp256k1), else{' '}
                <M>INVALID_PUBLIC_KEY</M>.
              </>
            ),
          },
        ]}
      />
      <P>On success the CLI prints the service id, public endpoint, dashboard link and tx hash:</P>
      <CodeBlock
        code={[
          'service id:      7',
          'public endpoint: http://localhost:4021/svc/7',
          'dashboard:       http://localhost:3000/services/7',
          'register tx:     <txHash>',
        ].join('\n')}
      />

      <H2 id="under-the-hood">What happens under the hood</H2>
      <StepFlow
        steps={[
          {
            title: 'Validate everything first',
            body: (
              <>
                Name, description, upstream URL, gateway base, admin token and price are all
                checked before any side effect. Fail-fast: nothing is registered if an input is
                bad.
              </>
            ),
          },
          {
            title: 'Register the service on-chain',
            body: (
              <>
                A <M>register_service</M> transaction is signed with your seller signer. The{' '}
                <M>endpointUrl</M> written to the registry is the gateway base URL; the contract
                assigns a sequential <M>serviceId</M> and returns it plus the transaction hash.
              </>
            ),
          },
          {
            title: 'Map the upstream on the gateway',
            body: (
              <>
                The CLI POSTs <M>{'{ serviceId, upstreamUrl }'}</M> to{' '}
                <M>&lt;gateway&gt;/admin/services</M> with{' '}
                <M>Authorization: Bearer &lt;adminToken&gt;</M>. This is the only step that knows
                your real upstream.
              </>
            ),
          },
          {
            title: 'Report the result',
            body: (
              <>
                On success it prints the id, public endpoint{' '}
                (<M>&lt;gateway&gt;/svc/&lt;id&gt;</M>), dashboard URL and tx hash. If the mapping
                step failed, the on-chain registration is <strong className="text-white">not</strong>{' '}
                rolled back and a retry curl is printed (see Troubleshooting).
              </>
            ),
          },
        ]}
      />

      <H2 id="manage-a-service">Manage a service</H2>
      <P>
        After wrapping, manage the service with the other CLI commands. <M>list</M> and{' '}
        <M>status</M> read the chain (no signer needed); <M>pause</M> and <M>resume</M> sign a{' '}
        <M>set_active</M> transaction and require the same seller signer as wrap.
      </P>
      <DocTable
        head={['Command', 'What it does']}
        rows={[
          [
            <M key="a">agentgate list</M>,
            'Prints the on-chain catalog: id, name, price, trust tier, score (success/total), active flag and endpoint.',
          ],
          [
            <M key="b">agentgate status &lt;id&gt;</M>,
            'Shows one service in depth: record, score, trust tier and recent attestations. Id must be a positive integer.',
          ],
          [
            <M key="c">agentgate pause &lt;id&gt;</M>,
            'set_active(false) on a service you own — the paywall then answers 403.',
          ],
          [
            <M key="d">agentgate resume &lt;id&gt;</M>,
            'set_active(true) — calls flow again. The score is untouched by pause/resume.',
          ],
        ]}
      />
      <CommandBlock text="npm run agentgate -- list" />
      <CommandBlock text="npm run agentgate -- status 7" />
      <CommandBlock text="npm run agentgate -- pause 7" />
      <CommandBlock text="npm run agentgate -- resume 7" />
      <P>
        <M>pause</M> and <M>resume</M> re-fetch the record and print the service, its new active
        state and the <M>set_active</M> tx hash. Full reference in{' '}
        <DocLink href="/docs/cli">CLI reference</DocLink>.
      </P>

      <H2 id="pricing-payment-attestor">Pricing, payment target and attestor</H2>
      <P>
        <M>--price</M> is a decimal CSPR string converted to motes (1 mote = 1e-9 CSPR). It must
        be strictly positive and use at most 9 decimal places; all comparisons use bigint math,
        never floats. Buyers pay with a <strong className="text-white">native CSPR transfer</strong>{' '}
        sent directly to your <M>paymentTarget</M> — the gateway never holds or forwards funds, it
        only verifies the transfer happened on-chain before proxying.
      </P>
      <P>
        <M>paymentTarget</M> defaults to the account hash derived from your signer, so by default
        revenue lands in your own account. Override it with <M>--payment-target</M> to route
        payments elsewhere. The <M>attestor</M> is the public key permitted to record
        success/failure attestations that build your trust score; it defaults to your signer&apos;s
        public key but is normally set to the gateway&apos;s signer with <M>--attestor</M>.
      </P>

      <H2 id="going-live">Going live</H2>
      <P>
        Live mode (<M>AGENTGATE_MODE=live</M>) targets Casper Testnet and adds three hard
        requirements:
      </P>
      <DocTable
        head={['Requirement', 'Why']}
        rows={[
          [
            <span key="a">
              <M>SELLER_SIGNER_PEM_PATH</M> set to a readable key PEM
            </span>,
            'wrap, pause and resume must sign real transactions; the PEM is parsed as ed25519 or secp256k1.',
          ],
          [
            <span key="b">
              <M>--gateway</M> uses <M>https://</M> for any non-localhost host
            </span>,
            'The admin Bearer token is POSTed to the gateway; cleartext http would leak it. Non-loopback http is rejected with INSECURE_URL.',
          ],
          [
            <span key="c">
              A strong, unique <M>AGENTGATE_ADMIN_TOKEN</M>
            </span>,
            'Live mode refuses the default dev-admin-token — set your own before the gateway will start.',
          ],
        ]}
      />
      <Callout tone="warn" title="Protect your signer PEM">
        <P>
          On POSIX systems, if the PEM is group- or other-readable the CLI prints a loud warning
          (it does not refuse): anyone who can read the key can sign as you. Lock it down:
        </P>
        <CommandBlock text="chmod 600 /path/to/seller-key.pem" />
      </Callout>
      <P>
        The <M>--payment-target</M> and <M>--attestor</M> for live keys are derived from the PEM
        via casper-js-sdk. An unreadable PEM fails with <M>SIGNER_PEM_UNREADABLE</M>; one that
        parses as neither key type fails with <M>SIGNER_PEM_INVALID</M>.
      </P>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <H3 id="ts-non-idempotent">Wrap is not idempotent</H3>
      <P>
        Each successful wrap registers a <strong className="text-white">new</strong> service with a
        new id. Re-running it does not update an existing service — it creates a duplicate. If you
        only need to fix the upstream mapping, use the admin endpoint directly rather than wrapping
        again.
      </P>
      <H3 id="ts-admin-map-failed">Gateway upstream mapping failed</H3>
      <P>
        If step 2 fails (gateway down, wrong token, timeout), the on-chain registration is{' '}
        <strong className="text-white">not rolled back</strong> — <M>/svc/&lt;id&gt;</M> will fail
        for callers until the mapping exists. The CLI prints a warning to stderr with the exact
        retry curl, then appends a one-line note to stdout. The curl references{' '}
        <M>$AGENTGATE_ADMIN_TOKEN</M> from your environment so no secret is printed:
      </P>
      <CodeBlock
        label="retry curl (re-create the upstream mapping)"
        code={[
          "curl -X POST 'http://localhost:4021/admin/services' \\",
          '  -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \\',
          "  -H 'Content-Type: application/json' \\",
          '  -d \'{"serviceId":7,"upstreamUrl":"https://api.example.com/gold"}\'',
        ].join('\n')}
      />
      <Callout tone="info" title="Make sure the token is exported">
        The retry curl expects <M>AGENTGATE_ADMIN_TOKEN</M> in your shell environment. Export it
        (the same value the gateway runs with) before pasting the command.
      </Callout>
      <H3 id="ts-name-limits">Name / description rejected</H3>
      <P>
        On-chain text fields are validated before registration. <M>--name</M> must be non-empty
        and at most 128 characters; <M>--description</M>, when provided, at most 512 characters.
        Neither may contain control characters (the C0 range and DEL) — these are rejected with{' '}
        <M>INVALID_INPUT</M> and the message names the offending field. Leading and trailing
        whitespace is trimmed before the length check.
      </P>

      <NextLinks
        links={[
          { href: '/docs/cli', label: 'CLI reference' },
          { href: '/docs/buyers', label: 'Build an agent' },
        ]}
      />
    </>
  );
}
