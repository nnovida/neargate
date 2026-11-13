import type { Metadata } from 'next';
import {
  DEFAULT_GATEWAY_ACCOUNT_ID,
  DEFAULT_GATEWAY_URL,
  DEFAULT_REGISTRY_CONTRACT_ID,
} from '@agentgate/shared';
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

// The 402 example below is the hosted gateway's answer for service #1; placeholders stand in for a
// build without the hosted defaults.
const HOSTED_REGISTRY = DEFAULT_REGISTRY_CONTRACT_ID || '<registry account id>';
const HOSTED_GATEWAY = DEFAULT_GATEWAY_URL || '<gateway>';
const HOSTED_RELAYER = DEFAULT_GATEWAY_ACCOUNT_ID || '<gateway account id>';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/protocol' },
  title: 'How it works',
  description:
    'The x402 payment flow on NEAR end to end: the 402 invoice, the registry pay call, the X-PAYMENT proof, verification, the gasless relay of a signed pay_from_escrow, the single-use nonce, attestations and trust tiers, the gateway receipts endpoint and the gateway routes.',
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
        <M>yoctoNEAR</M> decimal strings (1 NEAR = 10<sup>24</sup> yocto). This is what the hosted
        gateway answers for service #1, a 0.01 NEAR service, with the relay on:
      </P>
      <CodeBlock
        label="402 response (GET /svc/1 on the hosted gateway)"
        code={JSON.stringify(
          {
            x402Version: 1,
            error: 'X-PAYMENT header is required',
            accepts: [
              {
                scheme: 'exact',
                network: 'near-testnet',
                maxAmountRequired: '12000000000000000000000',
                asset: 'NEAR',
                payTo: HOSTED_REGISTRY,
                resource: `${HOSTED_GATEWAY}/svc/1`,
                description: 'USD exchange rates',
                maxTimeoutSeconds: 300,
                extra: {
                  nonce: '1983699248480309',
                  serviceId: 1,
                  expiresAtMs: 1794520151523,
                  settlement: 'neargate-registry-pay',
                  contractId: HOSTED_REGISTRY,
                  method: 'pay',
                  priceYocto: '10000000000000000000000',
                  storageFeeYocto: '2000000000000000000000',
                  seller: 'neargate-app-seller.testnet',
                  caip2: 'near:testnet',
                  relayer: HOSTED_RELAYER,
                  relayMethod: 'pay_from_escrow',
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
            name: 'error',
            required: true,
            type: 'string',
            desc: (
              <>
                Why the gateway is challenging: <M>X-PAYMENT header is required</M> on a first call,
                else one of the <DocLink href="#invoice-rejection-fields">rejection reasons</DocLink>.
              </>
            ),
          },
          {
            name: 'transaction / code',
            required: false,
            type: 'string',
            desc: (
              <>
                Top-level, gasless rail only: <M>transaction</M> is the relay transaction on a{' '}
                <M>settlement_pending</M> whose relay timed out (it may still land), and{' '}
                <M>code</M> is the chain’s code after <M>relay_failed</M> (for example{' '}
                <M>ERR_ESCROW_INSUFFICIENT</M>).
              </>
            ),
          },
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
          {
            name: 'extra.relayer / relayMethod',
            required: false,
            type: 'NEAR account id / "pay_from_escrow"',
            desc: (
              <>
                Present only when the gateway runs with <M>RELAYER_ENABLED</M>: the gateway account
                that relays a signed <M>pay_from_escrow</M> and pays its gas, and the one method it
                relays. See <DocLink href="#gasless">the gasless rail</DocLink>.
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
          [<M key="3">relayer_disabled</M>, 'The proof is a delegate (gasless) payload and this gateway relays none (RELAYER_ENABLED is off); pay with a tx proof. The invoice stays open.'],
          [<M key="4">unknown_nonce</M>, 'The gateway issued no invoice with that nonce for this service, or no longer remembers it: an invoice is dropped about a minute after it expires (so a used or expired nonce presented later gets this reason), and a restart forgets every invoice unless INVOICE_STORE_PATH keeps them.'],
          [<M key="5">invoice_used</M>, 'That invoice was already redeemed. A nonce serves one call.'],
          [<M key="6">invoice_expired</M>, 'The invoice is older than its time to live.'],
          [<M key="7">not_found</M>, 'The registry holds no payment for the nonce.'],
          [<M key="8">wrong_service</M>, 'The payment under that nonce was made for another service.'],
          [<M key="9">amount_too_low</M>, 'The price the registry forwarded is below the service price.'],
          [<M key="10">expired</M>, 'The registry payment is older than the invoice time to live.'],
          [<M key="11">already_attested</M>, 'The payment was already attested, which only follows a served call.'],
          [<M key="12">tx_mismatch</M>, 'Live: the transaction is not a successful pay or pay_from_escrow of this nonce and service on this registry, signed by the named payer. The gasless rail answers it in either mode when its relayed payment does not match the invoice.'],
          [<M key="13">settlement_pending</M>, 'Live: the payment is not yet visible. On the gasless rail: the relay is in flight, timed out, or landed and its record is not read yet. The same invoice stays valid: retry the identical proof after the Retry-After seconds (2).'],
        ]}
      />
      <P>
        The gasless rail adds its own reasons (<M>delegate_*</M>, <M>bad_signature</M>,{' '}
        <M>unknown_key</M>, <M>key_not_allowed</M>, <M>stale_nonce</M>, <M>escrow_insufficient</M>,{' '}
        <M>relay_failed</M>); they are listed <DocLink href="#gasless-checks">with its checks</DocLink>.
      </P>

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
      <P>
        A buyer with a prepaid escrow can call <M>pay_from_escrow</M> with the same{' '}
        <M>serviceId</M> and <M>nonce</M> instead: it attaches nothing and the registry debits{' '}
        <M>price + 0.002 NEAR</M> from the buyer’s escrow, then writes the identical payment record
        and event. The invoice and the proof are the same for both rails (see{' '}
        <DocLink href="/docs/contract#escrow">escrow</DocLink>).
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
              transaction: '<base58 tx hash of the pay or pay_from_escrow call>',
              nonce: '3673826824572287',
              payer: '<buyer account id>',
            },
          },
          null,
          2,
        )}
      />
      <P>
        <M>transaction</M> is the base58 hash of the <M>pay</M> (or <M>pay_from_escrow</M>)
        transaction; <M>payer</M> is the account that signed it. A{' '}
        <M>kind: &quot;delegate&quot;</M> payload carries a NEP-366 signed delegate instead, for the
        gateway to relay: see <DocLink href="#gasless">the gasless rail</DocLink>. A gateway that
        relays none answers it <M>relayer_disabled</M>.
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
        failure. One exception in live mode: when the registry holds no payment for the nonce, the
        gateway looks at the transaction before answering, so a transaction that does not match
        gives <M>tx_mismatch</M>, one still executing (or executed but not yet readable) gives{' '}
        <M>settlement_pending</M>, and only an unknown or failed one gives <M>not_found</M>.
      </P>
      <DocTable
        head={['#', 'Check', 'Reason on failure']}
        rows={[
          ['1', 'The header decodes to a proof for this gateway’s network: a tx proof, or a delegate when the gateway relays (its own checks are below).', 'invalid_payment_header, relayer_disabled'],
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
              received by the registry, hold a <M>pay</M> or <M>pay_from_escrow</M> action with the same service id and nonce,
              and have succeeded. While it cannot yet be shown the answer is pending.
            </span>,
            'tx_mismatch, settlement_pending',
          ],
          ['5', 'The nonce is burned (below).', 'invoice_used'],
        ]}
      />
      <P>
        Other statuses the paywall route can answer before any invoice, so nothing is charged:{' '}
        <M>404 service_not_found</M>, <M>403 service_inactive</M> (the owner paused it),{' '}
        <M>503 service_unavailable</M> (no upstream is mapped on this gateway, or in live mode the
        upstream host is not public), <M>415 unsupported_media_type</M> (a request body that is not
        JSON), <M>400 invalid_json</M> (a JSON body that does not parse),{' '}
        <M>413 payload_too_large</M> (a body over 256 KB) and <M>429 rate_limited</M> (60 requests
        per minute per client on <M>/svc</M>). The gateway caches each service record for 60 s, so
        a pause or resume can take up to a minute to show here.
      </P>
      <P>
        After a verified payment the nonce is burned before the upstream is called, so these
        answers come <strong className="text-white">after the buyer paid</strong>, with{' '}
        <M>X-PAYMENT-RESPONSE</M> set: <M>502 upstream_unreachable</M>,{' '}
        <M>504 upstream_timeout</M>, <M>502 upstream_response_too_large</M> (over 1 MiB) and{' '}
        <M>502 upstream_request_too_large</M>. The receipt records it as{' '}
        <M>skipped_upstream_failed</M> and no attestation is sent. A failure inside the gateway
        answers <M>500 internal_error</M>, or the lower-cased code of a known error with its own
        status (an RPC failure while verifying, for example).
      </P>

      <H2 id="gasless">The gasless rail (a relayed pay_from_escrow)</H2>
      <P>
        With <M>RELAYER_ENABLED</M> the gateway also takes a buyer who has a prepaid escrow but
        pays no gas: the buyer signs its <M>pay_from_escrow</M> as a NEP-366 delegate and sends it
        in the proof, and the gateway account (<M>GATEWAY_ACCOUNT_ID</M>, named in{' '}
        <M>extra.relayer</M>) relays it in a transaction it signs and pays for. The escrow pays
        price + <M>0.002 NEAR</M>; the buyer’s account pays nothing. The invoice is the same, and
        the payment record and event are those of any <M>pay_from_escrow</M>.
      </P>
      <CodeBlock
        label="X-PAYMENT (decoded), gasless"
        code={JSON.stringify(
          {
            x402Version: 1,
            scheme: 'exact',
            network: 'near-testnet',
            payload: {
              kind: 'delegate',
              signedDelegate: '<base64 borsh SignedDelegate>',
              nonce: '3673826824572287',
              payer: '<buyer account id>',
            },
          },
          null,
          2,
        )}
      />
      <P>
        <M>signedDelegate</M> is the base64 of a borsh NEP-366 <M>SignedDelegate</M> of at most
        4096 bytes once decoded (a larger one is refused <M>invalid_payment_header</M>, like any
        malformed header), signed with an ed25519 key of the payer (its full-access key or an{' '}
        <DocLink href="/docs/cli#agent-key">agent key</DocLink> for <M>pay_from_escrow</M>). Its
        delegate action is exactly what the clients build: sender = <M>payer</M>, receiver = the
        registry, one FunctionCall <M>pay_from_escrow</M> whose arguments are the bytes{' '}
        <M>{'{"service_id":<id>,"nonce":"<nonce>"}'}</M> of this invoice, 30 TGas, no deposit; its
        nonce is the signing key’s nonce + 1, read at optimistic finality so that a nonce spent in a
        block not yet final is not signed again, and it expires 100 blocks past the height the buyer
        read. NEAR has a relayer pay the deposit a relayed call attaches, so the gateway relays
        nothing else.
      </P>
      <H3 id="gasless-checks">The gateway’s checks</H3>
      <P>
        A gateway without <M>RELAYER_ENABLED</M> answers a delegate proof <M>relayer_disabled</M>{' '}
        before it reads the invoice. With it, after the invoice checks (<M>unknown_nonce</M>,{' '}
        <M>invoice_used</M>, <M>invoice_expired</M>) the gateway runs these, in this order.
        Refusals 1–8 cost the relayer nothing: they come before the relay. <M>relay_failed</M>{' '}
        costs at most one relay’s gas. No refusal burns the nonce: the invoice stays open, and the
        402 also carries a fresh one.
      </P>
      <DocTable
        head={['#', 'Check', 'Reason on failure']}
        rows={[
          [
            '1',
            'The delegate decodes (canonical borsh, ed25519; base64 and size were already checked with the header), its sender is the payer, its receiver the registry, and it holds one FunctionCall pay_from_escrow with this invoice’s arguments, no deposit and 30 TGas.',
            'delegate_malformed, delegate_wrong_sender, delegate_wrong_receiver, delegate_wrong_action, delegate_wrong_args, delegate_deposit_not_zero, delegate_gas_too_high, delegate_gas_too_low',
          ],
          ['2', 'The signature verifies over NEAR’s delegate encoding.', 'bad_signature'],
          ['3', 'No relay of this invoice is in flight.', 'settlement_pending (the same invoice)'],
          [
            '4',
            'The registry holds no payment for the nonce yet. One it does hold is served only as the retry of a relay this gateway process sent (one that timed out, or whose record was not read yet), presented by that relay’s payer with its signing key, for this service and price; any other payment is never relayed again.',
            'invoice_used',
          ],
          [
            '5',
            'No relay of this invoice that this gateway sent can still land: there was none, or its delegate expired without NEAR running it (the key’s nonce, read at final, never reached the delegate’s).',
            'settlement_pending, with that relay tx in transaction',
          ],
          [
            '6',
            'The delegate stays valid 20 more blocks, and its nonce is below the height × 10^6 NEAR allows. This comes after the payment checks, so the retry of a relay that landed is served even once its delegate has expired.',
            'delegate_expired, delegate_nonce_too_large',
          ],
          [
            '7',
            'The signing key is an access key of the payer, read at final: full access, or a function-call key for the registry allowing pay_from_escrow. The delegate nonce is above the key’s nonce read at optimistic finality (a nonce spent in a block not yet final is spent), above every nonce this gateway relayed for that key whose delegate may still run, and not the nonce of a relay of that key in flight.',
            'unknown_key, key_not_allowed, stale_nonce',
          ],
          ['8', 'The escrow holds price + 0.002 NEAR.', 'escrow_insufficient'],
          [
            '9',
            'The relay: the registry’s own receipt must have succeeded — the transaction’s status is never trusted alone — and its payment record must name the payer, this service and the price. The gateway remembers the relay as soon as it is sent, before it reads anything else.',
            'relay_failed, with a code (below); settlement_pending with the relay tx, in transaction, when the outcome is unknown (a timeout) or the record is not read yet; a record of another payer, service or price: tx_mismatch or its reason',
          ],
        ]}
      />
      <P>
        The <M>code</M> of a <M>relay_failed</M> says whose failure it was: the registry’s{' '}
        <M>ERR_*</M> (e.g. <M>ERR_ESCROW_INSUFFICIENT</M>) or <M>CONTRACT_ERROR</M> when NEAR ran
        the delegate and its call failed; <M>DELEGATE_REJECTED</M> when NEAR refused the delegate
        itself (its key or nonce changed after the checks); <M>RELAYER_ERROR</M> when the relay
        failed on the gateway’s side (its key, account or balance, or the RPC), whose detail stays
        in the gateway’s log.
      </P>
      <P>
        A served call is burned, proxied and attested as on the tx rail; its{' '}
        <M>X-PAYMENT-RESPONSE</M> names the relay transaction. While the answer is{' '}
        <M>settlement_pending</M>, present the same delegate again: once the relay has landed the
        retry is served without a second relay. The clients do this on their own: a gasless buy
        presents the same delegate again after each <M>settlement_pending</M>, waiting the
        Retry-After clamped to 1–10 s, until the gateway answers definitively; it waits at most
        150 s in all (the client’s <M>gaslessWaitMs</M>), longer than the delegate’s 100 blocks.
        Never sign a new delegate for an invoice whose relay may still land. A relay whose delegate
        NEAR ran but whose call did not pay keeps the invoice pending until it expires. The relays a
        gateway sent stay in its memory until their invoice is served, so a gateway restart forgets
        them: the retry of a relay that landed before the restart is then <M>invoice_used</M>, and a
        delegate whose relay had not landed yet can be relayed a second time. NEAR runs a delegate
        nonce once, so that cannot pay twice, but the second relay costs gas and its answer (
        <M>relay_failed</M> or <M>stale_nonce</M>) does not say the first one paid: after either,
        read the escrow balance before buying again. What this means for the relayer and for
        front-running is on the{' '}
        <DocLink href="/docs/security#relayer">security page</DocLink>.
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
        was not served into <M>PAID_NOT_SERVED</M> carrying exactly that proof (on the gasless
        rail, <M>GASLESS_NOT_SERVED</M>, which says whether the escrow paid). Invoices live in the
        gateway’s memory unless <M>INVOICE_STORE_PATH</M> points at a JSON file, so without one a
        gateway restart forgets open invoices (<M>unknown_nonce</M>).
      </P>

      <H2 id="attestation">Attestation and trust score</H2>
      <P>
        After it has answered the buyer, the gateway calls{' '}
        <M>record_attestation(service_id, nonce, payment_tx_hash, success)</M> as its own account (
        <M>GATEWAY_ACCOUNT_ID</M>). The registry accepts it only from the service’s{' '}
        <em>attestor</em> or owner, so a service must name its gateway’s account as attestor when it
        registers (<DocLink href="/docs/cli#wrap">wrap --attestor</DocLink>); otherwise every
        attestation is rejected and paid calls are never scored. <M>success</M> is
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
        <M>waitForReceipt</M> helper in <M>@neargate/sdk</M> learns the attestation’s transaction.
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
