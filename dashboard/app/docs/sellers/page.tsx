import type { Metadata } from 'next';
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
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Docs — Sellers',
  description:
    'The seller workflow: wrap an upstream API in one command, understand what lands on-chain vs on the gateway, collect revenue, monitor, pause, and price your service.',
};

export default function SellersPage() {
  return (
    <>
      <DocHeader
        kicker="docs / sellers"
        title="Selling an API"
        lede="One command turns any HTTP API into a 402-paywalled, on-chain-registered, pay-per-call service. You keep your upstream URL private, payments land directly in your account, and every served call builds your public reputation score."
      />

      <H2 id="wrap-anatomy">Wrap: one command, fully annotated</H2>
      <CommandBlock
        wrap
        text='npm run agentgate -- wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" --description "Live gold spot price" --gateway http://localhost:4021 --payment-target account-hash-<64hex> --attestor <publicKeyHex>'
      />
      <DocTable
        head={['Argument / flag', 'Required', 'Default', 'Meaning']}
        rows={[
          [
            <M key="a">{'<upstreamUrl>'}</M>,
            'yes',
            '—',
            'Upstream API URL to wrap. Kept private — only sent to the gateway, never written on-chain. Must be a valid http/https URL.',
          ],
          [
            <M key="a">--price {'<cspr>'}</M>,
            'yes',
            '—',
            'Price per call in CSPR (decimal string, e.g. 0.5). Must be > 0, max 9 decimal places. Stored as motes on-chain.',
          ],
          [
            <M key="a">--name {'<name>'}</M>,
            'yes',
            '—',
            'Service name. Must be non-empty.',
          ],
          [
            <M key="a">--description {'<d>'}</M>,
            'no',
            <M key="d">&apos;&apos;</M>,
            'Service description for catalog listings.',
          ],
          [
            <M key="a">--gateway {'<url>'}</M>,
            'no',
            <M key="d">http://localhost:&lt;MIDDLEWARE_PORT|4021&gt;</M>,
            'Gateway base URL. This — not the upstream — is what gets stored on-chain.',
          ],
          [
            <M key="a">--payment-target {'<accountHash>'}</M>,
            'no',
            'derived from seller signer',
            <span key="d">
              Account that receives payments, in <M>account-hash-&lt;64hex&gt;</M> format.
            </span>,
          ],
          [
            <M key="a">--attestor {'<publicKeyHex>'}</M>,
            'no',
            'seller signer public key',
            'Public key allowed to record attestations for this service (normally the gateway signer).',
          ],
        ]}
      />
      <P>On success the CLI prints:</P>
      <CodeBlock
        code={`service id:      <number>
public endpoint: <gateway>/svc/<serviceId>
dashboard:       http://localhost:<DASHBOARD_PORT>/services/<serviceId>
register tx:     <txHash>`}
      />
      <P>
        Signer requirements: mock mode needs <M>MOCK_SELLER_ACCOUNT</M> exported (create one
        with <DocLink href="/docs/cli#demo-accounts">demo-accounts</DocLink>); live mode needs{' '}
        <M>SELLER_SIGNER_PEM_PATH</M>. Missing either fails with{' '}
        <M>error: SIGNER_MISSING</M>. Exit code is 0 on success, 1 on any error.
      </P>

      <H2 id="on-chain-vs-gateway">What happens on-chain vs on the gateway</H2>
      <P>Wrap performs two distinct side effects, in this order:</P>
      <DocTable
        head={['Step', 'Where', 'What is stored']}
        rows={[
          [
            <M key="s">1 · register_service</M>,
            'on-chain registry',
            'name, description, gateway base URL, price in motes, paymentTarget, owner (you), attestor, active=true. Note: the registry stores endpointUrl = the gateway base URL, not the full /svc/<id> path — readers compute the public endpoint as <endpointUrl>/svc/<id>.',
          ],
          [
            <M key="s">2 · POST /admin/services</M>,
            'gateway (private)',
            'The serviceId → upstreamUrl mapping, sent with the Bearer admin token. This is the only place your upstream URL exists.',
          ],
        ]}
      />
      <Callout tone="warn" title="if the gateway mapping fails">
        On-chain registration is <strong>not rolled back</strong>. The CLI prints a detailed
        warning to stderr with the exact retry curl (referencing{' '}
        <M>$AGENTGATE_ADMIN_TOKEN</M>) and appends{' '}
        <M>[note: gateway upstream mapping FAILED — see the warning above for the retry curl.]</M>{' '}
        to its output. Until you retry the mapping, callers of <M>/svc/&lt;id&gt;</M> get{' '}
        <M>503 service_unavailable</M>.
      </Callout>

      <H2 id="revenue">Where revenue lands</H2>
      <P>
        Buyers pay with native CSPR transfers sent <strong className="text-white">directly to your{' '}
        <M>paymentTarget</M> account</strong>. The gateway never holds or forwards funds — it only
        verifies that the transfer happened on-chain before serving the call. Revenue shown on
        your dashboard service page is computed as <M>price × successCalls</M> (bigint math);
        in mock mode the page also shows the live balance of the payment target account.
      </P>

      <H2 id="monitoring">Monitoring your service</H2>
      <H3 id="monitoring-cli">From the CLI</H3>
      <CommandBlock text="npm run agentgate -- list" />
      <P>
        Prints the full on-chain catalog: ID, name, price, trust tier, score, active flag and
        public endpoint. For one service:
      </P>
      <CommandBlock text="npm run agentgate -- status 1" />
      <P>
        Shows the record, score, trust tier and the latest 10 attestations (newest first) —
        full output samples in <DocLink href="/docs/cli#status">CLI → status</DocLink>.
      </P>
      <H3 id="monitoring-dashboard">From the dashboard</H3>
      <P>
        The <DocLink href="/catalog">catalog</DocLink> lists every service with its tier and
        score; <DocLink href="/services/1">/services/&lt;id&gt;</DocLink> shows the record, the
        attestation history, revenue and (mock mode) balance; the{' '}
        <DocLink href="/activity">activity feed</DocLink> streams registrations, payments and
        attestations. All three poll the chain every 5 seconds.
      </P>

      <H2 id="pausing">Pausing a service</H2>
      <P>
        The registry contract exposes <M>set_active(service_id, active)</M> — owner only (the
        attestor explicitly cannot toggle it). While inactive: the paywall answers{' '}
        <M>403 service_inactive</M>, attestations revert with <M>ServiceInactive</M> (error
        code 3), and buying agents filter the service out of discovery. Reactivating restores
        everything; the score is untouched.
      </P>
      <Callout tone="info" title="current CLI surface — honest note">
        <M>agentgate</M> currently ships <M>wrap</M>, <M>list</M>, <M>status</M> and{' '}
        <M>demo-accounts</M> — there is no pause command yet. To toggle today: in mock mode call
        the devnet route <M>POST /chain/services/:id/active</M> (see{' '}
        <DocLink href="/docs/api#devnet">HTTP API → Devnet</DocLink>); in live mode call the{' '}
        <M>set_active</M> entrypoint directly (the chain layer&apos;s <M>setActive</M> supports
        it).
      </Callout>

      <H2 id="privacy">Upstream privacy guarantee</H2>
      <P>
        Your upstream URL never touches the chain — it lives only in the gateway&apos;s private
        upstream map, written via the authenticated admin API. On every proxied call the
        gateway forwards a strict header whitelist (<M>accept</M>, <M>accept-language</M>,{' '}
        <M>user-agent</M>) and nothing else: payment proof headers, authorization, cookies,
        host and <M>x-forwarded-*</M> are all stripped. In live mode an SSRF guard additionally
        rejects private and loopback upstream hosts.
      </P>

      <H2 id="pricing">Pricing rules</H2>
      <DocTable
        head={['Rule', 'Enforced by', 'Detail']}
        rows={[
          [
            'Price > 0 CSPR',
            <M key="e">agentgate wrap</M>,
            'Zero or negative prices are rejected with INVALID_PRICE.',
          ],
          [
            'Max 9 decimal places',
            'money validation',
            '1 mote = 1e-9 CSPR is the smallest unit; finer precision is rejected.',
          ],
          [
            'Minimum 1000 motes',
            'registry contract',
            <span key="d">
              <M>MIN_PRICE_MOTES = 1000</M> (0.000001 CSPR) keeps dust prices out — below it,
              registration reverts with <M>InvalidPrice</M> (error code 5).
            </span>,
          ],
        ]}
      />
      <P>
        All amounts are stored and compared as motes — decimal strings handled with bigint
        arithmetic, never floats. See{' '}
        <DocLink href="/docs/protocol#money">Protocol → Money units</DocLink>.
      </P>

      <NextLinks
        links={[
          { href: '/docs/cli', label: 'CLI reference' },
          { href: '/docs/api', label: 'HTTP API' },
          { href: '/docs/buyers', label: 'Buyer guide' },
        ]}
      />
    </>
  );
}
