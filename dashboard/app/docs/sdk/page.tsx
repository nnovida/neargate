import { CommandBlock } from '@/components/copy';
import {
  ApiBadge,
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

export const metadata = {
  title: 'Client SDK',
  description:
    '@agentgate/client reference: createAgentGateClient and the fetchPaid helper that parses a 402, validates the x402 invoice, pays a native CSPR transfer, and retries with the X-PAYMENT proof — options, return shapes, and errors.',
  alternates: { canonical: '/docs/sdk' },
};

const INSTALL_IMPORT = [
  "import { createAgentGateClient, parsePaymentRequired } from '@agentgate/client';",
  "import type { PayAndFetchResult, AgentGateClientOpts } from '@agentgate/client';",
].join('\n');

const FULL_EXAMPLE = [
  "import { createAgentGateClient } from '@agentgate/client';",
  "import { createChainClient } from '@agentgate/chain';",
  "import { loadConfig, AgentGateError } from '@agentgate/shared';",
  '',
  '// 1. Build a ChainClient from the environment (mock or live, by AGENTGATE_MODE).',
  '//    Buyer scripts never touch the admin API, so opt out of the live-mode check',
  '//    that otherwise refuses to start on the default AGENTGATE_ADMIN_TOKEN.',
  'const config = loadConfig(process.env, { requireStrongAdminToken: false });',
  'const chain = createChainClient(config);',
  '',
  '// 2. Pick a signer. In mock mode this is a public key string; in live mode',
  '//    point at a PEM secret key: { kind: "pem", pemPath: "/secrets/buyer.pem" }.',
  'const signer = { kind: "mock" as const, publicKey: config.mockBuyerAccount };',
  '',
  '// 3. Construct the client. maxPriceMotes caps what you will ever pay per call.',
  'const client = createAgentGateClient({',
  '  chain,',
  '  signer,',
  '  maxPriceMotes: "5000000000", // 5 CSPR — invoices above this throw PRICE_EXCEEDED',
  '  // settleDelayMs, requestTimeoutMs, rejectPrivateHosts, fetchImpl, logger are optional',
  '});',
  '',
  '// 4. Match the URL to the mode: mock mode must target the LOCAL gateway — its 402',
  '//    advertises network "mock", while the public gateway advertises "casper-test",',
  '//    so crossing them makes parsePaymentRequired throw NETWORK_MISMATCH.',
  'const url = config.mode === "live"',
  '  ? "https://gateway.example.org/svc/1"',
  '  : `http://localhost:${config.middlewarePort}/svc/1`; // local mock gateway',
  '',
  '// 5. One call runs the whole exchange: GET -> 402 -> validate -> pay -> retry-with-proof.',
  'try {',
  '  const res = await client.fetchPaid(url);',
  '',
  '  if (res.paid) {',
  '    // Paid path: requirements / deployHash / priceMotes / settlement are populated.',
  '    console.log("paid", res.priceMotes, "motes -> deploy", res.deployHash);',
  '    console.log("service", res.requirements?.description, "#", res.requirements?.extra.serviceId);',
  '    if (res.settlement?.success) console.log("settled, payer:", res.settlement.payer);',
  '  } else {',
  '    // The first response was not a 402 — it passed straight through, unpaid.',
  '    console.log("passthrough (no payment), status", res.status);',
  '  }',
  '',
  '  console.log("status", res.status);',
  '  console.log("body", res.body); // parsed JSON when the upstream returned JSON',
  '} catch (err) {',
  '  if (err instanceof AgentGateError) {',
  '    // Branch on the stable machine-readable code.',
  '    console.error(`[${err.code}] ${err.message} (http ${err.httpStatus})`);',
  '  } else {',
  '    throw err;',
  '  }',
  '}',
].join('\n');

const PARSE_EXAMPLE = [
  "import { parsePaymentRequired } from '@agentgate/client';",
  '',
  'const res = await fetch("https://gateway.example.org/svc/1");',
  'if (res.status === 402) {',
  '  // Throws BAD_INVOICE on a malformed/expired challenge, NETWORK_MISMATCH',
  '  // if no accepts[] entry is on your network.',
  '  // Selects the first accepts[] entry matching chain.network + scheme:"exact".',
  '  const req = parsePaymentRequired(await res.json(), "casper-test");',
  '  console.log(req.maxAmountRequired, req.extra.nonce, req.payTo);',
  '}',
].join('\n');

const INVOICE_SHAPE = [
  '{',
  '  "x402Version": 1,',
  '  "error": "X-PAYMENT header is required",',
  '  "accepts": [',
  '    {',
  '      "scheme": "exact",',
  '      "network": "casper-test",',
  '      "maxAmountRequired": "500000000",',
  '      "asset": "CSPR",',
  '      "payTo": "account-hash-0000...<64 hex>",',
  '      "resource": "https://gateway.example.org/svc/1",',
  '      "description": "RWA FX & Gold Oracle",',
  '      "maxTimeoutSeconds": 600,',
  '      "extra": {',
  '        "nonce": "6203715498220417",',
  '        "serviceId": 1,',
  '        "expiresAtMs": 1893456000000,',
  '        "settlement": "casper-native-transfer",',
  '        "transferIdEncoding": "u64-decimal"',
  '      }',
  '    }',
  '  ]',
  '}',
].join('\n');

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="FOR BUYERS"
        title="Client SDK"
        lede="@agentgate/client is the agent-side payment library. createAgentGateClient(opts) returns a client whose fetchPaid(url) GETs a paid endpoint, parses and validates the 402 PaymentRequiredResponse (x402 V1), pays a native CSPR transfer carrying the nonce as transfer_id, and retries with the X-PAYMENT proof header — in a single call."
      />

      <H2 id="install-and-import">Install and import</H2>
      <P>
        <M>@agentgate/client</M> is a workspace package — it is not published to npm (only the{' '}
        <DocLink href="/docs/cli">CLI</DocLink>, <M>@neargate/cli</M>, is), so{' '}
        <M>npm install @agentgate/client</M> will not work. Clone the repo and run{' '}
        <M>npm install</M> once (see <DocLink href="/docs/installation">Installation</DocLink>);
        the workspace then resolves the package from any script in the repo with nothing extra to
        install. Import the two public entry points and, if you want them, the exported types:
      </P>
      <CodeBlock label="typescript" code={INSTALL_IMPORT} />
      <P>
        The package exports two functions —{' '}
        <M>createAgentGateClient(opts)</M> and <M>parsePaymentRequired(raw, network)</M> — and the
        types <M>AgentGateClient</M>, <M>AgentGateClientOpts</M> and <M>PayAndFetchResult</M>. The{' '}
        <M>ChainClient</M>, <M>AnySigner</M>, <M>Logger</M>, <M>Motes</M>,{' '}
        <M>PaymentRequirements</M>, <M>PaymentRequiredResponse</M>, and <M>SettlementResponse</M>{' '}
        types it references come from <M>@agentgate/shared</M>.
      </P>
      <Callout tone="info" title="WHERE THE CHAIN AND SIGNER COME FROM">
        The SDK does not talk to Casper directly — it depends on a <M>ChainClient</M> you build with{' '}
        <M>createChainClient(config)</M> from <M>@agentgate/chain</M>. That seam is what makes the
        same agent code run offline (<M>AGENTGATE_MODE=mock</M>) or on Casper Testnet (<M>live</M>).
        See <DocLink href="/docs/configuration">Configuration</DocLink>.
      </Callout>

      <H2 id="chain-client">The ChainClient surface</H2>
      <P>
        The <M>ChainClient</M> you pass to <M>createAgentGateClient</M> is more than a payment
        pipe — it is also the read surface for on-chain discovery. The same interface (defined in{' '}
        <M>@agentgate/shared</M>) is implemented by the mock devnet client and the live Casper
        client, so an agent can list services, check trust scores and verify transfers with the
        identical code in both modes:
      </P>
      <DocTable
        head={['Method', 'Returns', 'Notes']}
        rows={[
          [
            <M key="ls">listServices()</M>,
            <M key="lsr">ServiceRecord[]</M>,
            <>
              On-chain discovery. Each record carries <M>endpointUrl</M> (the public gateway{' '}
              <M>/svc/:id</M> URL to pass to <M>fetchPaid</M>), <M>priceMotes</M>,{' '}
              <M>paymentTarget</M> and <M>active</M>.
            </>,
          ],
          [
            <M key="gs">getService(id)</M>,
            <M key="gsr">ServiceRecord | null</M>,
            'A single registry entry by numeric id; null when it does not exist.',
          ],
          [
            <M key="sc">getScore(id)</M>,
            <M key="scr">{'{ totalCalls, successCalls }'}</M>,
            'The attestation-fed trust score a buyer can rank services by.',
          ],
          [
            <M key="la">listAttestations(serviceId, limit?)</M>,
            <M key="lar">AttestationRecord[]</M>,
            'Per-service attestation receipts (payment deploy hash, success flag, record tx).',
          ],
          [
            <M key="ra">listRecentActivity(limit?)</M>,
            <M key="rar">ActivityEvent[]</M>,
            'Registrations, payments and attestations as a single feed (the dashboard uses it).',
          ],
          [
            <M key="gb">getBalance(account)</M>,
            <M key="gbr">Motes</M>,
            'Native CSPR balance of an account-hash — check funds before an agent run.',
          ],
          [
            <M key="vt">verifyTransfer(q)</M>,
            <M key="vtr">VerifyResult</M>,
            <>
              Checks a transfer against target/amount/transfer-id/age — what the gateway runs on
              your <M>X-PAYMENT</M> proof.
            </>,
          ],
          [
            <M key="tr">transfer(input, signer)</M>,
            <M key="trr">{'{ deployHash }'}</M>,
            <>
              Sends the native CSPR payment. This is the only method <M>fetchPaid</M> calls.
            </>,
          ],
          [
            <M key="ws">registerService / recordAttestation / setActive</M>,
            <M key="wsr">{'{ txHash, … }'}</M>,
            <>
              Seller- and gateway-side writes; agents never call them. See{' '}
              <DocLink href="/docs/sellers">Wrap an API</DocLink>.
            </>,
          ],
        ]}
      />

      <H2 id="create-client">createAgentGateClient(opts)</H2>
      <P>
        Builds an <M>AgentGateClient</M> from an <M>AgentGateClientOpts</M> object. The constructor
        validates its inputs eagerly: it throws an <M>AgentGateError</M> with code <M>BAD_OPTS</M>{' '}
        (HTTP 500) if <M>opts</M> is not an object, if <M>chain</M> is not a <M>ChainClient</M> (no{' '}
        <M>transfer</M> method), or if <M>signer</M> is not a <M>mock</M> or <M>pem</M> signer. A
        non-parseable <M>maxPriceMotes</M> throws <M>INVALID_AMOUNT</M> (from <M>parseMotes</M>).
      </P>
      <PropList
        items={[
          {
            name: 'chain',
            type: 'ChainClient',
            required: true,
            desc: (
              <>
                The chain backend used to send the payment transfer and to read{' '}
                <M>chain.network</M>. Must expose a <M>transfer(...)</M> method. Build it with{' '}
                <M>createChainClient()</M> from <M>@agentgate/chain</M>.
              </>
            ),
          },
          {
            name: 'signer',
            type: "{ kind: 'mock'; publicKey } | { kind: 'pem'; pemPath }",
            required: true,
            desc: (
              <>
                The key used to sign the CSPR transfer. A <M>mock</M> signer carries a{' '}
                <M>publicKey</M> string (offline devnet); a <M>pem</M> signer carries a{' '}
                <M>pemPath</M> to a secret key file (live). Any other <M>kind</M> is rejected with{' '}
                <M>BAD_OPTS</M>.
              </>
            ),
          },
          {
            name: 'maxPriceMotes',
            type: 'Motes (decimal string)',
            required: false,
            default: 'unset (no cap)',
            desc: (
              <>
                Refuse to pay any invoice priced above this. When set and{' '}
                <M>invoice.priceMotes &gt; maxPriceMotes</M>, <M>fetchPaid</M> throws{' '}
                <M>PRICE_EXCEEDED</M> before any money moves. Omit it and there is no per-call cap.
              </>
            ),
          },
          {
            name: 'logger',
            type: 'Logger',
            required: false,
            default: 'undefined (no logging)',
            desc: (
              <>
                Optional structured logger. <M>fetchPaid</M> emits <M>debug</M>/<M>info</M>/
                <M>warn</M> lines for the 402 invoice, the payment send, the completed paid request,
                pending-retry waits and proof rejections. Pass a <M>Logger</M> from{' '}
                <M>@agentgate/shared</M> (<M>createLogger(name)</M>); it redacts sensitive fields.
              </>
            ),
          },
          {
            name: 'settleDelayMs',
            type: 'number (ms)',
            required: false,
            default: '0 in mock, 3000 in live',
            desc: (
              <>
                How long to wait after the on-chain transfer before retrying with proof, giving the
                transfer time to settle. The default is derived from <M>chain.network</M>: <M>0</M>{' '}
                when the network is <M>mock</M>, otherwise <M>3000</M>.
              </>
            ),
          },
          {
            name: 'fetchImpl',
            type: 'typeof fetch',
            required: false,
            default: 'globalThis.fetch',
            desc: (
              <>
                Injectable <M>fetch</M> implementation (dependency injection for tests). Defaults to
                the global <M>fetch</M>. Both the initial GET and the proof retry go through it.
              </>
            ),
          },
          {
            name: 'requestTimeoutMs',
            type: 'number (ms)',
            required: false,
            default: '30000',
            desc: (
              <>
                Per-request timeout for the upstream GETs. Applied via{' '}
                <M>AbortSignal.timeout</M> unless your <M>init</M> already supplies its own{' '}
                <M>signal</M>. On timeout, <M>fetchPaid</M> throws <M>UPSTREAM_TIMEOUT</M> (HTTP
                504).
              </>
            ),
          },
          {
            name: 'rejectPrivateHosts',
            type: 'boolean',
            required: false,
            default: 'true in live, false in mock',
            desc: (
              <>
                SSRF guard. When on, <M>fetchPaid</M> refuses URLs that point at
                private/loopback/link-local hosts — including DNS names that resolve to them
                (rebinding) — with <M>FORBIDDEN_HOST</M>. Defaults to{' '}
                <M>chain.network !== &apos;mock&apos;</M>, i.e. on for live and off for mock so the
                local mock gateway on <M>localhost:4021</M> works.
              </>
            ),
          },
        ]}
      />

      <H2 id="fetch-paid">fetchPaid(url, init?)</H2>
      <P>
        <M>client.fetchPaid(url, init?)</M> runs the entire x402 V1 exchange and resolves to a{' '}
        <M>PayAndFetchResult</M>. <M>url</M> must be a non-empty string (otherwise <M>BAD_URL</M>);{' '}
        <M>init</M> is an optional <M>RequestInit</M> forwarded to both the initial GET and the proof
        retry (your <M>headers</M> are preserved and the <M>X-PAYMENT</M> proof header is added on
        top).
      </P>
      <StepFlow
        steps={[
          {
            title: 'Guard the URL',
            body: (
              <>
                Validates the URL with <M>validateHttpUrl</M> (http/https only) and, when{' '}
                <M>rejectPrivateHosts</M> is on, resolves the host with <M>resolvedHostIsPublic</M>.
                A bad scheme/shape throws <M>BAD_URL</M>; a private/unreachable host throws{' '}
                <M>FORBIDDEN_HOST</M>.
              </>
            ),
          },
          {
            title: 'Initial GET',
            body: (
              <>
                Fetches the URL. If the status is <em>not</em> <M>402</M>, the response passes
                straight through unpaid — you get <M>{'{ status, body, paid: false }'}</M>.
              </>
            ),
          },
          {
            title: 'Parse + validate the PaymentRequiredResponse',
            body: (
              <>
                A 402 body that is not JSON throws <M>BAD_INVOICE</M>. Otherwise it runs through{' '}
                <M>parsePaymentRequired(raw, chain.network)</M> — strict field validation and
                selection of the first <M>accepts[]</M> entry matching the chain network and{' '}
                <M>scheme:"exact"</M>. If no entry matches it throws <M>NETWORK_MISMATCH</M>.
              </>
            ),
          },
          {
            title: 'Price check',
            body: (
              <>
                When <M>maxPriceMotes</M> is set and the invoice exceeds it, throws{' '}
                <M>PRICE_EXCEEDED</M> — nothing is charged.
              </>
            ),
          },
          {
            title: 'Pay',
            body: (
              <>
                Calls <M>chain.transfer</M> with{' '}
                <M>{'{ to: req.payTo, amountMotes: req.maxAmountRequired, transferId: req.extra.nonce }'}</M>
                , then sleeps <M>settleDelayMs</M>.
              </>
            ),
          },
          {
            title: 'Retry with X-PAYMENT proof',
            body: (
              <>
                Re-requests with the <M>X-PAYMENT</M> header set (base64-encoded{' '}
                <M>PaymentPayload</M>). A non-402 response returns the paid result; the{' '}
                <M>X-PAYMENT-RESPONSE</M> header is decoded into <M>settlement</M>. A 402 carrying
                a <M>Retry-After</M> header (the gateway&apos;s <M>settlement_pending</M> state) is
                retried up to 5 times, sleeping the <M>Retry-After</M> seconds (capped at 30 s); a
                402 <em>without</em> <M>Retry-After</M> (proof rejected) — or the last 402 once the
                retries are spent — is returned immediately with <M>paid: true</M>.
              </>
            ),
          },
        ]}
      />
      <Callout tone="warn" title="NATIVE TRANSFER MINIMUM: 2.5 CSPR">
        Casper rejects native transfers below <M>2500000000</M> motes (2.5 CSPR).{' '}
        <M>fetchPaid</M> pays exactly <M>maxAmountRequired</M> — it never rounds up — so in live
        mode an invoice priced below 2.5 CSPR cannot be settled on this rail. Sellers should price
        at or above it (see <DocLink href="/docs/sellers">Wrap an API</DocLink>).
      </Callout>
      <P>The resolved object has these fields:</P>
      <PropList
        items={[
          {
            name: 'status',
            type: 'number',
            required: true,
            desc: <>The HTTP status of the final response (the passthrough or the paid retry).</>,
          },
          {
            name: 'body',
            type: 'unknown',
            required: true,
            desc: (
              <>
                The response body: parsed JSON when the upstream returned JSON, the raw text
                otherwise, or <M>null</M> for an empty body.
              </>
            ),
          },
          {
            name: 'paid',
            type: 'boolean',
            required: true,
            desc: (
              <>
                <M>true</M> if a payment was made (the request started as a 402); <M>false</M> for a
                non-402 passthrough.
              </>
            ),
          },
          {
            name: 'requirements',
            type: 'PaymentRequirements',
            required: false,
            desc: (
              <>
                The selected <M>accepts[]</M> entry that was paid. Contains <M>maxAmountRequired</M>,{' '}
                <M>payTo</M>, <M>extra.nonce</M>, <M>description</M>, etc. Present only on the paid
                path; absent on a passthrough.
              </>
            ),
          },
          {
            name: 'settlement',
            type: 'SettlementResponse',
            required: false,
            desc: (
              <>
                Decoded <M>X-PAYMENT-RESPONSE</M> from the paid 200 response. Contains{' '}
                <M>success:true</M>, <M>transaction</M> (deploy hash), <M>network</M>, and{' '}
                <M>payer</M> (account-hash). Present only when the gateway included the header.
              </>
            ),
          },
          {
            name: 'deployHash',
            type: 'string',
            required: false,
            desc: (
              <>
                The deploy hash of the CSPR transfer that settled the invoice. Present only on the
                paid path.
              </>
            ),
          },
          {
            name: 'priceMotes',
            type: 'Motes (decimal string)',
            required: false,
            desc: (
              <>
                The amount paid, in motes (equal to <M>invoice.priceMotes</M>). Present only on the
                paid path.
              </>
            ),
          },
        ]}
      />
      <Callout tone="warn" title="paid: true DOES NOT GUARANTEE 2xx">
        If the proof is rejected (a 402 with no <M>Retry-After</M> header), or still pending after
        all 5 retries, <M>fetchPaid</M> returns the last <M>402</M> with <M>paid: true</M> — the
        transfer happened but the gateway has not served. Always check <M>status</M> in addition to{' '}
        <M>paid</M> before trusting <M>body</M>.
      </Callout>

      <H2 id="parse-invoice">parsePaymentRequired(raw, network)</H2>
      <P>
        <M>parsePaymentRequired(raw, network)</M> is the strict runtime validator{' '}
        <M>fetchPaid</M> uses internally, exported so you can validate a 402 body yourself. It takes
        an unknown value (typically <M>await res.json()</M>) and a chain network string, finds the
        first <M>accepts[]</M> entry matching <M>network</M> and <M>scheme:"exact"</M>, and returns
        a fully typed <M>PaymentRequirements</M>, or throws — <M>BAD_INVOICE</M> (502) for a
        malformed or expired body, <M>NETWORK_MISMATCH</M> (502) when the body parses but offers no
        entry on your network.
      </P>
      <DocTable
        head={['Check', 'Rule enforced']}
        rows={[
          [<M key="v">x402Version</M>, <>Must be exactly <M>1</M>.</>],
          [<M key="a">accepts</M>, 'Must be a non-empty array.'],
          [
            <M key="m">accepts[].network match</M>,
            <>At least one entry must match the supplied <M>network</M>.</>,
          ],
          [
            <M key="sc">accepts[].scheme</M>,
            <>Must equal <M>"exact"</M>.</>,
          ],
          [
            <M key="p">accepts[].maxAmountRequired</M>,
            <>
              String that parses as motes via <M>parseMotes</M>.
            </>,
          ],
          [
            <M key="pt">accepts[].payTo</M>,
            <>
              Matches <M>account-hash-&lt;64 hex&gt;</M>.
            </>,
          ],
          [
            <M key="nc">accepts[].extra.nonce</M>,
            <>
              u64 decimal string (1–20 digits, &le; 2<sup>64</sup>−1) used as the native transfer
              id — though the gateway issues it as a positive integer &le; 2<sup>53</sup>−2 so it
              stays exact as a CSPR.cloud float64 transfer id.
            </>,
          ],
          [
            <M key="e">accepts[].extra.expiresAtMs</M>,
            <>
              Positive unix-ms timestamp strictly in the future (an already-expired nonce is
              refused).
            </>,
          ],
        ]}
      />
      <P>
        A valid 402 challenge body — the shape it validates — looks like this.{' '}
        <M>maxTimeoutSeconds</M> is gateway-configured (<M>INVOICE_TTL_MS</M>; the default is 300,
        the public gateway runs 600) and <M>extra.expiresAtMs</M> is the invoice issue time plus
        that TTL:
      </P>
      <CodeBlock label="PaymentRequiredResponse (application/json)" code={INVOICE_SHAPE} />
      <P>Validating a raw 402 response by hand:</P>
      <CodeBlock label="typescript" code={PARSE_EXAMPLE} />

      <H2 id="errors">Errors thrown</H2>
      <P>
        Every failure is an <M>AgentGateError</M> carrying a stable machine-readable{' '}
        <M>code</M>, a human <M>message</M>, and an HTTP-style <M>httpStatus</M>. Catch it and branch
        on <M>err.code</M> (use the <M>isAgentGateError</M> guard or <M>instanceof</M>). These are
        the codes the SDK itself raises:
      </P>
      <DocTable
        head={['code', 'httpStatus', 'When it is thrown']}
        rows={[
          [
            <M key="bo">BAD_OPTS</M>,
            '500',
            'createAgentGateClient got a non-object, a chain without transfer(), or a non-mock/pem signer.',
          ],
          [
            <M key="bu">BAD_URL</M>,
            '400',
            'The url is empty/blank, or fails http(s) URL validation (bad scheme or shape).',
          ],
          [
            <M key="fh">FORBIDDEN_HOST</M>,
            '400',
            'rejectPrivateHosts is on and the URL points at — or resolves to — a private/loopback/link-local/unreachable host.',
          ],
          [
            <M key="nm">NETWORK_MISMATCH</M>,
            '502',
            'No accepts[] entry in the PaymentRequiredResponse matches the chain client network — refusing to pay on the wrong chain.',
          ],
          [
            <M key="pe">PRICE_EXCEEDED</M>,
            '402',
            'maxPriceMotes is set and the invoice price exceeds it. Nothing is charged.',
          ],
          [
            <M key="bi">BAD_INVOICE</M>,
            '502',
            'The 402 body is not JSON, fails PaymentRequiredResponse validation (missing x402Version/accepts[], or no accepts[] entry with scheme "exact"), or has an already-expired nonce. A body that parses but offers no entry on the client network throws NETWORK_MISMATCH instead.',
          ],
          [
            <M key="ut">UPSTREAM_TIMEOUT</M>,
            '504',
            'An upstream GET exceeded requestTimeoutMs (or the supplied signal aborted).',
          ],
          [
            <M key="ia">INVALID_AMOUNT</M>,
            '400',
            'maxPriceMotes is not a parseable motes string (raised by parseMotes at construction).',
          ],
        ]}
      />
      <Callout tone="info" title="REFUSALS ARE NORMAL">
        <M>PRICE_EXCEEDED</M>, <M>NETWORK_MISMATCH</M>, <M>FORBIDDEN_HOST</M> and <M>BAD_INVOICE</M>{' '}
        are deliberate guard refusals, not bugs — they fire <em>before</em> any payment. The bundled
        buyer agent catches <M>PRICE_EXCEEDED</M> and turns it into a clean budget refusal. For the
        complete, cross-package catalog see{' '}
        <DocLink href="/docs/errors">Error codes</DocLink>.
      </Callout>

      <H2 id="complete-example">A complete example</H2>
      <P>
        Construct a <M>ChainClient</M>, build the client with a price cap, call <M>fetchPaid</M>, and
        handle both the paid and passthrough paths plus typed errors:
      </P>
      <CodeBlock label="agent.ts" code={FULL_EXAMPLE} />
      <P>
        To run it offline (no node, no key), bring up the mock stack first —{' '}
        <M>npm run dev:seed</M> starts the devnet (<M>:4030</M>) and gateway (<M>:4021</M>) and
        seeds service #1 — then export a funded buyer identity:{' '}
        <M>npm run agentgate -- demo-accounts --mode mock</M> prints the{' '}
        <M>MOCK_BUYER_ACCOUNT</M> line to export. Without it, <M>config.mockBuyerAccount</M> is an
        empty string and the devnet rejects the unfunded transfer. See{' '}
        <DocLink href="/docs/quickstart">Quickstart</DocLink>.
      </P>
      <CommandBlock text="AGENTGATE_MODE=mock npx tsx agent.ts" />
      <P>
        To flip to live, set <M>AGENTGATE_MODE=live</M> and supply a PEM signer and{' '}
        <M>CSPR_CLOUD_API_KEY</M>. <M>loadConfig</M> also refuses the default{' '}
        <M>AGENTGATE_ADMIN_TOKEN</M> in live mode — even for buyer-side scripts that never touch
        the admin API — unless you pass <M>{'{ requireStrongAdminToken: false }'}</M>, as the
        example does. See{' '}
        <DocLink href="/docs/configuration">Configuration</DocLink>. The endpoint passed to{' '}
        <M>fetchPaid</M> is the public gateway URL <M>/svc/:id</M> — never the seller&apos;s
        private upstream.
      </P>
      <P>
        For a higher-level, batteries-included loop (on-chain discovery, an LLM that picks a service,
        budget enforcement and attestation receipts) see{' '}
        <DocLink href="/docs/buyers">Build an agent</DocLink>. For the server side of the 402
        exchange — the paywall, proof headers and admin API — see the{' '}
        <DocLink href="/docs/api">HTTP API</DocLink>.
      </P>
      <ApiBadge method="GET" path="/svc/:id" />
      <P>
        The endpoint <M>fetchPaid</M> targets answers <M>402</M> with a{' '}
        <M>PaymentRequiredResponse</M> on an unproven request and proxies to the upstream once the{' '}
        <M>X-PAYMENT</M> proof (base64-encoded <M>PaymentPayload</M>) verifies on-chain. The paid
        200 carries <M>X-PAYMENT-RESPONSE</M> (decoded into <M>settlement</M>).
      </P>

      <NextLinks
        links={[
          { href: '/docs/buyers', label: 'Build an agent' },
          { href: '/docs/api', label: 'HTTP API' },
        ]}
      />
    </>
  );
}
