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
  PropList,
  StepFlow,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/protocol' },
  title: 'How it works',
  description:
    'A concepts walkthrough of the x402 V1 payment protocol: discovery, the 402 PaymentRequiredResponse challenge (accepts[] / PaymentRequirements), a native CSPR transfer carrying the nonce as transfer_id, the X-PAYMENT proof header, on-chain verification, single-use nonce burning, the upstream proxy, and the attestation that feeds a trust score.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="CONCEPTS"
        title="How it works"
        lede="AgentGate is an HTTP-402 payment gateway for AI agents following the x402 V1 wire format. A buyer agent discovers a service, receives a machine-readable 402 PaymentRequiredResponse (accepts[] with PaymentRequirements), pays with a native CSPR transfer whose transfer_id is the invoice nonce, then retries with the X-PAYMENT proof header. The gateway verifies the transfer on-chain, burns the nonce, proxies to the upstream API, and records an attestation that updates the service's trust score."
      />

      <H2 id="flow">The flow at a glance</H2>
      <P>
        Every paid request follows the same three-leg exchange: an unpaid <M>402</M> challenge,
        an on-chain payment, and a retry that carries proof of that payment. The gateway is a
        reverse proxy in front of the seller&apos;s real API; buyers never need an API key, and
        the upstream URL — which may embed the seller&apos;s own key — is stored only in the
        gateway&apos;s private map and never appears in any response. The steps below are the
        exact sequence the gateway
        (<M>packages/middleware/src/app.ts</M>) and the buyer client
        (<M>packages/client/src/index.ts</M>) implement.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Discover',
            body: (
              <>
                The buyer client (the agent-side SDK, <M>packages/client</M>) reads the on-chain
                registry to find services and their{' '}
                <DocLink href="/docs/protocol#attestation">trust scores</DocLink>, choosing one to call. Each
                service record carries a public gateway URL (<M>/svc/:id</M>) — never the upstream.
              </>
            ),
          },
          {
            title: 'Request the service',
            body: (
              <>
                The buyer client issues the request to <M>GET /svc/:id</M> (any method is accepted via{' '}
                <M>app.all</M>) with no payment headers. The gateway resolves the service from a
                60-second cache, rejects it if inactive (<M>403 service_inactive</M>) or unmapped
                (<M>503 service_unavailable</M>), and rejects non-JSON request bodies before
                charging (<M>415</M>).
              </>
            ),
          },
          {
            title: 'Receive the 402 challenge (PaymentRequiredResponse)',
            body: (
              <>
                With no <M>X-PAYMENT</M> header, the gateway mints a fresh invoice — a random nonce
                plus an <M>expiresAtMs</M> deadline — persists it, and replies <M>402</M> with a{' '}
                <M>PaymentRequiredResponse</M> JSON body: <M>x402Version:1</M>,{' '}
                <M>error:"X-PAYMENT header is required"</M>, and an <M>accepts[]</M> array containing
                one <M>PaymentRequirements</M> entry.
              </>
            ),
            code: 'HTTP/1.1 402 Payment Required\nContent-Type: application/json\n\n{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{"scheme":"exact","network":"casper-test",...}]}',
          },
          {
            title: 'Pay with a native CSPR transfer',
            body: (
              <>
                The buyer client validates the response (<M>parsePaymentRequired</M> — selects
                the <M>accepts[]</M> entry matching the chain network and <M>scheme:"exact"</M>),
                refuses prices above its cap (<M>PRICE_EXCEEDED</M>), then sends a native CSPR
                transfer of exactly <M>maxAmountRequired</M> motes — so sub-2.5-CSPR invoices
                cannot settle on this rail (see{' '}
                <DocLink href="/docs/protocol#payment">Payment</DocLink>) — to <M>payTo</M> with{' '}
                <M>transfer_id = extra.nonce</M>. The transfer&apos;s deploy hash becomes the
                payment proof.
              </>
            ),
          },
          {
            title: 'Retry with proof',
            body: (
              <>
                After a settle delay the buyer client retries the same request with the{' '}
                <M>X-PAYMENT</M> header — a base64-encoded{' '}
                <M>PaymentPayload</M>: <M>x402Version:1</M>, <M>scheme:"exact"</M>,{' '}
                <M>network:"casper-test"</M>, and <M>payload.transaction</M> (the deploy hash),{' '}
                <M>payload.transferId</M> (the nonce), <M>payload.from</M> (optional — ignored by
                the gateway; payer identity is read from the on-chain transfer).
              </>
            ),
          },
          {
            title: 'Verify on-chain',
            body: (
              <>
                The gateway decodes the <M>X-PAYMENT</M> header, validates invoice state (nonce
                must exist, be unused, and be within <M>expiresAtMs</M>), then calls{' '}
                <M>chain.verifyTransfer</M> to check the transfer&apos;s target, amount, transfer
                id, and age (see <DocLink href="/docs/protocol#verification">Verification rules</DocLink>). A
                still-settling transfer returns <M>402</M> with <M>error:"settlement_pending"</M>{' '}
                and a <M>Retry-After: 2</M> response header.
              </>
            ),
          },
          {
            title: 'Burn the nonce (single-use)',
            body: (
              <>
                Before any upstream call, the nonce is marked used atomically. Exactly one
                concurrent request wins the compare-and-set; every other holder of the same proof
                gets a fresh <M>402 invoice_used</M>.
              </>
            ),
          },
          {
            title: 'Proxy to the upstream',
            body: (
              <>
                The gateway forwards the request to the mapped upstream URL (a strict header
                whitelist; the <M>X-PAYMENT</M> proof header is stripped), passing the upstream
                status and content-type back to the agent. Every paid response — whatever status
                the upstream returned, and even a proxy failure — carries{' '}
                <M>X-PAYMENT-RESPONSE</M> (base64 <M>SettlementResponse</M> with{' '}
                <M>success:true</M> meaning the payment settled, plus <M>transaction</M>,{' '}
                <M>network</M>, <M>payer</M>). The upstream URL never appears in any response.
              </>
            ),
          },
          {
            title: 'Record an attestation',
            body: (
              <>
                After responding, the gateway fires a non-blocking on-chain attestation —{' '}
                <M>{'{ serviceId, paymentDeployHash, success }'}</M> where{' '}
                <M>success</M> is true iff the upstream returned a 2xx — unless the payer is the
                service&apos;s own owner/payout account, or the upstream never returned a
                response. On failure it retries with exponential backoff (default 4 total
                attempts: 5 s, 10 s, 20 s).
              </>
            ),
          },
          {
            title: 'Update the trust score',
            body: (
              <>
                Each attestation increments the service&apos;s on-chain counters
                (<M>totalCalls</M>, and <M>successCalls</M> on success). Those counters map to a
                trust tier the next discovering agent reads (see{' '}
                <DocLink href="/docs/protocol#attestation">Attestation and trust score</DocLink>).
              </>
            ),
          },
        ]}
      />

      <H2 id="invoice">The 402 challenge body (PaymentRequiredResponse)</H2>
      <P>
        The body of every <M>402</M> response is a <M>PaymentRequiredResponse</M> — the x402 V1
        envelope that tells the agent exactly how to pay. It is defined in{' '}
        <M>packages/shared/src/x402.ts</M> and built by the gateway in{' '}
        <M>buildRequirements()</M>/<M>respond402Fresh()</M>. The protocol version number is fixed:{' '}
        <M>x402Version: 1</M>.
      </P>
      <CodeBlock
        label="402 response body (PaymentRequiredResponse)"
        code={[
          '{',
          '  "x402Version": 1,',
          '  "error": "X-PAYMENT header is required",',
          '  "accepts": [',
          '    {',
          '      "scheme": "exact",',
          '      "network": "casper-test",',
          '      "maxAmountRequired": "2500000000",',
          '      "asset": "CSPR",',
          '      "payTo": "account-hash-19ff...b5f0",',
          '      "resource": "https://gateway.example.org/svc/5",',
          '      "description": "RWA FX & Gold Oracle",',
          '      "maxTimeoutSeconds": 600,',
          '      "extra": {',
          '        "nonce": "4521903117755646",',
          '        "serviceId": 5,',
          '        "expiresAtMs": 1782966672306,',
          '        "settlement": "casper-native-transfer",',
          '        "transferIdEncoding": "u64-decimal"',
          '      }',
          '    }',
          '  ]',
          '}',
        ].join('\n')}
      />
      <P>
        <strong className="text-white">Settlement model:</strong>{' '}
        <M>scheme:"exact"</M> with <M>extra.settlement:"casper-native-transfer"</M> is a
        settled-transfer-proof variant — the buyer broadcasts the native CSPR transfer themselves
        (using <M>extra.nonce</M> as the <M>transfer_id</M>) and the gateway verifies it. There is
        no x402 facilitator on Casper testnet.
      </P>
      <PropList
        items={[
          {
            name: 'x402Version',
            type: 'number (1)',
            required: true,
            desc: <>Fixed x402 protocol version. The client requires an exact match.</>,
          },
          {
            name: 'error',
            type: 'string',
            required: true,
            desc: (
              <>
                Human-readable reason. Fresh challenge: <M>"X-PAYMENT header is required"</M>.
                Rejected proof: one of the <M>PaywallErrorCode</M> strings (e.g.{' '}
                <M>"amount_too_low"</M>). Pending: <M>"settlement_pending"</M>.
              </>
            ),
          },
          {
            name: 'accepts',
            type: 'PaymentRequirements[]',
            required: true,
            desc: (
              <>
                One or more acceptable payment methods. Clients select the entry whose{' '}
                <M>network</M> matches the chain they are on and <M>scheme === "exact"</M>.
              </>
            ),
          },
          {
            name: 'accepts[].scheme',
            type: '"exact"',
            required: true,
            desc: <>x402 payment scheme — always <M>"exact"</M> for AgentGate.</>,
          },
          {
            name: 'accepts[].network',
            type: 'string',
            required: true,
            desc: (
              <>
                Chain name — <M>mock</M> or <M>casper-test</M>. The client throws{' '}
                <M>NETWORK_MISMATCH</M> if no entry matches its own network.
              </>
            ),
          },
          {
            name: 'accepts[].maxAmountRequired',
            type: 'string (motes)',
            required: true,
            desc: (
              <>
                Price in motes of native CSPR as a decimal string. 1 CSPR = 1,000,000,000 motes.
                U512-safe via bigint — never parse it as a JS number. Replaces the old{' '}
                <M>priceMotes</M>.
              </>
            ),
          },
          {
            name: 'accepts[].payTo',
            type: 'string',
            required: true,
            desc: (
              <>
                Recipient account in <M>account-hash-&lt;64 hex&gt;</M> format. The CSPR transfer
                must go here. Replaces the old <M>paymentTarget</M>.
              </>
            ),
          },
          {
            name: 'accepts[].resource',
            type: 'string (URL)',
            required: true,
            desc: <>Absolute URL of the protected resource (<M>/svc/:id</M>).</>,
          },
          {
            name: 'accepts[].description',
            type: 'string',
            required: true,
            desc: <>The service name from on-chain registration (non-empty).</>,
          },
          {
            name: 'accepts[].maxTimeoutSeconds',
            type: 'number',
            required: true,
            desc: (
              <>
                <M>INVOICE_TTL_MS / 1000</M> — deadline in seconds from issuance. The default{' '}
                <M>INVOICE_TTL_MS</M> is 300000 ms; the hosted gateway runs 600000, so live
                responses show <M>600</M>.
              </>
            ),
          },
          {
            name: 'accepts[].extra.nonce',
            type: 'string (decimal ≤ 2^53−2)',
            required: true,
            desc: (
              <>
                Per-invoice decimal string — a positive integer ≤ 2^53−2
                (9,007,199,254,740,990; at most 16 digits), capped below{' '}
                <M>Number.MAX_SAFE_INTEGER</M> because CSPR.cloud returns transfer ids as float64.
                Used verbatim as the transfer&apos;s <M>transfer_id</M> and echoed back in{' '}
                <M>payload.transferId</M> of the <M>X-PAYMENT</M> header.
              </>
            ),
          },
          {
            name: 'accepts[].extra.expiresAtMs',
            type: 'number',
            required: true,
            desc: (
              <>
                Unix-ms deadline, strictly greater than &quot;now&quot; when issued. Replaces the
                old <M>expiresAt</M>.
              </>
            ),
          },
          {
            name: 'accepts[].extra.settlement',
            type: '"casper-native-transfer"',
            required: true,
            desc: (
              <>
                Identifies the settled-transfer-proof variant: the buyer broadcasts the transfer;
                the gateway verifies the deploy hash.
              </>
            ),
          },
          {
            name: 'accepts[].asset',
            type: '"CSPR"',
            required: true,
            desc: <>Native CSPR (no token contract). Always present; the reference client does not validate it.</>,
          },
          {
            name: 'accepts[].extra.transferIdEncoding',
            type: '"u64-decimal"',
            required: true,
            desc: <>How the nonce is encoded as the native transfer_id. Always present; the reference client does not validate it.</>,
          },
        ]}
      />
      <H3 id="invoice-rejection-fields">Rejection fields in the 402 body</H3>
      <P>
        Every <M>402</M> response is a full <M>PaymentRequiredResponse</M>. The <M>error</M> field
        always carries the reason. For a still-settling transfer the error is{' '}
        <M>"settlement_pending"</M> and the response also carries a standard{' '}
        <M>Retry-After: 2</M> response header (seconds) — the same invoice is kept alive. Every
        other rejection re-issues a fresh <M>accepts[]</M> with a new nonce.
      </P>

      <H2 id="payment">Payment and proof headers</H2>
      <P>
        Payment is a <strong className="text-white">native CSPR transfer</strong>, not a token
        transfer. The buyer client calls <M>chain.transfer</M> with <M>accepts[].payTo</M>,{' '}
        <M>accepts[].maxAmountRequired</M>, and crucially{' '}
        <M>transferId = accepts[].extra.nonce</M> — the invoice nonce is reused verbatim as the
        Casper <M>transfer_id</M>, which binds the on-chain payment to this specific invoice.
        The transfer returns a deploy hash. After a settle delay the client base64-encodes a{' '}
        <M>PaymentPayload</M> and sends it as the <M>X-PAYMENT</M> request header.
      </P>
      <Callout tone="warn" title="Network minimum: 2.5 CSPR per native transfer">
        Casper rejects native transfers below 2.5 CSPR (<M>2500000000</M> motes) at submit.
        Verification only requires <M>amount ≥ maxAmountRequired</M> — overpayment is accepted —
        but the bundled buyers (<M>agentgate buy</M>, the SDK&apos;s <M>fetchPaid</M>, the LLM
        agent) pay <em>exactly</em> the invoiced amount, so a service priced below 2.5 CSPR can
        only be settled by a manual buyer that deliberately overpays. Price services at ≥ 2.5
        CSPR.
      </Callout>
      <DocTable
        head={['Header', 'Direction', 'Carries']}
        rows={[
          [
            <M key="h1">X-PAYMENT</M>,
            'request (retry)',
            <>
              base64(JSON): <M>x402Version:1</M>, <M>scheme:"exact"</M>,{' '}
              <M>network:"casper-test"</M>, <M>payload.transaction</M> (deploy hash),{' '}
              <M>payload.transferId</M> (nonce), <M>payload.from</M> (optional, ignored — the
              gateway derives the payer from the transfer itself; the reference client omits it).
            </>,
          ],
          [
            <M key="h2">X-PAYMENT-RESPONSE</M>,
            'response (any paid reply)',
            <>
              base64(JSON): <M>success:true</M>, <M>transaction</M> (deploy hash),{' '}
              <M>network</M>, <M>payer</M> (account-hash). New in x402 V1.
            </>,
          ],
        ]}
      />
      <P>
        Header names are case-insensitive on the wire. The <M>X-PAYMENT</M> proof header is
        consumed by the gateway and is never forwarded to the upstream API.
      </P>

      <H2 id="verification">Verification rules</H2>
      <P>
        When a retry arrives with proof headers, the gateway first checks the invoice behind the
        presented nonce (it must exist, match the requested <M>serviceId</M>, be unused, and be
        within <M>expiresAtMs</M>). It then verifies the transfer on-chain via{' '}
        <M>
          chain.verifyTransfer({'{'} deployHash, expectedTarget, minAmountMotes, expectedTransferId,
          maxAgeMs {'}'})
        </M>. The deploy must first exist and contain a native transfer (<M>not_found</M>{' '}
        otherwise); then four checks — evaluated in the order target → transfer id → amount →
        age — must all pass:
      </P>
      <DocTable
        head={['#', 'Check', 'Rule', 'On failure']}
        rows={[
          [
            '0',
            'Exists',
            <span key="r0">
              The deploy hash resolves to at least one native transfer.
            </span>,
            <M key="e0">not_found</M>,
          ],
          [
            '1',
            'Target',
            <span key="r1">
              <M>transfer.to</M> exactly equals the service&apos;s <M>paymentTarget</M>.
            </span>,
            <M key="e1">wrong_target</M>,
          ],
          [
            '2',
            'Transfer id',
            <span key="r2">
              <M>transfer.transfer_id</M> equals the invoice nonce.
            </span>,
            <M key="e2">wrong_transfer_id</M>,
          ],
          [
            '3',
            'Amount',
            <span key="r3">
              <M>transfer.amount ≥ priceMotes</M> (bigint comparison — overpayment is accepted).
            </span>,
            <M key="e3">amount_too_low</M>,
          ],
          [
            '4',
            'Age',
            <span key="r4">
              Deploy age is within <M>maxAgeMs</M> (the invoice TTL).
            </span>,
            <M key="e4">expired</M>,
          ],
        ]}
      />
      <P>
        A transfer that exists but has not finalized yet returns <M>settlement_pending</M> rather than a
        failure: the gateway keeps the same <M>accepts[]</M> alive (same nonce) and answers{' '}
        <M>402</M> with <M>error:"settlement_pending"</M> and a standard{' '}
        <M>Retry-After: 2</M> response header (seconds) so the buyer can re-present the identical
        proof shortly. Every other verification failure re-sends a fresh{' '}
        <M>PaymentRequiredResponse</M> (new nonce) so a client can re-pay.
      </P>

      <H2 id="single-use">Single-use nonce and idempotency</H2>
      <P>
        Once all four checks pass, the gateway burns the nonce{' '}
        <strong className="text-white">before</strong> it proxies to the upstream. The invoice
        store&apos;s <M>markUsed()</M> is a compare-and-set: exactly one concurrent request can
        consume a given nonce. Any other request presenting the same proof loses the race and
        receives a fresh <M>402 invoice_used</M>. A burned nonce stays burned even if the
        upstream call then fails — proof is consumed at most once, so a buyer is charged for at
        most one delivered call per invoice.
      </P>
      <DocTable
        head={['Situation', 'Outcome']}
        rows={[
          [
            'Proof replayed after a successful call',
            <span key="o1">
              <M>402 invoice_used</M> — the nonce is dead; re-pay against a new invoice.
            </span>,
          ],
          [
            'Two concurrent retries, same proof',
            'One wins and is proxied; the other gets invoice_used.',
          ],
          [
            'Transfer still settling',
            <span key="o3">
              <M>402</M> + <M>error:"settlement_pending"</M> + <M>Retry-After: 2</M> (header,
              seconds) — same nonce stays alive; retry the same <M>X-PAYMENT</M> proof.
            </span>,
          ],
          [
            'Upstream fails after the burn',
            'Nonce remains used; the buyer is not silently re-charged.',
          ],
        ]}
      />
      <Callout tone="info" title="Client-side pending retries">
        The buyer client (<M>fetchPaid</M>) retries a <M>settlement_pending</M> response up to five
        times, sleeping the <M>Retry-After</M> value in seconds (capped at 30,000 ms per wait), then
        returns whatever the gateway last sent.
      </Callout>

      <H2 id="attestation">Attestation and trust score</H2>
      <P>
        After the buyer&apos;s response is sent, the gateway records an on-chain attestation
        without blocking the request. The attestation input is{' '}
        <M>{'{ serviceId, paymentDeployHash, success }'}</M>, where{' '}
        <M>success</M> is true exactly when the upstream returned a 2xx (<M>isUpstreamSuccess</M>).
        If the attestation transaction fails, the gateway retries with exponential backoff — base
        delay 5,000 ms doubling per attempt (5 s, 10 s, 20 s), up to 4 total attempts. A final
        failure is only logged and never affects the buyer; a call whose attempts all fail is
        under-counted, never over-counted.
      </P>
      <P>
        Two situations record <strong className="text-white">no attestation at all</strong>: a
        gateway-level proxy failure (<M>upstream_unreachable</M>, <M>upstream_timeout</M>,{' '}
        <M>upstream_response_too_large</M>, <M>upstream_request_too_large</M> — the upstream never
        returned a usable response, so the call is not scored either way), and a self-payment — a
        payer whose account is the service&apos;s own <M>owner</M> or <M>paymentTarget</M> never
        earns trust (wash-trade guard).
      </P>
      <P>
        Attestations accumulate into a per-service <M>ServiceScore</M> of two counters:{' '}
        <M>totalCalls</M> and <M>successCalls</M>. <M>trustTier()</M> maps those integer counters
        to a badge using exact integer math (no float boundaries):
      </P>
      <DocTable
        head={['Tier', 'Condition']}
        rows={[
          [
            <M key="t1">new</M>,
            <span key="c1">
              <M>totalCalls &lt; 5</M>, or any score that does not meet a higher tier.
            </span>,
          ],
          [
            <M key="t2">reliable</M>,
            <span key="c2">
              <M>totalCalls ≥ 5</M> and success ratio ≥ 0.9 (<M>successCalls × 10 ≥ totalCalls × 9</M>).
            </span>,
          ],
          [
            <M key="t3">trusted</M>,
            <span key="c3">
              <M>totalCalls ≥ 25</M> and success ratio ≥ 0.95 (<M>successCalls × 100 ≥ totalCalls × 95</M>).
            </span>,
          ],
        ]}
      />
      <P>
        Malformed scores (negative counters, or <M>successCalls &gt; totalCalls</M>) never earn a
        badge and fall back to <M>new</M>. A discovering agent reads this tier alongside the
        service record, closing the loop: usage produces attestations, attestations produce a
        score, and the score guides the next agent&apos;s choice.
      </P>

      <NextLinks
        links={[
          { href: '/docs/architecture', label: 'Architecture' },
          { href: '/docs/api', label: 'HTTP API reference' },
        ]}
      />
    </>
  );
}
