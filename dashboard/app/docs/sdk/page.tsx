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

export const metadata = { title: 'Client SDK' };

const INSTALL_IMPORT = [
  "import { createAgentGateClient, parseInvoice402 } from '@agentgate/client';",
  "import type { PayAndFetchResult, AgentGateClientOpts } from '@agentgate/client';",
].join('\n');

const FULL_EXAMPLE = [
  "import { createAgentGateClient } from '@agentgate/client';",
  "import { createChainClient } from '@agentgate/chain';",
  "import { loadConfig, AgentGateError } from '@agentgate/shared';",
  '',
  '// 1. Build a ChainClient from the environment (mock or live, by AGENTGATE_MODE).',
  'const config = loadConfig();',
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
  '// 4. One call runs the whole exchange: GET -> 402 -> validate -> pay -> retry-with-proof.',
  'try {',
  '  const res = await client.fetchPaid("https://gateway.example.com/svc/1");',
  '',
  '  if (res.paid) {',
  '    // Paid path: invoice / deployHash / priceMotes are populated.',
  '    console.log("paid", res.priceMotes, "motes -> deploy", res.deployHash);',
  '    console.log("service", res.invoice?.serviceName, "#", res.invoice?.serviceId);',
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
  "import { parseInvoice402 } from '@agentgate/client';",
  '',
  'const res = await fetch("https://gateway.example.com/svc/1");',
  'if (res.status === 402) {',
  '  // Throws AgentGateError("BAD_INVOICE") on any malformed or expired invoice.',
  '  const invoice = parseInvoice402(await res.json());',
  '  console.log(invoice.priceMotes, invoice.nonce, invoice.paymentTarget);',
  '}',
].join('\n');

