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
  Sub,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/protocol' },
  title: 'How it works',
  description:
    'The x402 payment flow on NEAR end to end: the 402 invoice, the registry pay call, the X-PAYMENT proof, verification, the single-use nonce, attestations and trust tiers, the gateway receipts endpoint and the gateway routes.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="CONCEPTS"
        title="How it works"
        lede="An x402 V1 flow settled through the neargate-registry contract: a 402 invoice, a registry pay call, an X-PAYMENT proof, an on-chain check, a single-use nonce and a payment-backed attestation. This page is the spec for a hand-rolled client or gateway."
      />

      <H2 id="flow">The flow at a glance</H2>
      <StepFlow
        steps={[
          {
            title: 'Register',
            body: (
              <>
                The seller calls <M>register_service</M>. The registry stores the name, price list,
                payment target, attestor and the gateway base URL; readers compute the endpoint{' '}
                <M>&lt;gateway&gt;/svc/&lt;id&gt;</M>. The upstream URL never goes on-chain: it is
                mapped on the gateway.
              </>
            ),
          },
          {
            title: 'Challenge — HTTP 402',
            body: (
              <>
                The buyer calls the endpoint with no proof. The gateway issues a fresh invoice with
                a single-use nonce and answers <M>402</M> with a <M>PaymentRequiredResponse</M>.
              </>
            ),
          },
          {
            title: 'Pay through the registry',
            body: (
              <>
                The buyer calls <M>pay(service_id, nonce)</M> on the registry with{' '}
                <M>maxAmountRequired</M> attached (price + <M>0.002 NEAR</M>). The registry forwards
                the price to the seller, keeps the fee, refunds any excess and records the payment
                under the nonce.
              </>
            ),
          },
          {
            title: 'Prove it',
            body: (
              <>
                The buyer retries the request with an <M>X-PAYMENT</M> header naming the transaction,
                the nonce and the payer.
              </>
            ),
          },
          {
            title: 'Verify, burn, serve',
            body: (
              <>
                The gateway checks the registry’s payment record (and, live, the transaction),
                burns the nonce, proxies to the upstream and returns the response with an{' '}
                <M>X-PAYMENT-RESPONSE</M> header.
              </>
            ),
          },
          {
            title: 'Attest and score',
            body: (
              <>
                After answering, the gateway calls <M>record_attestation</M>. The registry accepts
                it only for a real, not self-paid, not yet attested payment, then bumps the
                service’s <M>(total, success)</M> score.
              </>
            ),
          },
        ]}
      />

      <H2 id="invoice">The 402 challenge body</H2>
      <P>
        An unpaid call to <M>/svc/:id</M> answers <M>402</M> with this JSON (<M>x402Version: 1</M>).
        There is always exactly one <M>accepts[]</M> entry, paying in native NEAR. Amounts are{' '}
        <M>yoctoNEAR</M> decimal strings (1 NEAR = 10<sup>24</sup> yocto).
      </P>
      <CodeBlock
        label="402 response (example)"
        code={JSON.stringify(
          {
            x402Version: 1,
            error: 'X-PAYMENT header is required',
            accepts: [
              {
                scheme: 'exact',
                network: 'near-testnet',
                maxAmountRequired: '502000000000000000000000',
                asset: 'NEAR',
                payTo: '<registry account id>',
                resource: '<gateway>/svc/1',
                description: 'RWA FX & Gold Oracle',
                maxTimeoutSeconds: 300,
                extra: {
                  nonce: '3673826824572287',
                  serviceId: 1,
                  expiresAtMs: 1794407336851,
                  settlement: 'neargate-registry-pay',
                  contractId: '<registry account id>',
                  method: 'pay',
                  priceYocto: '500000000000000000000000',
                  storageFeeYocto: '2000000000000000000000',
                  seller: '<payment target account id>',
                  caip2: 'near:testnet',
                },
              },
            ],
          },
          null,
          2,
        )}
      />
      <PropList
        items={[
          {
            name: 'network',
            required: true,
            type: 'string',
            desc: (
              <>
                The gateway’s chain: <M>near-testnet</M>, <M>near-mainnet</M> or <M>near-mock</M>{' '}
                (the offline devnet). A client refuses an invoice for another network (
                <M>NETWORK_MISMATCH</M>).
              </>
            ),
          },
          {
            name: 'maxAmountRequired',
            required: true,
            type: 'yocto string',
            desc: (
              <>
                What the buyer attaches to <M>pay</M>: <M>priceYocto + storageFeeYocto</M>.
              </>
            ),
          },
          {
            name: 'payTo / extra.contractId',
            required: true,
            type: 'NEAR account id',
            desc: 'The registry contract. The buyer pays the registry, never the seller directly; both fields name the same account.',
          },
          {
            name: 'resource',
            required: true,
            type: 'url',
            desc: 'Absolute URL of the paid endpoint.',
          },
          {
            name: 'maxTimeoutSeconds / extra.expiresAtMs',
            required: true,
            type: 'number',
            desc: (
              <>
                How long the invoice lives (the gateway’s <M>INVOICE_TTL_MS</M>, default 5
                minutes) and the moment it expires (unix ms). A client refuses an invoice already
                expired.
              </>
            ),
          },
          {
            name: 'extra.nonce',
            required: true,
            type: '1–20 digits',
            desc: 'The single-use invoice nonce. It is passed to pay and echoed in the X-PAYMENT proof, and it keys the registry’s payment record.',
          },
          {
            name: 'extra.serviceId',
            required: true,
            type: 'positive integer',
            desc: 'The registry service id to pay (the first argument of pay).',
          },
          {
            name: 'extra.settlement / method',
            required: true,
            type: 'string',
            desc: (
              <>
                Always <M>neargate-registry-pay</M> and <M>pay</M>: the one settlement rail.
              </>
            ),
          },
          {
            name: 'extra.priceYocto / storageFeeYocto',
            required: true,
            type: 'yocto string',
            desc: (
              <>
                The service price the seller receives, and the registry’s flat storage fee,
                always <M>2000000000000000000000</M> (0.002 NEAR). A client refuses an invoice whose
                fee or total does not match (<M>BAD_INVOICE</M>).
              </>
            ),
          },
          {
            name: 'extra.seller',
            required: true,
            type: 'NEAR account id',
            desc: 'The service’s payment target: the account that receives exactly priceYocto.',
          },
          {
            name: 'extra.caip2',
            required: true,
            type: 'string',
            desc: (
              <>
                The CAIP-2 id of the network: <M>near:testnet</M>, <M>near:mainnet</M> or{' '}
                <M>near:mock</M>.
              </>
            ),
          },
        ]}
      />

      <H3 id="invoice-rejection-fields">Rejection reasons in the 402 body</H3>
      <P>
        The <M>error</M> field says why the gateway is challenging. After every reason except{' '}
        <M>settlement_pending</M> the body carries a <em>fresh</em> invoice (a new nonce): pay that
        one, do not reuse the old nonce.
      </P>
      <DocTable
        head={['error', 'Meaning']}
        rows={[
          [<M key="1">X-PAYMENT header is required</M>, 'The first call: there was no proof.'],
          [<M key="2">invalid_payment_header</M>, 'The header is not valid base64 JSON of the expected shape, or names a different network than the gateway.'],
          [<M key="3">relayer_disabled</M>, 'The proof is a delegate (gasless) payload. That rail is off; pay with a tx proof.'],
          [<M key="4">unknown_nonce</M>, 'The gateway issued no invoice with that nonce for this service (or forgot it after a restart without a persistent invoice store).'],
          [<M key="5">invoice_used</M>, 'That invoice was already redeemed. A nonce serves one call.'],
          [<M key="6">invoice_expired</M>, 'The invoice is older than its time to live.'],
          [<M key="7">not_found</M>, 'The registry holds no payment for the nonce.'],
          [<M key="8">wrong_service</M>, 'The payment under that nonce was made for another service.'],
          [<M key="9">amount_too_low</M>, 'The price the registry forwarded is below the service price.'],
          [<M key="10">expired</M>, 'The registry payment is older than the invoice time to live.'],
          [<M key="11">already_attested</M>, 'The payment was already attested, which only follows a served call.'],
          [<M key="12">tx_mismatch</M>, 'Live: the transaction is not a successful pay of this nonce and service on this registry, signed by the named payer.'],
          [<M key="13">settlement_pending</M>, 'Live: the payment is not yet visible. The same invoice stays valid: retry the identical proof after the Retry-After seconds (2).'],
        ]}
      />

      <H2 id="payment">Payment and proof</H2>
      <H3 id="payment-pay">The pay call</H3>
      <P>
        The buyer signs a call to the registry’s <M>pay</M> method with the invoice’s{' '}
        <M>serviceId</M> and <M>nonce</M> and <M>maxAmountRequired</M> attached as the deposit. The
        registry panics (<M>ERR_*</M>, see the <DocLink href="/docs/contract#errors">contract</DocLink>)
        if the service is inactive, the deposit is below <M>price + 0.002 NEAR</M>, the nonce is
        malformed, or the nonce was ever used before — a nonce is single-use across the whole
        registry. Otherwise it forwards exactly the price to the payment target, keeps the fee,
        refunds the excess to the payer and stores the payment, flagging it <M>self_paid</M> when
        the payer is the service owner or payment target.
      </P>
      <H3 id="payment-header">The X-PAYMENT header</H3>
      <P>
        The proof is the base64 encoding of this JSON, sent on the retried request:
      </P>
      <CodeBlock
        label="X-PAYMENT (decoded)"
        code={JSON.stringify(
          {
            x402Version: 1,
            scheme: 'exact',
            network: 'near-testnet',
            payload: {
              kind: 'tx',
              transaction: '<base58 tx hash of the pay call>',
              nonce: '3673826824572287',
              payer: '<buyer account id>',
            },
          },
          null,
          2,
        )}
      />
      <P>
        <M>transaction</M> is the base58 hash of the <M>pay</M> transaction; <M>payer</M> is the
        account that signed it. A <M>kind: &quot;delegate&quot;</M> payload (a NEP-366 signed delegate
        action the gateway would relay) is reserved for a gasless rail that is not enabled; the
        gateway answers it <M>relayer_disabled</M>.
      </P>
      <H3 id="payment-response">The X-PAYMENT-RESPONSE header</H3>
      <P>
        A served call carries <M>X-PAYMENT-RESPONSE</M>: base64 JSON{' '}
        <M>{'{ success, transaction, network, payer }'}</M> confirming which payment was redeemed.
        It is set on every call the gateway processed after verifying the payment — including one
        whose upstream then failed, because the buyer did pay.
      </P>

      <H2 id="verification">Verification rules</H2>
      <P>
        For a request carrying a proof the gateway checks, in this order, and answers a <M>402</M>{' '}
        with the matching <DocLink href="#invoice-rejection-fields">reason</DocLink> at the first
        failure:
      </P>
      <DocTable
        head={['#', 'Check', 'Reason on failure']}
        rows={[
          ['1', 'The header decodes to a tx proof for this gateway’s network.', 'invalid_payment_header, relayer_disabled'],
          ['2', 'An invoice with that nonce exists, for this service, unused and unexpired.', 'unknown_nonce, invoice_used, invoice_expired'],
          [
            '3',
            <span key="3">
              The registry’s <M>get_payment(nonce)</M> view (read at <M>optimistic</M> finality, so a
              payment counts as soon as its transaction executes): exists, for this service, price at
              least the service price, younger than the invoice time to live, not yet attested.
            </span>,
            'not_found, wrong_service, amount_too_low, expired, already_attested',
          ],
          [
            '4',
            <span key="4">
              Live only: the transaction itself. Via the RPC, it must be signed by the named payer,
              received by the registry, hold a <M>pay</M> action with the same service id and nonce,
              and have succeeded. While it cannot yet be shown the answer is pending.
            </span>,
            'tx_mismatch, settlement_pending',
          ],
          ['5', 'The nonce is burned (below).', 'invoice_used'],
        ]}
      />
      <P>
        Other statuses the paywall route can answer: <M>404 service_not_found</M>,{' '}
        <M>403 service_inactive</M> (the owner paused it), <M>503 service_unavailable</M> (no
        upstream is mapped on this gateway, or in live mode the upstream host is not public — and a
        call that cannot be delivered is never charged), <M>415 unsupported_media_type</M> (a
        request body that is not JSON, refused before any invoice) and <M>429 rate_limited</M> (60
        requests per minute per client on <M>/svc</M>).
      </P>

      <H2 id="single-use">Single-use nonce and idempotency</H2>
      <P>
        Once a proof verifies, the gateway <strong className="text-white">burns the nonce before it
        proxies</strong>: the call is single-use even if the upstream then fails, and when several
        requests race on one proof exactly one wins and the rest get <M>invoice_used</M>. The
        registry enforces the same rule on-chain — <M>pay</M> refuses a reused nonce with{' '}
        <M>ERR_NONCE_USED</M> — so a nonce can never be paid twice, anywhere.
      </P>
      <P>
        The consequence for a client: <strong className="text-white">after you have paid, a failed
        call is not a reason to pay again</strong>. Re-present the same proof; if the gateway
        answers <M>settlement_pending</M> wait and resend it; only an invoice the gateway never
        issued or that expired unused needs a new payment. The client package turns a paid call that
        was not served into <M>PAID_NOT_SERVED</M> carrying exactly that proof. Invoices live in the
        gateway’s memory unless <M>INVOICE_STORE_PATH</M> points at a JSON file, so without one a
        gateway restart forgets open invoices (<M>unknown_nonce</M>).
      </P>

      <H2 id="attestation">Attestation and trust score</H2>
      <P>
        After it has answered the buyer, the gateway — the service’s <em>attestor</em> — calls{' '}
        <M>record_attestation(service_id, nonce, payment_tx_hash, success)</M>. <M>success</M> is
        whether the upstream answered with a 2xx. It never blocks the buyer: a failed attempt is
        retried with exponential backoff (5 s, 10 s, 20 s — four attempts) and, with{' '}
        <M>ATTESTATION_QUEUE_PATH</M> set, an attestation that never confirmed is replayed when the
        gateway next boots.
      </P>
      <P>The gateway does not attest — the call is served but not scored — when:</P>
      <DocTable
        head={['Case', 'Why']}
        rows={[
          [
            'The upstream could not be reached, timed out or answered too large a body',
            'That is the seller’s backend being down, not a service outcome: it is scored neither way. The receipt says skipped_upstream_failed.',
          ],
          [
            'The payer is the service owner or the payment target',
            'A self-paid call can never raise a score. The registry itself rejects it (ERR_SELF_PAYMENT); the receipt says skipped_self_paid.',
          ],
        ]}
      />
      <P>
        The registry keeps <M>(total_calls, success_calls)</M> per service and the latest 100
        attestations, newest first. The trust tier is derived from the score, with exact integer
        arithmetic:
      </P>
      <DocTable
        head={['Tier', 'Rule']}
        rows={[
          [<M key="n">new</M>, 'fewer than 5 attested calls, or a success rate below 90%'],
          [<M key="r">reliable</M>, 'at least 5 calls and at least 90% successful'],
          [<M key="t">trusted</M>, 'at least 25 calls and at least 95% successful'],
        ]}
      />

      <H2 id="receipts">Receipts: GET /receipts/:nonce</H2>
      <P>
        A contract view cannot know the transaction that produced its own event, so the registry’s
        activity feed names a block, not a transaction. The only party that knows the transaction of
        an attestation is the gateway that sent it, so the gateway serves what it did about each paid
        call, keyed by the invoice nonce. This is where a buyer, a seed script or the{' '}
        <M>waitForReceipt</M> helper in <M>@agentgate/client</M> learns the attestation’s transaction.
      </P>
      <CodeBlock label="curl <gateway>/receipts/3673826824572287" code={'(no payment, no header needed)'} />
      <CodeBlock
        label="200 response"
        code={JSON.stringify(
          {
            nonce: '3673826824572287',
            serviceId: 1,
            paymentTxHash: '<the pay transaction the buyer presented>',
            attestation: { status: 'recorded', txHash: '<the record_attestation transaction>' },
          },
          null,
          2,
        )}
      />
      <DocTable
        head={['attestation.status', 'Meaning']}
        rows={[
          [<M key="1">pending</M>, 'The call was served; the attestation is still being sent or retried. Poll again.'],
          [<M key="2">recorded</M>, 'The registry holds the attestation. txHash names the gateway’s transaction; it is absent when the registry already had it from another party (ERR_ALREADY_ATTESTED).'],
          [<M key="3">skipped_self_paid</M>, 'The payer is the service owner or payment target: served, never attested.'],
          [<M key="4">skipped_upstream_failed</M>, 'The gateway could not reach the upstream: not scored either way.'],
          [<M key="5">failed</M>, 'Every attempt failed. A gateway with a persistent attestation queue retries on its next boot.'],
        ]}
      />
      <Callout tone="info" title="WHAT TO RELY ON">
        An unknown nonce answers <M>404 receipt_not_found</M>. Receipts live in the memory of one
        gateway process, bounded to its last 1000 paid calls (the oldest goes first), and are gone
        after a restart; a buyer needing a durable record should read the chain
        (<M>get_payment</M>, <M>get_attestations</M>). The route is public, answers{' '}
        a receipt with <M>Cache-Control: no-store</M> and allows 60 requests per minute; everything
        in a receipt is already public on-chain.
      </Callout>

      <H2 id="routes">Gateway routes</H2>
      <DocTable
        head={['Route', 'Purpose']}
        rows={[
          [
            <M key="1">ALL /svc/:id</M>,
            <span key="1d">
              The paywall: 402 challenge, then the proxied upstream response.
              <Sub>Auth: the x402 proof</Sub>
            </span>,
          ],
          [
            <M key="2">GET /svc/:id/meta</M>,
            <span key="2d">
              The service record, its score and trust tier as JSON, unpaid.
              <Sub>Auth: none</Sub>
            </span>,
          ],
          [
            <M key="3">GET /receipts/:nonce</M>,
            <span key="3d">
              The attestation receipt <DocLink href="#receipts">above</DocLink>.
              <Sub>Auth: none</Sub>
            </span>,
          ],
          [
            <M key="4">GET /healthz</M>,
            <span key="4d">
              Liveness: <M>{'{ ok, network }'}</M>.<Sub>Auth: none</Sub>
            </span>,
          ],
          [
            <M key="5">GET /readyz</M>,
            <span key="5d">
              Readiness: the chain is reachable; <M>503 {'{ ready: false }'}</M> when it is not.
              <Sub>Auth: none</Sub>
            </span>,
          ],
          [
            <M key="6">POST /services/:id/map</M>,
            <span key="6d">
              The service owner maps the private upstream with a signed request — see{' '}
              <DocLink href="/docs/security#self-map">the self-map signature</DocLink>.
              <Sub>Auth: the owner’s signature</Sub>
            </span>,
          ],
          [
            <M key="7">POST, GET /admin/services</M>,
            <span key="7d">
              Operator mapping of upstreams by token: how mock mode maps, and a self-hosted
              fallback. Rate limited to 20 per minute.
              <Sub>Auth: the admin bearer token</Sub>
            </span>,
          ],
          [
            <M key="8">DELETE /admin/services/:id</M>,
            <span key="8d">
              Removes a mapping.<Sub>Auth: the admin bearer token</Sub>
            </span>,
          ],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/security', label: 'Security model' },
          { href: '/docs/contract', label: 'Registry contract' },
        ]}
      />
    </>
  );
}
