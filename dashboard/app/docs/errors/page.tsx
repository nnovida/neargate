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
  title: 'Error codes',
  description:
    'Every AgentGate error code: the AgentGateError(code, message, httpStatus) shape, the lowercased JSON error body, and a code-by-code reference grouped by config, chain/live, the 402 paywall + admin API, the client SDK, the buyer agent, and the CLI.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="reference"
        title="Error codes"
        lede="AgentGate fails loudly with one structured error type. This page lists every code the codebase throws — its HTTP status, what it means, and how to fix it — grouped by the package that raises it."
      />

      {/* ════════════════════════════ THE SHAPE ════════════════════════════ */}
      <H2 id="shape">The error shape</H2>
      <P>
        Every package throws a single error class, <M>AgentGateError</M>, defined in{' '}
        <M>packages/shared/src/errors.ts</M>. It carries three fields: a stable machine-readable{' '}
        <M>code</M>, a human <M>message</M>, and the <M>httpStatus</M> a server should respond with
        when the error escapes (defaults to <M>500</M>).
      </P>

      <CodeBlock
        label="packages/shared/src/errors.ts"
        code={
          'export class AgentGateError extends Error {\n' +
          '  readonly code: string;\n' +
          '  readonly httpStatus: number;\n' +
          '  constructor(code: string, message: string, httpStatus = 500) { /* ... */ }\n' +
          '}\n' +
          '\n' +
          '// Type guard used at every catch site:\n' +
          'export function isAgentGateError(err: unknown): err is AgentGateError;'
        }
      />

      <P>
        Codes come in two casing conventions, both intentional. Internal/programmatic codes are{' '}
        <M>SCREAMING_SNAKE_CASE</M> (e.g. <M>NOT_DEPLOYED</M>, <M>PRICE_EXCEEDED</M>). HTTP-facing
        codes that the gateway sends on the wire are already <M>lowercase_snake_case</M> (e.g.{' '}
        <M>service_not_found</M>, <M>rate_limited</M>).
      </P>

      <H3 id="json-body">JSON error bodies</H3>
      <P>
        The gateway&apos;s final error handler (<M>packages/middleware/src/app.ts</M>) serializes
        any escaping <M>AgentGateError</M> as a JSON object whose single <M>error</M> field is the{' '}
        <em>lowercased</em> code, and responds with the error&apos;s <M>httpStatus</M>:
      </P>

      <CodeBlock
        label="middleware error handler (simplified)"
        code={
          "if (err instanceof AgentGateError) {\n" +
          "  res.status(err.httpStatus).json({ error: err.code.toLowerCase() });\n" +
          "}\n" +
          "// any other (non-AgentGateError) throw:\n" +
          "res.status(500).json({ error: 'internal_error' });"
        }
      />

      <P>
        So a <M>CONFIG_INVALID</M> thrown deep inside a request becomes{' '}
        <M>{'{ "error": "config_invalid" }'}</M> over HTTP, while the codes already emitted directly
        by the gateway (the 402 reasons, <M>service_not_found</M>, etc.) are returned verbatim.
        Bodies never leak the upstream URL, stack traces, or token material — only the code.
      </P>

      <Callout tone="info" title="Where to read more">
        Codes prefixed <M>CSPR_CLOUD_*</M>, <M>TX_*</M>, <M>RPC_*</M> and <M>NOT_DEPLOYED</M> only
        appear in <M>live</M> mode (Casper Testnet). In <M>mock</M> mode the chain is the in-process
        devnet and these never fire. See <DocLink href="/docs/configuration">Configuration</DocLink>{' '}
        for the mode switch.
      </Callout>

      {/* ════════════════════════════ CONFIG ════════════════════════════ */}
      <H2 id="config">Configuration errors</H2>
      <P>
        Raised by <M>loadConfig()</M> (<M>packages/shared/src/config.ts</M>) and the money helpers (
        <M>packages/shared/src/money.ts</M>) while reading the environment contract. All are{' '}
        thrown at startup before any work begins, so a bad config never half-runs.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="ci">CONFIG_INVALID</M>,
            '500',
            'An env var is missing, malformed, or an invalid combination: unknown AGENTGATE_MODE; a non-integer port/timeout; a bad URL; live mode without CSPR_CLOUD_API_KEY; or live mode still using the default AGENTGATE_ADMIN_TOKEN.',
            'Read the message — it names the exact variable and the constraint it violated. Set a valid value and restart.',
          ],
          [
            <M key="ia">INVALID_AMOUNT</M>,
            '400',
            'A CSPR/motes value (e.g. BUYER_BUDGET_CSPR, --price, maxPriceMotes) is not a plain non-negative decimal string within ≤ 9 decimal places.',
            'Pass a positive decimal string of CSPR (e.g. "0.5") or an integer motes string — no signs, exponents, or commas.',
          ],
        ]}
      />

      {/* ════════════════════════════ CHAIN / LIVE ════════════════════════════ */}
      <H2 id="chain">Chain / live-mode errors</H2>
      <P>
        Thrown by the live Casper client (<M>packages/chain/src/live.ts</M>) when talking to the
        node RPC, CSPR.cloud REST, or decoding contract state. These are the failures you hit on
        Testnet; in mock mode the in-process devnet is used instead.
      </P>

      <Callout tone="warn" title="Contract deploy is out of scope">
        Until <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> is set, every contract-dependent live path throws{' '}
        <M>NOT_DEPLOYED</M> (503). The registry contract deploy is deferred — there is no live
        contract address yet, so live reads/writes are expected to surface this code.
      </Callout>

      <H3 id="chain-deploy">Deploy &amp; transactions</H3>
      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="nd">NOT_DEPLOYED</M>,
            '503',
            'A contract call/read was attempted while REGISTRY_CONTRACT_PACKAGE_HASH is unset.',
            'Deploy the registry contract and set REGISTRY_CONTRACT_PACKAGE_HASH to its package hash (deferred — see the deploy notes).',
          ],
          [
            <M key="tf">TX_FAILED</M>,
            '502',
            'A submitted transaction executed but reverted on-chain (the execution result carried an errorMessage). This is deterministic and is never retried.',
            'Inspect the on-chain error (gas, args, auth). Fix the cause and resubmit; retrying the same tx will fail the same way.',
          ],
          [
            <M key="tt">TX_TIMEOUT</M>,
            '504',
            'A transaction was accepted but did not execute within the 120 s wait window.',
            'Check the deploy hash on a block explorer; the network may be slow or congested. Increase confirmation patience and retry if it never lands.',
          ],
          [
            <M key="re">RPC_ERROR</M>,
            '502',
            'node RPC putTransaction failed (the node rejected the submission).',
            'Verify CASPER_NODE_URL points at a healthy node and the signed tx is well-formed.',
          ],
          [
            <M key="rt">RPC_TIMEOUT</M>,
            '504',
            'A node-RPC call (status / put / get / dictionary read) exceeded the per-call timeout (UPSTREAM_TIMEOUT_MS).',
            'The node is slow or half-open. Retry; switch CASPER_NODE_URL to a faster endpoint or raise UPSTREAM_TIMEOUT_MS.',
          ],
        ]}
      />

      <H3 id="chain-cspr-cloud">CSPR.cloud reads</H3>
      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="cce">CSPR_CLOUD_ERROR</M>,
            '502',
            'CSPR.cloud answered non-2xx, returned a non-JSON body, or returned a motes amount that was not an integer string (rejected to avoid precision loss in verifyTransfer).',
            'Check CSPR_CLOUD_API_KEY is valid and CSPR_CLOUD_API_URL is correct. The message includes the status and a snippet of the response.',
          ],
          [
            <M key="cct">CSPR_CLOUD_TIMEOUT</M>,
            '504',
            'The CSPR.cloud request aborted on the UPSTREAM_TIMEOUT_MS deadline.',
            'Retry; CSPR.cloud or the network is slow. Raise UPSTREAM_TIMEOUT_MS if persistent.',
          ],
          [
            <M key="ccu">CSPR_CLOUD_UNREACHABLE</M>,
            '502',
            'The fetch to CSPR.cloud failed at the transport layer (DNS/connection refused, etc.) — not a timeout.',
            'Confirm outbound network access and that CSPR_CLOUD_API_URL resolves.',
          ],
          [
            <M key="crf">CONTRACT_RESOLVE_FAILED</M>,
            '502',
            'CSPR.cloud could not resolve an active contract hash for the registry package hash.',
            'Confirm REGISTRY_CONTRACT_PACKAGE_HASH names a real, deployed package on this network.',
          ],
        ]}
      />

      <H3 id="chain-state">State decoding &amp; signers</H3>
      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="spf">STATE_PARSE_FAILED</M>,
            '502',
            'A dictionary value did not match the expected Odra storage shape: bad List<U8> length prefix, an unparseable Service/score struct, or services_count exceeding 2^53.',
            'Usually a contract/codec mismatch (storage index or struct field order). Verify the deployed contract matches the reader assumptions in live.ts.',
          ],
          [
            <M key="spu">SIGNER_PEM_UNREADABLE</M>,
            '500',
            'The signer PEM file could not be read (missing path or permissions).',
            'Point the *_SIGNER_PEM_PATH at an existing readable key file (chmod 600 recommended).',
          ],
          [
            <M key="spi">SIGNER_PEM_INVALID</M>,
            '500',
            'The PEM was read but is neither a valid ed25519 nor secp256k1 private key.',
            'Provide a valid Casper secret key PEM (ed25519 or secp256k1).',
          ],
          [
            <M key="is">invalid_signer</M>,
            '400',
            'The live client was given a non-pem signer (e.g. a mock signer) for a signing operation.',
            'Use a pem signer in live mode; only mock mode accepts mock signers.',
          ],
          [
            <M key="iah">invalid_account_hash</M>,
            '400',
            'An account argument was not an "account-hash-<64 hex>" string.',
            'Pass a well-formed account hash.',
          ],
          [
            <M key="iq">invalid_query</M>,
            '400',
            'A read/write argument failed validation: empty account, non-positive serviceId, bad amountMotes, or out-of-range transferId.',
            'Correct the offending argument per the message.',
          ],
          [
            <M key="en">empty_name / invalid_price</M>,
            '400',
            'registerService rejected an empty service name, or a priceMotes below the 1000-motes minimum.',
            'Give a non-empty name and a price ≥ 1000 motes.',
          ],
        ]}
      />

      {/* ════════════════════════════ PAYWALL / GATEWAY HTTP ════════════════════════════ */}
      <H2 id="paywall">Paywall &amp; gateway HTTP errors</H2>
      <P>
        These are emitted directly by the middleware (<M>packages/middleware/src/app.ts</M>) and are
        already lowercase on the wire. The 402 reason codes (<M>PaywallErrorCode</M> in{' '}
        <M>packages/middleware/src/types.ts</M>) are attached to the <M>error</M> field of the 402{' '}
        invoice body so a buyer agent can tell <em>why</em> a proof was rejected and decide whether
        to retry or re-pay.
      </P>

      <H3 id="paywall-402">402 reasons (PaywallErrorCode)</H3>
      <P>
        A <M>402</M> response is a JSON <M>Invoice402</M> body. When a previous proof was rejected
        it also carries <M>{'"error"'}</M> (one of the codes below); when the payment is still
        settling it carries <M>{'"error": "pending"'}</M> plus <M>retry_after_ms</M> (2000) and{' '}
        keeps the same invoice alive so the identical proof can be retried.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="ue">unknown_nonce</M>,
            '402',
            'The X-Payment-Nonce header was malformed, unknown, or belonged to a different service. A fresh invoice is issued.',
            'Use the nonce from the most recent 402 invoice for THIS service.',
          ],
          [
            <M key="iu">invoice_used</M>,
            '402',
            'The nonce was already burned — invoices are single-use. A fresh invoice is issued.',
            'Pay against the new invoice/nonce returned in this 402; never reuse a spent nonce.',
          ],
          [
            <M key="iex">invoice_expired</M>,
            '402',
            'The invoice TTL elapsed before a valid proof arrived (INVOICE_TTL_MS, default 5 min). A fresh invoice is issued.',
            'Pay and present proof within the TTL using the new invoice.',
          ],
          [
            <M key="nf">not_found</M>,
            '402',
            'verifyTransfer found no transfer for the given deploy hash (no such deploy).',
            'Send the correct X-Payment-Deploy-Hash of your actual transfer.',
          ],
          [
            <M key="wt">wrong_target</M>,
            '402',
            'The transfer did not pay the service’s paymentTarget.',
            'Transfer to the paymentTarget quoted in the invoice.',
          ],
          [
            <M key="atl">amount_too_low</M>,
            '402',
            'The transfer paid less than the invoice’s priceMotes.',
            'Pay at least the full priceMotes.',
          ],
          [
            <M key="wti">wrong_transfer_id</M>,
            '402',
            'The native transfer’s transfer_id did not equal the invoice nonce.',
            'Set transfer_id = nonce on the CSPR transfer.',
          ],
          [
            <M key="ex">expired</M>,
            '402',
            'The transfer settled but is older than the invoice TTL (replay/stale-proof guard).',
            'Pay fresh against a current invoice; do not reuse an old transfer.',
          ],
          [
            <M key="pe">pending</M>,
            '402',
            'The transfer exists but has not settled yet. Same invoice is kept; retry_after_ms is set.',
            'Wait retry_after_ms and retry the identical proof (the SDK does this up to 5×).',
          ],
        ]}
      />

      <H3 id="paywall-http">Gateway HTTP status codes</H3>
      <P>
        Other gateway outcomes return a plain <M>{'{ "error": "<code>" }'}</M> body with the status
        below.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="snf">service_not_found</M>,
            '404',
            'The :id was not a valid id or no such service is registered on-chain.',
            'Use an existing on-chain service id.',
          ],
          [
            <M key="si">service_inactive</M>,
            '403',
            'The service exists but its on-chain active flag is false (paused by its owner).',
            'Wait for the owner to resume it (agentgate resume <id>).',
          ],
          [
            <M key="su">service_unavailable</M>,
            '503',
            'The service is registered on-chain but has no upstream mapping on this gateway, or (live) its upstream host now resolves to a forbidden/private address. Never charged.',
            'Map the upstream via POST /admin/services; in live mode ensure the upstream resolves to a public host.',
          ],
          [
            <M key="umt">unsupported_media_type</M>,
            '415',
            'A non-JSON request body was sent to the paywalled proxy. The gateway only forwards JSON bodies, so it refuses BEFORE charging.',
            'Send application/json (or no body for GET/HEAD).',
          ],
          [
            <M key="rl">rate_limited</M>,
            '429',
            'Too many requests: /svc/* allows 60/min, /admin/* allows 20/min, keyed by client IP. Includes draft-7 RateLimit-* headers.',
            'Back off and retry after the window; honor the RateLimit-Reset header.',
          ],
          [
            <M key="ptl">payload_too_large</M>,
            '413',
            'The JSON request body exceeded the 256 KB limit.',
            'Send a smaller body.',
          ],
          [
            <M key="ij">invalid_json</M>,
            '400',
            'The request declared JSON but the body failed to parse.',
            'Send well-formed JSON.',
          ],
          [
            <M key="un">unauthorized</M>,
            '401',
            'An /admin/* request had a missing or wrong Authorization: Bearer <admin token> (constant-time compared).',
            'Send Authorization: Bearer $AGENTGATE_ADMIN_TOKEN matching the gateway’s token.',
          ],
          [
            <M key="ib">invalid_body / invalid_service_id</M>,
            '400',
            'An /admin/services request had a non-object body or a serviceId that was not a non-negative safe integer.',
            'POST { "serviceId": <int>, "upstreamUrl": "<http(s) url>" } with valid types.',
          ],
          [
            <M key="nfx">not_found</M>,
            '404',
            'No route matched (the catch-all fallback).',
            'Check the path; see the HTTP API reference.',
          ],
          [
            <M key="ie">internal_error</M>,
            '500',
            'An unexpected (non-AgentGateError) exception escaped; details are logged, not returned.',
            'Check the gateway logs for the underlying error.',
          ],
        ]}
      />

      <Callout tone="info" title="Admin upstream validation">
        <M>POST /admin/services</M> also returns <M>400</M> with the SSRF-guard&apos;s own reason
        codes (e.g. <M>not_http_url</M>, <M>forbidden_host</M>) when the supplied{' '}
        <M>upstreamUrl</M> is not an acceptable public http(s) URL. See{' '}
        <DocLink href="/docs/security">Security</DocLink> for the host policy.
      </Callout>

      {/* ════════════════════════════ CLIENT / SDK ════════════════════════════ */}
      <H2 id="client">Client SDK errors</H2>
      <P>
        Thrown by <M>createAgentGateClient().fetchPaid()</M> in the buyer-side SDK (
        <M>packages/client/src/index.ts</M>). These surface as <M>AgentGateError</M> at the call
        site — your agent catches them, not the gateway.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="bu">BAD_URL</M>,
            '400',
            'fetchPaid was given an empty, non-string, or non-http(s) URL.',
            'Pass a valid http(s) endpoint URL.',
          ],
          [
            <M key="fh">FORBIDDEN_HOST</M>,
            '400',
            'SSRF guard: the URL’s host is (or resolves to) a private / loopback / link-local address while rejectPrivateHosts is on (default in live mode).',
            'Only fetch public hosts in live mode; the endpointUrl is seller-controlled on-chain data.',
          ],
          [
            <M key="nm">NETWORK_MISMATCH</M>,
            '502',
            'The 402 invoice’s network differs from the chain client’s network — refusing to pay on the wrong chain.',
            'Use a client configured for the same network the invoice was issued on.',
          ],
          [
            <M key="px">PRICE_EXCEEDED</M>,
            '402',
            'The invoice priceMotes exceeds the caller’s maxPriceMotes cap. No payment is sent.',
            'Raise maxPriceMotes if the price is acceptable, or skip the service. (The buyer agent treats this as a budget refusal.)',
          ],
          [
            <M key="bi">BAD_INVOICE</M>,
            '502',
            'The 402 body was not JSON or failed strict Invoice402 validation (version, network, serviceId, priceMotes, paymentTarget, nonce, expiresAt, instructions — including an already-expired invoice).',
            'The gateway returned a malformed/expired invoice — investigate the server; do not pay.',
          ],
          [
            <M key="ut">UPSTREAM_TIMEOUT</M>,
            '504',
            'A fetchPaid request (initial or proof retry) timed out (requestTimeoutMs, default 30 s).',
            'Retry; raise requestTimeoutMs if the upstream is legitimately slow.',
          ],
          [
            <M key="bo">BAD_OPTS</M>,
            '500',
            'createAgentGateClient was misconfigured: missing options object, a chain without transfer(), or a signer that is neither mock nor pem.',
            'Pass { chain, signer } with a valid ChainClient and a mock/pem signer.',
          ],
        ]}
      />

      {/* ════════════════════════════ BUYER AGENT ════════════════════════════ */}
      <H2 id="buyer">Buyer-agent errors</H2>
      <P>
        Thrown by <M>runBuyerAgent()</M> and the LLM seam (
        <M>packages/buyer-agent/src/index.ts</M>, <M>llm.ts</M>). They are also appended to the
        JSONL decision trace before being re-thrown.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="bt">BAD_TASK</M>,
            '400',
            'runBuyerAgent was called with a missing or blank task string.',
            'Pass a non-empty natural-language task.',
          ],
          [
            <M key="ns">NO_SERVICES</M>,
            '404',
            'No services are registered on-chain (or none active for the MockLlm to choose from).',
            'Register at least one active service (agentgate wrap …) before running the agent.',
          ],
          [
            <M key="nsg">NO_SIGNER</M>,
            '500',
            'No buyer signer could be derived: mock mode without MOCK_BUYER_ACCOUNT, or live mode without BUYER_SIGNER_PEM_PATH.',
            'Mock: run `agentgate demo-accounts` and export the printed MOCK_BUYER_ACCOUNT. Live: set BUYER_SIGNER_PEM_PATH.',
          ],
          [
            <M key="lc">LLM_CONFIG</M>,
            '500',
            'AnthropicLlm was constructed without an apiKey or model id.',
            'Set ANTHROPIC_API_KEY and LLM_MODEL (or let the agent fall back to MockLlm).',
          ],
          [
            <M key="lh">LLM_HTTP</M>,
            '502',
            'The Anthropic Messages API responded non-2xx.',
            'Check the API key, model id, and quota; the message includes the status.',
          ],
          [
            <M key="lr">LLM_REFUSED</M>,
            '502',
            'The Anthropic API returned stop_reason "refusal".',
            'Rephrase the task; the model declined to answer.',
          ],
          [
            <M key="lbr">LLM_BAD_RESPONSE</M>,
            '502',
            'The Anthropic reply was non-JSON, had no content/text, or did not yield a valid {serviceId, reason} object even after one retry.',
            'Transient model output issue — retry; the prompt already retries malformed JSON once.',
          ],
          [
            <M key="lbc">LLM_BAD_CHOICE</M>,
            '502',
            'The model chose a serviceId that does not exist in the catalog or that is inactive.',
            'Usually transient; retry. Ensure the intended service is registered and active.',
          ],
          [
            <M key="ff">FETCH_FAILED</M>,
            '—',
            'A fallback code recorded in the decision trace when a non-AgentGateError fetch failure occurs during the paid call. The original error is re-thrown.',
            'Inspect the underlying network/HTTP error in the decision log.',
          ],
        ]}
      />

      {/* ════════════════════════════ CLI ════════════════════════════ */}
      <H2 id="cli">CLI errors</H2>
      <P>
        Thrown by the <M>agentgate</M> CLI (<M>packages/cli/src/*</M>) during input validation and
        the wrap/demo flows. The bin prints them as <M>error: &lt;CODE&gt;: &lt;message&gt;</M> and
        exits <M>1</M>.
      </P>

      <DocTable
        head={['Code', 'HTTP', 'Meaning', 'How to fix']}
        rows={[
          [
            <M key="ii">INVALID_INPUT</M>,
            '400',
            'A required on-chain text field was empty/blank, contained control characters, or exceeded its max length (name ≤ 128, description ≤ 512).',
            'Provide printable, bounded text for --name / --description.',
          ],
          [
            <M key="isi">INVALID_SERVICE_ID</M>,
            '400',
            'A service id argument (status / pause / resume) was not a positive integer.',
            'Pass a positive integer id (ids are 1-based).',
          ],
          [
            <M key="iu2">INVALID_URL</M>,
            '400',
            'A URL (upstream or gateway/dashboard base) was not a valid http(s) URL, or a base URL carried a query string / fragment.',
            'Use a clean http:// or https:// URL with no query or fragment.',
          ],
          [
            <M key="isu">INSECURE_URL</M>,
            '400',
            'In live mode a non-localhost gateway base used http:// — the admin Bearer token would be sent in cleartext.',
            'Use https:// for the gateway in live mode (localhost may stay http).',
          ],
          [
            <M key="ip">INVALID_PRICE</M>,
            '400',
            'The --price resolved to ≤ 0 CSPR.',
            'Pass a price > 0 CSPR (e.g. --price 0.5).',
          ],
          [
            <M key="iah2">INVALID_ACCOUNT_HASH</M>,
            '400',
            '--payment-target was not "account-hash-<64 hex>".',
            'Supply a valid account hash (or omit it to derive from the signer).',
          ],
          [
            <M key="ipk">INVALID_PUBLIC_KEY</M>,
            '400',
            '--attestor was not a Casper public key hex ("01"+64 hex or "02"+66 hex).',
            'Supply a valid public key hex (or omit it to use the signer’s key).',
          ],
          [
            <M key="sm">SIGNER_MISSING</M>,
            '400',
            'No seller signer: mock mode without MOCK_SELLER_ACCOUNT, or live mode without SELLER_SIGNER_PEM_PATH.',
            'Mock: export MOCK_SELLER_ACCOUNT from `agentgate demo-accounts`. Live: set SELLER_SIGNER_PEM_PATH.',
          ],
          [
            <M key="mo">MOCK_ONLY</M>,
            '400',
            '`agentgate demo-accounts` was run outside mock mode.',
            'Set AGENTGATE_MODE=mock to create demo accounts.',
          ],
          [
            <M key="gt">GATEWAY_TIMEOUT</M>,
            '504',
            'The mock devnet faucet (demo-accounts) did not respond within the timeout.',
            'Start the devnet (npm run dev), then re-run `agentgate demo-accounts`.',
          ],
          [
            <M key="fu">FAUCET_UNREACHABLE / FAUCET_FAILED</M>,
            '502',
            'The devnet faucet could not be reached, or it answered non-2xx / a malformed balance.',
            'Confirm the devnet is running and reachable at DEVNET_URL.',
          ],
        ]}
      />

      <Callout tone="ok" title="Handling errors programmatically">
        At any call site, narrow with <M>isAgentGateError(err)</M> and branch on <M>err.code</M> —
        as the buyer agent does for <M>PRICE_EXCEEDED</M>. The <M>code</M> is the stable contract;
        the <M>message</M> is for humans and may change.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/api', label: 'HTTP API reference' },
          { href: '/docs/sdk', label: 'Client SDK' },
        ]}
      />
    </>
  );
}
