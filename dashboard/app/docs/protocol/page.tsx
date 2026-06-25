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
  title: 'How it works',
  description:
    'A concepts walkthrough of the AgentGate-402 protocol: discovery, the 402 Invoice402 challenge, a native CSPR transfer carrying the nonce as transfer_id, on-chain verification, single-use nonce burning, the upstream proxy, and the attestation that feeds a trust score.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="CONCEPTS"
        title="How it works"
        lede="AgentGate is an HTTP-402 payment gateway for AI agents. A buyer agent discovers a service, receives a machine-readable 402 invoice, pays with a native CSPR transfer whose transfer_id is the invoice nonce, then retries with proof headers. The gateway verifies the transfer on-chain, burns the nonce, proxies to the upstream API, and records an attestation that updates the service's trust score."
      />

      <H2 id="flow">The flow at a glance</H2>
      <P>
        Every paid request follows the same single round trip: an unpaid <M>402</M> challenge,
        an on-chain payment, and a retry that carries proof of that payment. The gateway is a
        reverse proxy in front of the seller&apos;s real API; it never holds an API key and
        never reveals the upstream URL. The steps below are the exact sequence the gateway
        (<M>packages/middleware/src/app.ts</M>) and the buyer client
        (<M>packages/client/src/index.ts</M>) implement.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Discover',
            body: (
              <>
                The agent reads the on-chain registry to find services and their{' '}
                <DocLink href="/docs/protocol">trust scores</DocLink>, choosing one to call. Each
                service record carries a public gateway URL (<M>/svc/:id</M>) — never the upstream.
              </>
            ),
          },
          {
            title: 'Request the service',
            body: (
              <>
                The agent issues the request to <M>GET /svc/:id</M> (any method is accepted via{' '}
                <M>app.all</M>) with no payment headers. The gateway resolves the service from a
                60-second cache, rejects it if inactive (<M>403 service_inactive</M>) or unmapped
                (<M>503 service_unavailable</M>), and rejects non-JSON request bodies before
                charging (<M>415</M>).
              </>
            ),
          },
          {
            title: 'Receive a 402 Invoice402',
            body: (
              <>
                With no proof present, the gateway mints a fresh invoice — a random nonce plus an{' '}
                <M>expiresAt</M> deadline (<M>now + invoiceTtlMs</M>) — persists it, and replies{' '}
                <M>402</M> with the <M>Invoice402</M> body and the{' '}
                <M>X-AgentGate-Price</M> / <M>X-AgentGate-Nonce</M> headers.
              </>
            ),
            code: 'HTTP/1.1 402 Payment Required\nX-AgentGate-Price: 500000000\nX-AgentGate-Nonce: 4521903117755646001',
          },
          {
            title: 'Pay with a native CSPR transfer',
            body: (
              <>
                The client validates the invoice (<M>parseInvoice402</M>), refuses prices above its
                cap, then sends a native CSPR transfer of <M>priceMotes</M> to{' '}
                <M>paymentTarget</M> with <M>transfer_id = nonce</M>. The transfer&apos;s deploy
                hash becomes the payment proof.
              </>
            ),
          },
          {
            title: 'Retry with proof',
            body: (
              <>
                After a settle delay the client retries the same request, now carrying{' '}
                <M>X-Payment-Deploy-Hash</M> (the transfer&apos;s deploy hash) and{' '}
                <M>X-Payment-Nonce</M> (the invoice nonce).
              </>
            ),
          },
          {
            title: 'Verify on-chain',
            body: (
              <>
                The gateway revalidates the invoice, then calls <M>chain.verifyTransfer</M> to
                check the transfer&apos;s target, amount, transfer id, and age against the invoice
                (see <DocLink href="/docs/protocol">Verification rules</DocLink>). A
                still-settling transfer returns <M>402 pending</M> with <M>retry_after_ms</M>.
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
                whitelist; payment headers are stripped), passing the upstream status and
                content-type back to the agent. The upstream URL never appears in any response.
              </>
            ),
          },
          {
            title: 'Record an attestation',
            body: (
              <>
                After responding, the gateway fires a non-blocking on-chain attestation —{' '}
                <M>{'{ serviceId, paymentDeployHash, success }'}</M> where{' '}
                <M>success</M> is true iff the upstream returned a 2xx. It retries exactly once on
                failure.
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
                <DocLink href="/docs/protocol">Attestation and trust score</DocLink>).
              </>
            ),
          },
        ]}
      />

      <H2 id="invoice">The Invoice402 body</H2>
      <P>
        The body of every <M>402</M> response is an <M>Invoice402</M> — the agent&apos;s single
        source of truth for how to pay. It is defined in <M>packages/shared/src/types.ts</M> and
        built by the gateway in <M>buildInvoiceBody</M>. The protocol version string is fixed:{' '}
        <M>agentgate-402/1</M>.
      </P>
      <CodeBlock
        label="402 response body (Invoice402)"
        code={[
          '{',
          '  "version": "agentgate-402/1",',
          '  "network": "casper-test",',
          '  "serviceId": 7,',
          '  "serviceName": "Weather Oracle",',
          '  "priceMotes": "500000000",',
          '  "paymentTarget": "account-hash-3b0c...e91f",',
          '  "nonce": "4521903117755646001",',
          '  "expiresAt": 1750000000000,',
          '  "instructions": "Pay 0.5 CSPR as a native CSPR transfer to account-hash-3b0c...e91f with transfer_id=4521903117755646001 before 2026-06-25T12:00:00.000Z, then retry this request with headers \'X-Payment-Deploy-Hash: <your deploy hash>\' and \'X-Payment-Nonce: 4521903117755646001\'."',
          '}',
        ].join('\n')}
      />
      <PropList
        items={[
          {
            name: 'version',
            type: "'agentgate-402/1'",
            required: true,
            desc: <>Fixed protocol version string. The client requires an exact match.</>,
          },
          {
            name: 'network',
            type: 'string',
            required: true,
            desc: (
              <>
                Chain name — <M>mock</M> or <M>casper-test</M>. The client refuses to pay if this
                differs from its own chain&apos;s network.
              </>
            ),
          },
          {
            name: 'serviceId',
            type: 'number',
            required: true,
            desc: <>The on-chain service id (non-negative integer).</>,
          },
          {
            name: 'serviceName',
            type: 'string',
            required: true,
            desc: <>The service name from on-chain registration (non-empty).</>,
          },
          {
            name: 'priceMotes',
            type: 'Motes (string)',
            required: true,
            desc: (
              <>
                Price in motes of native CSPR as a decimal string. 1 CSPR = 1,000,000,000 motes.
                U512-safe via bigint — never parse it as a JS number.
              </>
            ),
          },
          {
            name: 'paymentTarget',
            type: 'string',
            required: true,
            desc: (
              <>
                Recipient account in <M>account-hash-&lt;64 hex&gt;</M> format. The CSPR transfer
                must go here.
              </>
            ),
          },
          {
            name: 'nonce',
            type: 'string',
            required: true,
            desc: (
              <>
                Per-invoice u64 decimal string (1–20 digits, ≤ 18,446,744,073,709,551,615). Used
                verbatim as the transfer&apos;s <M>transfer_id</M> and echoed back in{' '}
                <M>X-Payment-Nonce</M>.
              </>
            ),
          },
          {
            name: 'expiresAt',
            type: 'number',
            required: true,
            desc: (
              <>
                Unix-ms deadline, strictly greater than &quot;now&quot; when issued. The client
                refuses an already-expired invoice.
              </>
            ),
          },
          {
            name: 'instructions',
            type: 'string',
            required: true,
            desc: (
              <>
                Human-readable how-to-pay: the formatted CSPR price, target, deadline ISO string
                and the exact retry headers.
              </>
            ),
          },
        ]}
      />
      <H3 id="invoice-rejection-fields">Rejection fields</H3>
      <P>
        On the HTTP wire the body is an <M>Invoice402Body</M> — the invoice plus, when a previous
        proof was rejected, an <M>error</M> reason code, and when the transfer is still settling,
        a <M>retry_after_ms</M> of <M>2000</M>. These appear only on a rejected retry, never on
        the first fresh challenge.
      </P>

      <H2 id="payment">Payment and proof headers</H2>
      <P>
        Payment is a <strong className="text-white">native CSPR transfer</strong>, not a token
        transfer. The client calls <M>chain.transfer</M> with the invoice&apos;s{' '}
        <M>paymentTarget</M>, <M>priceMotes</M>, and crucially{' '}
        <M>transferId = nonce</M> — the invoice nonce is reused verbatim as the Casper{' '}
        <M>transfer_id</M>, which is what binds the on-chain payment to this specific invoice.
        The transfer returns a deploy hash, and after a settle delay the client retries the
        request with two proof headers.
      </P>
      <DocTable
        head={['Header', 'Direction', 'Carries']}
        rows={[
          [
            <M key="h1">X-Payment-Deploy-Hash</M>,
            'request (retry)',
            'Deploy hash of the buyer’s native CSPR transfer.',
          ],
          [
            <M key="h2">X-Payment-Nonce</M>,
            'request (retry)',
            'The invoice nonce — u64 decimal string, must match the transfer_id used on-chain.',
          ],
          [
            <M key="h3">X-AgentGate-Price</M>,
            'response (402)',
            'Price in motes — mirrors priceMotes.',
          ],
          [
            <M key="h4">X-AgentGate-Nonce</M>,
            'response (402)',
            'The issued nonce for this invoice — mirrors nonce.',
          ],
        ]}
      />
      <P>
        Header names are case-insensitive on the wire. The two payment headers are consumed by
        the gateway and are never forwarded to the upstream API.
      </P>

      <H2 id="verification">Verification rules</H2>
      <P>
        When a retry arrives with proof headers, the gateway first checks the invoice behind the
        presented nonce (it must exist, match the requested <M>serviceId</M>, be unused, and be
        within <M>expiresAt</M>). It then verifies the transfer on-chain via{' '}
        <M>
          chain.verifyTransfer({'{'} deployHash, expectedTarget, minAmountMotes, expectedTransferId,
          maxAgeMs {'}'})
        </M>{' '}
        — four checks, all of which must pass:
      </P>
      <DocTable
        head={['#', 'Check', 'Rule', 'On failure']}
        rows={[
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
            'Amount',
            <span key="r2">
              <M>transfer.amount ≥ priceMotes</M> (bigint comparison — overpayment is accepted).
            </span>,
            <M key="e2">amount_too_low</M>,
          ],
          [
            '3',
            'Transfer id',
            <span key="r3">
              <M>transfer.transfer_id</M> equals the invoice nonce.
            </span>,
            <M key="e3">wrong_transfer_id</M>,
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
        A transfer that exists but has not finalized yet returns <M>pending</M> rather than a
        failure: the gateway keeps the same invoice alive and answers <M>402</M> with{' '}
        <M>retry_after_ms: 2000</M> so the buyer can re-present the identical proof shortly.
        Every other verification failure re-sends a fresh invoice so a client can re-read the
        price and re-pay against a new nonce.
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
              <M>402 pending</M> + <M>retry_after_ms: 2000</M> — same invoice stays alive; retry the
              same proof.
            </span>,
          ],
          [
            'Upstream fails after the burn',
            'Nonce remains used; the buyer is not silently re-charged.',
          ],
        ]}
      />
      <Callout tone="info" title="Client-side pending retries">
        The buyer client (<M>fetchPaid</M>) retries a <M>pending</M> response up to five times,
        honoring <M>retry_after_ms</M> (capped at 30,000 ms per wait), then returns whatever the
        gateway last sent.
      </Callout>

      <H2 id="attestation">Attestation and trust score</H2>
      <P>
        After the buyer&apos;s response is sent, the gateway records an on-chain attestation
        without blocking the request. The attestation input is{' '}
        <M>{'{ serviceId, paymentDeployHash, success }'}</M>, where{' '}
        <M>success</M> is true exactly when the upstream returned a 2xx (<M>isUpstreamSuccess</M>).
        If the attestation transaction fails, the gateway retries it once after a delay
        (default 5,000 ms); a final failure is only logged and never affects the buyer.
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
