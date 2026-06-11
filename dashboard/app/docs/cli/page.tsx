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
  title: 'Docs — CLI',
  description:
    'agentgate CLI reference: wrap, list, status and demo-accounts — every flag, the env each command reads, example output and exit codes.',
};

export default function CliPage() {
  return (
    <>
      <DocHeader
        kicker="docs / cli"
        title="CLI reference"
        lede="The agentgate CLI ships four commands: wrap (publish a service), list (the on-chain catalog), status (one service in depth) and demo-accounts (faucet-funded mock accounts). Run it from the repo root via npm run agentgate."
      />
      <CommandBlock text="npm run agentgate -- <command> [args]" />
      <P>
        Every command exits 0 on success and 1 on error; errors print as{' '}
        <M>error: &lt;CODE&gt;: &lt;message&gt;</M> (the full code table is at the{' '}
        <a href="#error-codes" className="text-accent underline underline-offset-4 hover:text-white">
          bottom of this page
        </a>
        ).
      </P>

      {/* ───────────────────────────── wrap ───────────────────────────── */}
      <H2 id="wrap">agentgate wrap</H2>
      <P>Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain.</P>
      <CommandBlock wrap text="agentgate wrap <upstreamUrl> --price <cspr> --name <name> [OPTIONS]" />
      <DocTable
        head={['Flag', 'Required', 'Default', 'Meaning']}
        rows={[
          [
            <M key="f">{'<upstreamUrl>'}</M>,
            'yes',
            '—',
            'Upstream API URL (kept private, only sent to the gateway). Must be valid http/https.',
          ],
          [
            <M key="f">--price {'<cspr>'}</M>,
            'yes',
            '—',
            'Price per call in CSPR. Must be > 0, max 9 decimal places. Stored as motes on-chain.',
          ],
          [<M key="f">--name {'<name>'}</M>, 'yes', '—', 'Service name (non-empty).'],
          [<M key="f">--description {'<d>'}</M>, 'no', <M key="d">&apos;&apos;</M>, 'Service description.'],
          [
            <M key="f">--gateway {'<url>'}</M>,
            'no',
            <M key="d">http://localhost:&lt;MIDDLEWARE_PORT|4021&gt;</M>,
            'Gateway base URL (what gets stored on-chain).',
          ],
          [
            <M key="f">--payment-target {'<accountHash>'}</M>,
            'no',
            'derived from seller signer',
            <span key="d">
              Must match <M>account-hash-&lt;64hex&gt;</M>.
            </span>,
          ],
          [
            <M key="f">--attestor {'<publicKeyHex>'}</M>,
            'no',
            'seller signer public key',
            <span key="d">
              Valid public key hex (<M>01…</M> or <M>02…</M> + 64 hex chars).
            </span>,
          ],
        ]}
      />
      <H3 id="wrap-example">Example</H3>
      <CommandBlock
        wrap
        text='npm run agentgate -- wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"'
      />
      <CodeBlock
        label="output"
        code={`service id:      1
public endpoint: http://localhost:4021/svc/1
dashboard:       http://localhost:3000/services/1
register tx:     <txHash>`}
      />
      <P>
        If the gateway admin mapping fails, the on-chain registration is{' '}
        <strong className="text-white">not rolled back</strong>: a warning with the exact retry curl
        (using <M>$AGENTGATE_ADMIN_TOKEN</M>) goes to stderr, and the output gains{' '}
        <M>[note: gateway upstream mapping FAILED — see the warning above for the retry curl.]</M>
      </P>
      <H3 id="wrap-env">Environment it reads</H3>
      <DocTable
        head={['Variable', 'When', 'Purpose']}
        rows={[
          [
            <M key="v">MOCK_SELLER_ACCOUNT</M>,
            'mock mode',
            'Seller signer public key. Missing → SIGNER_MISSING.',
          ],
          [
            <M key="v">SELLER_SIGNER_PEM_PATH</M>,
            'live mode',
            'Seller PEM key path. Missing → SIGNER_MISSING.',
          ],
          [
            <M key="v">AGENTGATE_ADMIN_TOKEN</M>,
            'both',
            'Bearer token for the gateway admin mapping call.',
          ],
          [
            <M key="v">MIDDLEWARE_PORT</M>,
            'both',
            <span key="d">
              Feeds the default <M>--gateway</M> (<M>http://localhost:&lt;port|4021&gt;</M>).
            </span>,
          ],
        ]}
      />

      {/* ───────────────────────────── list ───────────────────────────── */}
      <H2 id="list">agentgate list</H2>
      <P>
        List the on-chain service catalog with scores and trust tiers. No arguments, no
        options.
      </P>
      <CommandBlock text="npm run agentgate -- list" />
      <CodeBlock
        label="output"
        code={`ID  NAME                    PRICE         TIER      SCORE            ACTIVE  ENDPOINT
1   RWA FX & Gold Oracle    0.5 CSPR      reliable  9/10             yes     http://localhost:4021/svc/1`}
      />
      <CodeBlock
        label="empty state"
        code={'no services registered yet — wrap one with `agentgate wrap <upstreamUrl> --price 0.5 --name "My API"`'}
      />
      <P>
        Trust tiers derive from <M>successCalls/totalCalls</M>: <M>new</M> (fewer than 5
        calls), <M>reliable</M> (5+ calls, ≥ 90% success), <M>trusted</M> (25+ calls, ≥ 95%
        success).
      </P>

      {/* ───────────────────────────── status ───────────────────────────── */}
      <H2 id="status">agentgate status</H2>
      <P>Show one service: record, score, trust tier and recent attestations.</P>
      <CommandBlock text="npm run agentgate -- status <id>" />
      <DocTable
        head={['Argument', 'Rule']}
        rows={[
          [
            <M key="a">{'<id>'}</M>,
            'Non-negative integer. Invalid → INVALID_SERVICE_ID; not on-chain → SERVICE_NOT_FOUND.',
          ],
        ]}
      />
      <CodeBlock
        label="output"
        code={`service:        #1 RWA FX & Gold Oracle
description:    USD/IDR + gold spot with confidence
endpoint:       http://localhost:4021
price:          0.5 CSPR
payment target: account-hash-<64hex>
owner:          01<publicKeyHex>
attestor:       01<publicKeyHex>
trust:          reliable (9/10 calls ok)
attestations:
  [ok  ] 2026-06-12T10:30:05.123Z  payment a1b2c3d4e5f6…  tx b2c3d4e5f6a1…
  [FAIL] 2026-06-12T09:14:44.001Z  payment 9f8e7d6c5b4a…  tx 8e7d6c5b4a39…`}
      />
      <P>
        Shows the latest 10 attestations, newest first. With zero attestations it prints{' '}
        <M>attestations:   none yet</M> and stops. An inactive service gets an{' '}
        <M>[INACTIVE]</M> marker after its name; the description line is omitted when empty.
      </P>

      {/* ───────────────────────────── demo-accounts ───────────────────────────── */}
      <H2 id="demo-accounts">agentgate demo-accounts</H2>
      <P>
        Create faucet-funded buyer/seller demo accounts on the mock devnet —{' '}
        <strong className="text-white">mock mode only</strong> (live mode throws <M>MOCK_ONLY</M>). Each
        account is funded with 1000 CSPR. Requires the devnet to be running, otherwise{' '}
        <M>FAUCET_UNREACHABLE</M>.
      </P>
      <CommandBlock text="npm run agentgate -- demo-accounts" />
      <CodeBlock
        label="output"
        code={`buyer:  <publicKeyHex>  (1000 CSPR)
seller: <publicKeyHex>  (1000 CSPR)

# paste into your shell (used by the buyer agent and \`agentgate wrap\`):
export MOCK_BUYER_ACCOUNT=<publicKeyHex>
export MOCK_SELLER_ACCOUNT=<publicKeyHex>`}
      />
      <P>
        Mock public keys are <M>01</M> + 64 random hex chars (32 CSPRNG bytes).
      </P>

      {/* ───────────────────────────── errors ───────────────────────────── */}
      <H2 id="error-codes">Error codes</H2>
      <DocTable
        head={['Code', 'Status', 'Context', 'Example']}
        rows={[
          [<M key="c">INVALID_PRICE</M>, '400', 'wrap', 'price must be > 0 CSPR'],
          [
            <M key="c">INVALID_SERVICE_ID</M>,
            '400',
            'status',
            'service id must be a non-negative integer',
          ],
          [<M key="c">SERVICE_NOT_FOUND</M>, '404', 'status', 'service <id> not found on-chain'],
          [
            <M key="c">SIGNER_MISSING</M>,
            '400',
            'wrap (any mode)',
            'mock mode needs MOCK_SELLER_ACCOUNT / live mode needs SELLER_SIGNER_PEM_PATH',
          ],
          [<M key="c">MOCK_ONLY</M>, '400', 'demo-accounts', 'demo-accounts only works in mock mode'],
          [
            <M key="c">FAUCET_UNREACHABLE</M>,
            '502',
            'demo-accounts',
            'cannot reach devnet faucet (is the devnet running?)',
          ],
          [
            <M key="c">FAUCET_FAILED</M>,
            '502',
            'demo-accounts',
            'faucet returned non-200, non-JSON, or malformed balanceMotes',
          ],
          [
            <M key="c">INVALID_AMOUNT</M>,
            '400',
            'money conversions',
            'invalid amount (motes format, CSPR decimals, etc.)',
          ],
        ]}
      />
      <Callout tone="info" title="related npm scripts">
        <M>npm run demo</M> (one-shot scripted loop), <M>npm run dev</M> /{' '}
        <M>npm run dev:seed</M> (persistent stack) and <M>npm run agent</M> (buyer agent) are
        covered in <DocLink href="/docs/quickstart">Quickstart</DocLink> and{' '}
        <DocLink href="/docs/buyers#buyer-agent">Buyers</DocLink>.
      </Callout>

      <NextLinks
        links={[
          { href: '/docs/sellers', label: 'Seller guide' },
          { href: '/docs/configuration', label: 'Configuration' },
          { href: '/catalog', label: 'Browse the catalog' },
        ]}
      />
    </>
  );
}