const INVOICE_SHAPE = [
  '{',
  '  "version": "agentgate-402/1",',
  '  "network": "casper-test",',
  '  "serviceId": 1,',
  '  "serviceName": "RWA FX & Gold Oracle",',
  '  "priceMotes": "500000000",',
  '  "paymentTarget": "account-hash-0000...<64 hex>",',
  '  "nonce": "17283746500000001",',
  '  "expiresAt": 1750000000000,',
  '  "instructions": "Transfer priceMotes to paymentTarget with transfer_id = nonce, then retry with X-Payment-Deploy-Hash and X-Payment-Nonce."',
  '}',
].join('\n');

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Client SDK"
        lede="@agentgate/client is the agent-side payment library. createAgentGateClient(opts) returns a client whose fetchPaid(url) GETs a paid endpoint, parses and validates the 402 invoice, pays a native CSPR transfer carrying the nonce as transfer_id, and retries with proof headers — in a single call."
      />

      <H2 id="install-and-import">Install and import</H2>
      <P>
        <M>@agentgate/client</M> is a workspace package in the monorepo — it ships with the repo and
        is resolved through the npm workspace, so there is nothing extra to install. Import the two
        public entry points and, if you want them, the exported types:
      </P>
      <CodeBlock label="typescript" code={INSTALL_IMPORT} />
      <P>
        The package exports two functions —{' '}
        <M>createAgentGateClient(opts)</M> and <M>parseInvoice402(raw, now?)</M> — plus the proof
        header name constants <M>HEADER_DEPLOY_HASH</M> (<M>X-Payment-Deploy-Hash</M>) and{' '}
        <M>HEADER_NONCE</M> (<M>X-Payment-Nonce</M>), and the types <M>AgentGateClient</M>,{' '}
        <M>AgentGateClientOpts</M> and <M>PayAndFetchResult</M>. The <M>ChainClient</M>,{' '}
        <M>AnySigner</M>, <M>Logger</M>, <M>Motes</M> and <M>Invoice402</M> types it references come
        from <M>@agentgate/shared</M>.
      </P>
      <Callout tone="info" title="WHERE THE CHAIN AND SIGNER COME FROM">
        The SDK does not talk to Casper directly — it depends on a <M>ChainClient</M> you build with{' '}
        <M>createChainClient(config)</M> from <M>@agentgate/chain</M>. That seam is what makes the
        same agent code run offline (<M>AGENTGATE_MODE=mock</M>) or on Casper Testnet (<M>live</M>).
        See <DocLink href="/docs/configuration">Configuration</DocLink>.
      </Callout>

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
                in-process devnet on localhost works.
              </>
            ),
          },
        ]}
      />

      <H2 id="fetch-paid">fetchPaid(url, init?)</H2>
      <P>
        <M>client.fetchPaid(url, init?)</M> runs the entire AgentGate-402 exchange and resolves to a{' '}
        <M>PayAndFetchResult</M>. <M>url</M> must be a non-empty string (otherwise <M>BAD_URL</M>);{' '}
        <M>init</M> is an optional <M>RequestInit</M> forwarded to both the initial GET and the proof
        retry (your <M>headers</M> are preserved and the proof headers are added on top).
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
            title: 'Parse + validate the invoice',
            body: (
              <>
                A 402 body that is not JSON throws <M>BAD_INVOICE</M>. Otherwise it runs through{' '}
                <M>parseInvoice402</M> (strict field validation). If{' '}
                <M>invoice.network !== chain.network</M> it throws <M>NETWORK_MISMATCH</M>.
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
                <M>{'{ to: paymentTarget, amountMotes: priceMotes, transferId: nonce }'}</M>, then
                sleeps <M>settleDelayMs</M>.
              </>
            ),
          },
          {
            title: 'Retry with proof',
            body: (
              <>
                Re-requests with <M>X-Payment-Deploy-Hash</M> and <M>X-Payment-Nonce</M> set. A
                non-402 response returns the paid result. A 402 carrying{' '}
                <M>retry_after_ms</M> (verification pending) is retried up to 5 times, sleeping each
                interval (capped at 30s); after that the last 402 is returned with <M>paid: true</M>.
              </>
            ),
          },
        ]}
      />
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
            name: 'invoice',
            type: 'Invoice402',
            required: false,
            desc: (
              <>
                The validated invoice that was paid. Present only on the paid path; absent on a
                passthrough.
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
        If the proof is still being verified after all 5 pending retries, <M>fetchPaid</M> returns
        the last <M>402</M> with <M>paid: true</M> — the transfer happened but the gateway has not
        served yet. Always check <M>status</M> in addition to <M>paid</M> before trusting{' '}
        <M>body</M>.
      </Callout>

      <H2 id="parse-invoice">parseInvoice402(raw, now?)</H2>
      <P>
        <M>parseInvoice402(raw, now = Date.now())</M> is the strict runtime validator{' '}
        <M>fetchPaid</M> uses internally, exported so you can validate a 402 body yourself. It takes
        an unknown value (typically <M>await res.json()</M>) and returns a fully typed{' '}
        <M>Invoice402</M>, or throws <M>AgentGateError(&apos;BAD_INVOICE&apos;)</M> (HTTP 502) on any
        violation. <M>now</M> is the reference time for the expiry check (override it in tests).
      </P>
      <DocTable
        head={['Field', 'Rule enforced']}
        rows={[
          [<M key="v">version</M>, <>Must equal exactly <M>&quot;agentgate-402/1&quot;</M>.</>],
          [<M key="n">network</M>, 'Non-empty string.'],
          [<M key="s">serviceId</M>, 'Non-negative safe integer.'],
          [<M key="sn">serviceName</M>, 'Non-empty string.'],
          [
            <M key="p">priceMotes</M>,
            <>
              String that parses as motes via <M>parseMotes</M>.
            </>,
          ],
          [
            <M key="pt">paymentTarget</M>,
            <>
              Matches <M>account-hash-&lt;64 hex&gt;</M>.
            </>,
          ],
          [
            <M key="nc">nonce</M>,
            <>
              u64 decimal string (1–20 digits, &le; 2<sup>64</sup>−1) — used as the transfer id.
            </>,
          ],
          [
            <M key="e">expiresAt</M>,
            <>
              Positive unix-ms timestamp that is strictly in the future relative to <M>now</M> (an
              already-expired invoice is refused).
            </>,
          ],
          [<M key="i">instructions</M>, 'Must be a string.'],
        ]}
      />
      <P>A valid invoice body — the shape it returns — looks like this:</P>
      <CodeBlock label="Invoice402 (application/json)" code={INVOICE_SHAPE} />
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
            'The invoice network field does not equal chain.network — refusing to pay across chains.',
          ],
          [
            <M key="pe">PRICE_EXCEEDED</M>,
            '402',
            'maxPriceMotes is set and the invoice price exceeds it. Nothing is charged.',
          ],
          [
            <M key="bi">BAD_INVOICE</M>,
            '502',
            'The 402 body is not JSON, or any Invoice402 field fails strict validation (incl. an already-expired invoice).',
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
        Run it against the offline stack with <M>AGENTGATE_MODE=mock</M> (no node, no key); flip to
        live by setting <M>AGENTGATE_MODE=live</M> and supplying a PEM signer and CSPR.cloud
        credentials. The endpoint passed to <M>fetchPaid</M> is the public gateway URL{' '}
        <M>/svc/:id</M> — never the seller&apos;s private upstream.
      </P>
      <CommandBlock text="AGENTGATE_MODE=mock npx tsx agent.ts" />
      <P>
        For a higher-level, batteries-included loop (on-chain discovery, an LLM that picks a service,
        budget enforcement and attestation receipts) see{' '}
        <DocLink href="/docs/buyers">Build an agent</DocLink>. For the server side of the 402
        exchange — the paywall, proof headers and admin API — see the{' '}
        <DocLink href="/docs/api">HTTP API</DocLink>.
      </P>
      <ApiBadge method="GET" path="/svc/:id" />
      <P>
        The endpoint <M>fetchPaid</M> targets answers <M>402</M> with an <M>Invoice402</M> on an
        unproven request and proxies to the upstream once the <M>X-Payment-Deploy-Hash</M> /{' '}
        <M>X-Payment-Nonce</M> proof verifies on-chain.
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
