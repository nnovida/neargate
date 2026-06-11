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
  title: 'Docs — Protocol',
  description:
    'AgentGate-402 protocol reference: Invoice402 fields, proof headers, the four verification checks, single-use nonce burning, the full 402 error-code table and security properties.',
};

export default function ProtocolPage() {
  return (
    <>
      <DocHeader
        kicker="docs / protocol"
        title="AgentGate-402 protocol"
        lede="The wire protocol between a paywalled service and a paying agent: a machine-readable 402 invoice, a native CSPR transfer carrying the invoice nonce as transfer_id, and a retried request with proof headers. Version string: agentgate-402/1."
      />

      <H2 id="invoice">The Invoice402 object</H2>
      <P>
        Every <M>402</M> response body is an <M>Invoice402</M>. The agent must treat it as the
        single source of truth for how to pay.
      </P>
      <DocTable
        head={['Field', 'Type', 'Meaning']}
        rows={[
          [
            <M key="f">version</M>,
            <M key="t">&apos;agentgate-402/1&apos;</M>,
            'Fixed protocol version string — exact match required.',
          ],
          [
            <M key="f">network</M>,
            <M key="t">string</M>,
            <span key="d">
              Chain name: <M>&apos;mock&apos;</M> or <M>&apos;casper-test&apos;</M>.
            </span>,
          ],
          [<M key="f">serviceId</M>, <M key="t">number</M>, '1-based on-chain service id.'],
          [<M key="f">serviceName</M>, <M key="t">string</M>, 'Name from service registration.'],
          [
            <M key="f">priceMotes</M>,
            <M key="t">Motes (string)</M>,
            'Price as a motes decimal string. 1 CSPR = 1,000,000,000 motes. U512-safe via bigint — never parse as a JS number.',
          ],
          [
            <M key="f">paymentTarget</M>,
            <M key="t">string</M>,
            <span key="d">
              Recipient in <M>account-hash-&lt;64hex&gt;</M> format.
            </span>,
          ],
          [
            <M key="f">nonce</M>,
            <M key="t">string</M>,
            'u64 decimal string (max 18,446,744,073,709,551,615). Use it verbatim as the Casper transfer_id.',
          ],
          [
            <M key="f">expiresAt</M>,
            <M key="t">number</M>,
            'Unix-ms deadline. Strictly greater than now when issued.',
          ],
          [
            <M key="f">instructions</M>,
            <M key="t">string</M>,
            'Human-readable how-to-pay: service name, formatted CSPR price, deadline ISO string and the exact retry headers.',
          ],
        ]}
      />
      <H3 id="invoice-body">HTTP extension: Invoice402Body</H3>
      <P>
        Over HTTP the body may carry two extra optional fields when a payment proof was
        rejected:
      </P>
      <DocTable
        head={['Field', 'Type', 'Meaning']}
        rows={[
          [
            <M key="f">error</M>,
            <M key="t">PaywallErrorCode</M>,
            'Why the proof was rejected — present only on rejection (see the table below).',
          ],
          [
            <M key="f">retry_after_ms</M>,
            <M key="t">number</M>,
            <span key="d">
              Present only when <M>error === &apos;pending&apos;</M>; value is <M>2000</M>.
              Tells the buyer when to retry after the transfer settles.
            </span>,
          ],
        ]}
      />

      <H2 id="headers">Proof headers</H2>
      <DocTable
        head={['Header', 'Direction', 'Meaning']}
        rows={[
          [
            <M key="h">X-Payment-Deploy-Hash</M>,
            'request',
            'Deploy hash of the buyer’s CSPR payment transfer.',
          ],
          [
            <M key="h">X-Payment-Nonce</M>,
            'request',
            'The invoice nonce (u64 decimal string, 1–20 digits).',
          ],
          [
            <M key="h">X-AgentGate-Price</M>,
            'response (402)',
            'Service price in motes — mirrors priceMotes.',
          ],
          [
            <M key="h">X-AgentGate-Nonce</M>,
            'response (402)',
            'The issued nonce for this invoice — mirrors nonce.',
          ],
        ]}
      />
      <P>
        Header names are case-insensitive. The payment headers are consumed by the gateway and
        never forwarded to the upstream API.
      </P>

      <H2 id="verification">Verification rules</H2>
      <P>When a request arrives with proof headers, the gateway first validates the invoice:</P>
      <DocTable
        head={['Invoice check', 'On failure']}
        rows={[
          ['Invoice exists for the nonce and matches the requested serviceId', <M key="e">unknown_nonce</M>],
          ['Invoice not yet marked used', <M key="e">invoice_used</M>],
          [
            <span key="c">
              Invoice not expired (<M>now ≤ expiresAt</M>)
            </span>,
            <M key="e">invoice_expired</M>,
          ],
        ]}
      />
      <P>
        Then it verifies the transfer on-chain via{' '}
        <M>
          chain.verifyTransfer({'{'} deployHash, expectedTarget, minAmountMotes,
          expectedTransferId, maxAgeMs {'}'})
        </M>{' '}
        — four checks, all of which must pass:
      </P>
      <DocTable
        head={['#', 'Check', 'Rule', 'On failure']}
        rows={[
          [
            '1',
            'Target',
            <span key="r">
              <M>transfer.to</M> exactly equals the service&apos;s <M>paymentTarget</M>.
            </span>,
            <M key="e">wrong_target</M>,
          ],
          [
            '2',
            'Amount',
            <span key="r">
              <M>transfer.amount ≥ priceMotes</M> (bigint comparison).
            </span>,
            <M key="e">amount_too_low</M>,
          ],
          [
            '3',
            'Transfer id',
            <span key="r">
              <M>transfer.transfer_id</M> equals the invoice nonce (u64 decimal string match).
            </span>,
            <M key="e">wrong_transfer_id</M>,
          ],
          [
            '4',
            'Age',
            <span key="r">
              Deploy timestamp within <M>maxAgeMs</M> (<M>INVOICE_TTL_MS</M>, default 300,000 ms
              = 5 min).
            </span>,
            <M key="e">expired</M>,
          ],
        ]}
      />
      <H3 id="burn">Single-use burn</H3>
      <P>
        Once all checks pass, the nonce is marked used <strong className="text-white">atomically, before
        proxying</strong> to the upstream. The store&apos;s <M>markUsed()</M> is a compare-and-set:
        exactly one concurrent request wins; every other request holding the same proof gets a
        fresh 402 with <M>invoice_used</M>. A used nonce stays used even if the upstream call
        then fails.
      </P>

      <H2 id="error-codes">402 error codes — the full set</H2>
      <DocTable
        head={['Code', 'Source', 'Meaning', 'Invoice afterwards']}
        rows={[
          [
            <M key="c">unknown_nonce</M>,
            'invoice store',
            'Nonce regex fails, invoice not found, or serviceId mismatch.',
            '— (no matching invoice)',
          ],
          [
            <M key="c">invoice_used</M>,
            'invoice store',
            'Nonce already burned (single-use enforced).',
            'dead',
          ],
          [
            <M key="c">invoice_expired</M>,
            'invoice store',
            'Now > expiresAt.',
            'dead',
          ],
          [
            <M key="c">pending</M>,
            'chain verification',
            'Transfer found but still settling — comes with retry_after_ms: 2000.',
            'stays alive — retry same proof',
          ],
          [
            <M key="c">not_found</M>,
            'chain verification',
            'Deploy hash not found on-chain.',
            'stays alive',
          ],
          [
            <M key="c">wrong_target</M>,
            'chain verification',
            'Transfer recipient ≠ expected paymentTarget.',
            'stays alive',
          ],
          [
            <M key="c">amount_too_low</M>,
            'chain verification',
            'Transfer amount below priceMotes.',
            'stays alive',
          ],
          [
            <M key="c">wrong_transfer_id</M>,
            'chain verification',
            'transfer_id on chain ≠ invoice nonce.',
            'stays alive',
          ],
          [
            <M key="c">expired</M>,
            'chain verification',
            'Transfer exists but is older than maxAgeMs.',
            'stays alive',
          ],
        ]}
      />
      <P>
        Every rejection re-sends the full invoice body, so a well-behaved client can always
        recover: re-read the price, the target, the deadline, and either retry or re-pay
        against a fresh nonce.
      </P>

      <H2 id="replay">Replay and expiry semantics</H2>
      <DocTable
        head={['Property', 'Mechanism']}
        rows={[
          [
            'Fresh nonces',
            'Cryptographically random, 63-bit, via crypto.getRandomValues. One nonce per issued invoice.',
          ],
          [
            'No proof replay',
            'The nonce burns atomically before the upstream call; replaying the same proof yields invoice_used.',
          ],
          [
            'No transfer reuse',
            'The on-chain transfer is unique per deploy hash and bound to the nonce via transfer_id — the Casper protocol settles it exactly once.',
          ],
          [
            'Expiry window',
            <span key="d">
              <M>INVOICE_TTL_MS</M> (default 300,000 ms) bounds both the invoice lifetime and
              the accepted transfer age.
            </span>,
          ],
          [
            'Precise late errors',
            'Expired invoices survive one TTL sweep grace period so a late retry gets invoice_expired rather than the ambiguous unknown_nonce.',
          ],
        ]}
      />

      <H2 id="money">Money units</H2>
      <P>
        All amounts are <strong className="text-white">motes of native CSPR as decimal strings</strong> —{' '}
        <M>type Motes = string</M>. 1 CSPR = 1,000,000,000 motes. All arithmetic is bigint;
        floats are never used for money. CSPR inputs allow at most 9 decimal places (1-mote
        precision).
      </P>
      <CodeBlock
        label="conversion helpers (@agentgate/shared)"
        code={`csprToMotes("0.5")        → "500000000"
motesToCspr("500000000")  → "0.5"
formatCspr("500000000")   → "0.5 CSPR"
parseMotes("500000000")   → 500000000n`}
      />
      <DocTable
        head={['Value', 'Pattern', 'Range']}
        rows={[
          [
            'Service id',
            <M key="p">{'^\\d{1,15}$'}</M>,
            '1 to 999,999,999,999,999 (1-based; 0 = absent)',
          ],
          [
            'Nonce (u64)',
            <M key="p">{'^\\d{1,20}$'}</M>,
            '0 to 18,446,744,073,709,551,615',
          ],
          [
            'Motes (U512)',
            <M key="p">{'^(0|[1-9]\\d*)$'}</M>,
            '0 to 2^512 − 1, bigint decimal string',
          ],
        ]}
      />

      <H2 id="security">Security properties</H2>
      <DocTable
        head={['Property', 'Why it holds']}
        rows={[
          [
            'No forgery',
            'Proof is a real on-chain transfer verified against four independent facts (target, amount, transfer_id, age) — a buyer cannot fabricate a deploy hash that passes.',
          ],
          [
            'No replay',
            'Single-use nonce burned atomically before serving, plus the on-chain transfer being unique and TTL-bounded.',
          ],
          [
            'No key leakage',
            'There are no API keys at all, and the gateway forwards only a strict header whitelist upstream — payment headers, authorization and cookies are stripped.',
          ],
          [
            'Bounded spend',
            <span key="d">
              Client-side <M>maxPriceMotes</M> and the buyer agent&apos;s budget cap refuse
              over-priced invoices before any transfer is made.
            </span>,
          ],
        ]}
      />
      <Callout tone="info" title="see it on the wire">
        The <DocLink href="/docs/buyers#curl">buyer guide</DocLink> walks the full 402 → pay →
        retry exchange with curl and realistic JSON.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/api', label: 'HTTP API reference' },
          { href: '/docs/buyers', label: 'Buyer guide' },
          { href: '/docs/contract', label: 'Smart contract' },
        ]}
      />
    </>
  );
}
