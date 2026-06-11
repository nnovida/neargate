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
  StepFlow,
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Docs — Buyers',
  description:
    'The buyer workflow: pay-per-call with no API keys. Three ways to buy — the autonomous buyer agent, the fetchPaid client SDK, or a manual curl walkthrough of 402 → pay → retry.',
};

const SDK_EXAMPLE = `import { createAgentGateClient } from '@agentgate/client';
import { createChainClient } from '@agentgate/chain';
import { loadConfig } from '@agentgate/shared';

// Load config and create dependencies
const config = loadConfig();
const chain = createChainClient(config);

// Create buyer agent signer
const signer = {
  kind: 'mock' as const,
  publicKey: '01abc123...def456' // From MOCK_BUYER_ACCOUNT
};

// Create the client
const client = createAgentGateClient({
  chain,
  signer,
  maxPriceMotes: '5000000000', // 5 CSPR cap
  settleDelayMs: config.mode === 'mock' ? 0 : 3000,
});

// Use it
try {
  const result = await client.fetchPaid('http://localhost:4021/svc/1');

  if (result.paid) {
    console.log(\`Paid \${result.priceMotes} motes\`);
    console.log(\`Deploy hash: \${result.deployHash}\`);
  }

  console.log(\`Status: \${result.status}\`);
  console.log(\`Data:\`, result.body);
} catch (err) {
  if (err.code === 'PRICE_EXCEEDED') {
    console.error('Invoice too expensive:', err.message);
  } else if (err.code === 'BAD_INVOICE') {
    console.error('Invalid invoice:', err.message);
  } else {
    throw err;
  }
}`;

export default function BuyersPage() {
  return (
    <>
      <DocHeader
        kicker="docs / buyers"
        title="Buying API calls"
        lede="AgentGate services work like vending machines: the endpoint is public, but every single call needs a fresh payment. No accounts, no API keys, no subscriptions — pay in native CSPR, retry with proof, get the response."
      />

      <H2 id="vending-machine">The vending-machine model</H2>
      <P>
        Each call is independently paid. Hitting <M>/svc/:id</M> without proof returns a{' '}
        <M>402</M> invoice with a single-use nonce; you pay exactly that invoice (a native CSPR
        transfer with <M>transfer_id = nonce</M>) and retry with proof headers. The nonce is
        burned the moment a call is served, so a payment buys exactly one call — there is
        nothing to leak, share or revoke. Discovery is on-chain too: services, prices and trust
        scores live in the registry, browsable in the{' '}
        <DocLink href="/catalog">catalog</DocLink>.
      </P>
      <P>There are three ways to buy, from most to least automated:</P>

      <H2 id="buyer-agent">1 · The buyer agent CLI</H2>
      <CommandBlock
        wrap
        text={'npm run agent -- --task "Get today\'s USD/IDR rate and gold price, summarize for a treasury report" --budget 1'}
      />
      <DocTable
        head={['Argument', 'Required', 'Default', 'Meaning']}
        rows={[
          [
            <M key="a">--task &quot;…&quot;</M>,
            'yes',
            '—',
            'Natural-language task the agent should accomplish.',
          ],
          [
            <M key="a">--budget {'<cspr>'}</M>,
            'no',
            <span key="d">
              <M>BUYER_BUDGET_CSPR</M> (default <M>5</M>)
            </span>,
            'Maximum spend for this run, in CSPR.',
          ],
        ]}
      />
      <H3 id="agent-env">Environment</H3>
      <DocTable
        head={['Variable', 'Mode', 'Purpose']}
        rows={[
          [
            <M key="v">MOCK_BUYER_ACCOUNT</M>,
            'mock',
            <span key="d">
              Buyer public key — generate with{' '}
              <DocLink href="/docs/cli#demo-accounts">agentgate demo-accounts</DocLink>.
            </span>,
          ],
          [<M key="v">BUYER_SIGNER_PEM_PATH</M>, 'live', 'Path to the buyer’s Casper PEM key.'],
          [
            <M key="v">ANTHROPIC_API_KEY</M>,
            'both (optional)',
            'If set, the agent uses Claude; if unset it falls back to the deterministic MockLlm (no API calls).',
          ],
          [
            <M key="v">LLM_MODEL</M>,
            'both (optional)',
            <span key="d">
              Model id when Claude is used. Default <M>claude-sonnet-4-6</M>.
            </span>,
          ],
          [
            <M key="v">BUYER_BUDGET_CSPR</M>,
            'both',
            <span key="d">
              Default budget cap. Default <M>5</M> CSPR.
            </span>,
          ],
        ]}
      />
      <H3 id="agent-steps">What the six steps log</H3>
      <StepFlow
        steps={[
          {
            title: 'CATALOG',
            body: (
              <>
                Queries the on-chain registry with <M>chain.listServices()</M>, fetches each
                score and computes trust tiers. Logs a table of id, name, price (CSPR), tier
                and score.
              </>
            ),
          },
          {
            title: 'DECISION',
            body: (
              <>
                Passes the task + catalog JSON to the LLM, which returns{' '}
                <M>{'{ serviceId, reason }'}</M>. The MockLlm is deterministic: cheapest active
                service whose name/description matches the task keywords; ties broken by
                highest trust tier, then lowest id.
              </>
            ),
          },
          {
            title: 'BUDGET CHECK',
            body: (
              <>
                Computes <M>projected = spent + service.priceMotes</M>. If projected exceeds
                the budget, the agent refuses before paying and exits cleanly with{' '}
                <M>paid=false</M> and <M>spentMotes=&apos;0&apos;</M>.
              </>
            ),
          },
          {
            title: 'PAYMENT',
            body: (
              <>
                Calls <M>client.fetchPaid(service.endpointUrl)</M> with{' '}
                <M>maxPriceMotes</M> set to the remaining budget — a second, client-side guard:
                an invoice above it throws <M>PRICE_EXCEEDED</M>, which is converted into a
                refusal report.
              </>
            ),
          },
          {
            title: 'REPORT',
            body: (
              <>
                On a 2xx upstream response the LLM summarizes the data for the task; otherwise
                a static error line — “service request failed with HTTP X after
                [payment|no payment]”.
              </>
            ),
          },
          {
            title: 'RECEIPT',
            body: (
              <>
                Polls <M>chain.listAttestations</M> (every 500 ms, up to 5000 ms) for the
                attestation whose <M>paymentDeployHash</M> matches the payment, then prints the
                payment deploy hash, attestation tx hash and success flag.
              </>
            ),
          },
        ]}
      />
      <P>
        Every step is also appended as one JSON line to <M>logs/decisions.jsonl</M> (
        <M>run_start</M>, <M>catalog</M>, <M>choice</M>, <M>budget_ok</M> /{' '}
        <M>budget_refusal</M>, <M>payment</M>, <M>summary</M>, <M>attestation</M>,{' '}
        <M>run_end</M>…). Exit codes: 0 for success <em>including intentional budget
        refusals</em>, 1 for unhandled errors, 2 for invalid arguments.
      </P>

      <H2 id="sdk">2 · The client SDK: fetchPaid</H2>
      <P>
        <M>@agentgate/client</M> wraps the whole 402 → pay → retry dance in one call. If the
        first response isn&apos;t a 402, it&apos;s returned untouched (<M>paid: false</M>); if it is,
        the client validates the invoice, enforces the price cap, pays, waits{' '}
        <M>settleDelayMs</M> (0 in mock, 3000 in live) and retries with proof — handling{' '}
        <M>pending</M> responses with up to 5 retries (each sleep capped at 30 s).
      </P>
      <CodeBlock label="typescript" code={SDK_EXAMPLE} />
      <DocTable
        head={['Option', 'Required', 'Meaning']}
        rows={[
          [<M key="o">chain</M>, 'yes', 'ChainClient instance (MockChainHttpClient or LiveCasperClient).'],
          [
            <M key="o">signer</M>,
            'yes',
            <span key="d">
              <M>{"{ kind: 'mock', publicKey }"}</M> or <M>{"{ kind: 'pem', pemPath }"}</M>.
            </span>,
          ],
          [
            <M key="o">maxPriceMotes</M>,
            'no',
            'Refuse to pay any invoice priced above this (motes decimal string) — throws PRICE_EXCEEDED.',
          ],
          [
            <M key="o">settleDelayMs</M>,
            'no',
            'Wait after the on-chain transfer before retrying with proof. Default 0 (mock) / 3000 (live).',
          ],
          [<M key="o">logger</M>, 'no', 'Logger for debug/info/warn events.'],
          [<M key="o">fetchImpl</M>, 'no', 'Injectable fetch (testing). Defaults to globalThis.fetch.'],
        ]}
      />
      <DocTable
        head={['PayAndFetchResult field', 'Meaning']}
        rows={[
          [<M key="f">status</M>, 'HTTP status of the final response.'],
          [<M key="f">body</M>, 'Parsed body (JSON first, text fallback).'],
          [<M key="f">paid</M>, 'true if a payment transfer was initiated.'],
          [<M key="f">invoice</M>, 'The full Invoice402, when a 402 was received.'],
          [<M key="f">deployHash</M>, 'Deploy hash of the payment transfer (when paid).'],
          [<M key="f">priceMotes</M>, 'Amount paid in motes (when paid).'],
        ]}
      />
      <P>
        Thrown errors: <M>PRICE_EXCEEDED</M> (invoice above the cap) and <M>BAD_INVOICE</M>{' '}
        (wrong version, missing fields, invalid nonce or motes format, expired invoice,
        malformed account-hash, non-JSON body).
      </P>

      <H2 id="curl">3 · Manual walkthrough with curl</H2>
      <P>
        Everything the SDK does, by hand — useful for debugging or for integrating from any
        language. Values below are realistic mock-mode examples.
      </P>

      <H3 id="curl-402">Step 1 — request without proof: 402 challenge</H3>
      <CommandBlock wrap text="curl -X GET http://localhost:4021/svc/1 -H 'Accept: application/json' -v" />
      <CodeBlock
        label="response · 402 payment required"
        code={`HTTP/1.1 402 Payment Required
X-AgentGate-Price: 500000000
X-AgentGate-Nonce: 1718173500000
Content-Type: application/json

{
  "version": "agentgate-402/1",
  "network": "mock",
  "serviceId": 1,
  "serviceName": "RWA FX & Gold Oracle",
  "priceMotes": "500000000",
  "paymentTarget": "account-hash-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "nonce": "1718173500000",
  "expiresAt": 1718173800000,
  "instructions": "Pay 0.5 CSPR as a native CSPR transfer to account-hash-abcdef… with transfer_id=1718173500000 before 2026-06-12T11:30:00.000Z, then retry this request with headers 'X-Payment-Deploy-Hash: <your deploy hash>' and 'X-Payment-Nonce: 1718173500000'."
}`}
      />

      <H3 id="curl-pay">Step 2 — pay: native transfer with transfer_id = nonce</H3>
      <P>
        On the mock devnet this is a plain HTTP call; in live mode it is a real Casper transfer
        signed with your key.
      </P>
      <CodeBlock
        label="request · mock devnet"
        code={`curl -X POST http://localhost:4030/chain/transfers \\
  -H 'Content-Type: application/json' \\
  -d '{
    "fromPublicKey": "01abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "to": "account-hash-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "amountMotes": "500000000",
    "transferId": "1718173500000"
  }'`}
      />
      <CodeBlock
        label="response"
        code={`{
  "deployHash": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
  "timestamp": 1718173500123
}`}
      />

      <H3 id="curl-retry">Step 3 — retry with proof headers</H3>
      <CodeBlock
        label="request"
        code={`curl -X GET http://localhost:4021/svc/1 \\
  -H 'Accept: application/json' \\
  -H 'X-Payment-Deploy-Hash: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6' \\
  -H 'X-Payment-Nonce: 1718173500000'`}
      />
      <P>
        The gateway looks up the nonce, verifies the transfer on-chain (target, amount,
        transfer_id, age), burns the nonce atomically and proxies to the upstream:
      </P>
      <CodeBlock
        label="response · 200 ok (upstream payload)"
        code={`HTTP/1.1 200 OK
Content-Type: application/json

{
  "pairs": {
    "usd_idr": { "value": 16250.5,  "sources": [{ "name": "open.er-api.com", "value": 16250.5 }],  "confidence": 0.95 },
    "xau_usd": { "value": 3310.25, "sources": [{ "name": "currency-api",    "value": 3310.25 }], "confidence": 0.97 }
  },
  "asOf": "2026-06-12T10:30:00Z",
  "attribution": "live-sources"
}`}
      />
      <Callout tone="info" title="if the transfer is still settling">
        Live transfers take a moment to finalize. While pending, the gateway answers another{' '}
        <M>402</M> with <M>&quot;error&quot;: &quot;pending&quot;</M> and{' '}
        <M>&quot;retry_after_ms&quot;: 2000</M> — the invoice stays alive (the nonce is not
        burned). Wait and retry with the same headers. Full error table in{' '}
        <DocLink href="/docs/protocol#error-codes">Protocol → 402 error codes</DocLink>.
      </Callout>
      <P>
        Afterwards the gateway records the attestation on-chain asynchronously — watch it
        appear on the <DocLink href="/activity">activity feed</DocLink> or poll{' '}
        <M>GET /chain/services/1/attestations?limit=50</M> on the devnet.
      </P>

      <NextLinks
        links={[
          { href: '/docs/protocol', label: 'Protocol reference' },
          { href: '/docs/api', label: 'HTTP API' },
          { href: '/catalog', label: 'Browse the catalog' },
        ]}
      />
    </>
  );
}
