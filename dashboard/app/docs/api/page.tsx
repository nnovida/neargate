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
  title: 'Docs — HTTP API',
  description:
    'HTTP API reference for every AgentGate surface: the 402 paywall middleware and admin API, the oracle feed, the mock devnet chain, and the dashboard /api routes.',
};

export default function ApiPage() {
  return (
    <>
      <DocHeader
        kicker="docs / http api"
        title="HTTP API reference"
        lede="Four surfaces: the middleware (the 402 paywall itself, plus admin and health), the demo oracle feed, the in-memory devnet that stands in for the chain in mock mode, and the dashboard’s own /api routes."
      />

      <DocTable
        head={['Surface', 'Port', 'Role']}
        rows={[
          [<M key="s">middleware</M>, <M key="p">:4021</M>, '402 paywall reverse proxy + admin API'],
          [<M key="s">oracle</M>, <M key="p">:4010</M>, 'RWA feed: USD/IDR, gold spot, confidence'],
          [<M key="s">devnet</M>, <M key="p">:4030</M>, 'In-memory mock Casper chain (mock mode only)'],
          [
            <M key="s">dashboard</M>,
            <M key="p">:3000</M>,
            'Next.js app + /api routes (port may shift if 3000 is busy)',
          ],
        ]}
      />

      {/* ───────────────────────────── middleware ───────────────────────────── */}
      <H2 id="middleware">Middleware (:4021) — the 402 paywall</H2>

      <H3 id="paywall">ANY /svc/:id — the paywalled proxy</H3>
      <P>
        All HTTP methods are accepted. The service id is a 1-based path parameter (max 15
        digits); the record resolves through a 60 s cache against the chain. Without proof
        headers the response is a <M>402</M> challenge; with valid proof the request is proxied
        to the seller&apos;s upstream and the call is attested on-chain afterwards (success =
        upstream 2xx).
      </P>
      <CodeBlock
        label="402 challenge — headers + body"
        code={`HTTP/1.1 402 Payment Required
X-AgentGate-Price: 500000000
X-AgentGate-Nonce: 12345
Content-Type: application/json

{
  "version": "agentgate-402/1",
  "network": "mock",
  "serviceId": 1,
  "serviceName": "Gold Spot Feed",
  "priceMotes": "500000000",
  "paymentTarget": "account-hash-<64hex>",
  "nonce": "12345",
  "expiresAt": 1718000000000,
  "instructions": "Pay 0.5 CSPR as a native CSPR transfer to account-hash-<…> with transfer_id=12345 …"
}`}
      />
      <P>
        Rejected proofs re-send the invoice with an <M>error</M> field (and{' '}
        <M>retry_after_ms: 2000</M> when <M>pending</M>) — the complete code set is in{' '}
        <DocLink href="/docs/protocol#error-codes">Protocol → 402 error codes</DocLink>.
      </P>

      <H3 id="meta">GET /svc/:id/meta — public metadata (unpaid)</H3>
      <CodeBlock
        label="200 response"
        code={`{
  "service": {
    "id": 1,
    "name": "Gold Spot",
    "description": "Live gold spot price",
    "endpointUrl": "http://gateway:4021/svc/1",
    "priceMotes": "500000000",
    "paymentTarget": "account-hash-<64hex>",
    "owner": "01...",
    "attestor": "01...",
    "active": true,
    "createdAt": 1717900000000
  },
  "score": { "totalCalls": 100, "successCalls": 95 },
  "trustTier": "reliable"
}`}
      />

      <H3 id="middleware-healthz">GET /healthz</H3>
      <CodeBlock label="200 response" code={`{ "ok": true, "network": "mock" }`} />

      <H3 id="admin">Admin API — Bearer auth required</H3>
      <P>
        All admin routes require <M>Authorization: Bearer &lt;AGENTGATE_ADMIN_TOKEN&gt;</M>. In
        live mode the default token is refused at config load — see{' '}
        <DocLink href="/docs/configuration#guardrails">Configuration → Guardrails</DocLink>.
      </P>
      <DocTable
        head={['Route', 'Body / params', 'Response']}
        rows={[
          [
            <M key="r">POST /admin/services</M>,
            <M key="b">{'{ "serviceId": 1, "upstreamUrl": "https://api.example.com/gold" }'}</M>,
            '204 No Content — registers/updates the upstream mapping',
          ],
          [
            <M key="r">GET /admin/services</M>,
            '—',
            <span key="d">
              200 — all mappings, e.g. <M>{'{ "1": "https://api.example.com/gold" }'}</M>
            </span>,
          ],
          [
            <M key="r">DELETE /admin/services/:id</M>,
            'path id',
            '204 No Content — removes the mapping',
          ],
        ]}
      />
      <Callout tone="warn" title="ssrf rules (live mode only)">
        Live mode rejects private/loopback upstream hosts — localhost, 127.*, 10.*,
        172.16–31.*, 192.168.*, 169.254.*, 100.64–127.*, multicast/reserved ranges — validating
        IPv4 and IPv6 literals including IPv4-mapped v6, and canonicalizing exotic IPv4
        spellings (decimal/hex bypasses caught). Mock mode allows localhost for demos.
      </Callout>

      <H3 id="middleware-errors">Non-402 error responses</H3>
      <DocTable
        head={['Status', 'Code', 'Scenario']}
        rows={[
          [<M key="s">404</M>, <M key="c">service_not_found</M>, 'Service id invalid or not registered.'],
          [<M key="s">403</M>, <M key="c">service_inactive</M>, 'Service exists but active=false.'],
          [
            <M key="s">503</M>,
            <M key="c">service_unavailable</M>,
            'Registered on-chain but not mapped in the gateway’s upstreams.',
          ],
          [<M key="s">400</M>, <M key="c">invalid_json</M>, 'Request body is not valid JSON.'],
          [
            <M key="s">413</M>,
            <M key="c">payload_too_large</M>,
            'Request body over 256 KB or response body over 1 MiB.',
          ],
          [
            <M key="s">429</M>,
            <M key="c">rate_limited</M>,
            'Over 60 requests per minute on /svc paths.',
          ],
          [
            <M key="s">502</M>,
            <M key="c">upstream_request_too_large</M>,
            'Proxied request body exceeds 1 MiB.',
          ],
          [<M key="s">502</M>, <M key="c">upstream_unreachable</M>, 'Network error reaching the upstream.'],
          [
            <M key="s">502</M>,
            <M key="c">upstream_response_too_large</M>,
            'Upstream response exceeds 1 MiB.',
          ],
          [
            <M key="s">504</M>,
            <M key="c">upstream_timeout</M>,
            'Upstream exceeded the timeout (default 30 s).',
          ],
          [<M key="s">500</M>, <M key="c">internal_error</M>, 'Unexpected server error.'],
          [<M key="s">404</M>, <M key="c">not_found</M>, 'Unknown route.'],
        ]}
      />

      <H3 id="limits">Rate limits, body limits and forwarded headers</H3>
      <DocTable
        head={['Constraint', 'Value']}
        rows={[
          [
            'Rate limit',
            <span key="d">
              60 requests / 60,000 ms window on all <M>/svc</M> paths, with draft-7{' '}
              <M>RateLimit-*</M> headers; 429 on excess.
            </span>,
          ],
          ['JSON body limit (middleware input)', '256 KB'],
          ['Proxy body cap (both directions)', '1 MiB'],
          [
            'Headers forwarded upstream (whitelist)',
            <span key="d">
              <M>accept</M>, <M>accept-language</M>, <M>user-agent</M> — payment proof headers,
              authorization, cookies, host and x-forwarded-* are never forwarded.
            </span>,
          ],
          [
            'Upstream timeout',
            <span key="d">
              <M>UPSTREAM_TIMEOUT_MS</M>, default 30,000 ms.
            </span>,
          ],
        ]}
      />

      {/* ───────────────────────────── oracle ───────────────────────────── */}
      <H2 id="oracle">Oracle (:4010) — demo RWA feed</H2>
      <P>
        The demo upstream that ships with the repo: USD/IDR and gold spot (XAU/USD) from two
        no-key public sources (<M>open.er-api.com</M> and <M>fawazahmed0/currency-api</M>),
        fetched concurrently with a 5,000 ms per-source timeout and a 60,000 ms cache. It{' '}
        <strong className="text-white">always answers 200</strong>: if every source fails (or{' '}
        <M>ORACLE_STATIC=1</M>) it serves a deterministic fixture (USD/IDR 16250.5, XAU/USD
        3310.25, confidence 0.97, attribution <M>static-fixture</M>).
      </P>
      <DocTable
        head={['Route', 'Returns']}
        rows={[
          [<M key="r">GET /feed</M>, 'Both pairs with sources, confidence, asOf and attribution.'],
          [<M key="r">GET /feed/usd-idr</M>, 'Single pair: usd_idr.'],
          [<M key="r">GET /feed/gold</M>, 'Single pair: xau_usd.'],
          [
            <M key="r">GET /healthz</M>,
            <M key="b">{'{ "ok": true, "static": false }'}</M>,
          ],
        ]}
      />
      <CodeBlock
        label="GET /feed — 200 response"
        code={`{
  "pairs": {
    "usd_idr": {
      "value": 16250.50,
      "sources": [
        { "name": "open.er-api.com", "value": 16250.50 },
        { "name": "fawazahmed0/currency-api", "value": 16250.49 }
      ],
      "confidence": 0.99
    },
    "xau_usd": {
      "value": 3310.25,
      "sources": [
        { "name": "open.er-api.com", "value": 3310.25 },
        { "name": "fawazahmed0/currency-api", "value": 3310.26 }
      ],
      "confidence": 0.98
    }
  },
  "asOf": 1718000000000,
  "attribution": "open.er-api.com, fawazahmed0/currency-api"
}`}
      />
      <P>
        Confidence is deviation-based:{' '}
        <M>max(0, 1 − (maxDeviation / mean) × 10)</M> rounded to 2 decimals; a single surviving
        source scores 0.5.
      </P>

      {/* ───────────────────────────── devnet ───────────────────────────── */}
      <H2 id="devnet">Devnet (:4030) — in-memory mock chain</H2>
      <Callout tone="warn" title="mock mode only">
        The devnet exists so the full loop runs offline. It mirrors the registry contract rules
        exactly (1-based ids, min price 1000 motes, attestation cap 100, newest-first). It is
        never used in live mode.
      </Callout>
      <DocTable
        head={['Route', 'Purpose', 'Notes']}
        rows={[
          [
            <M key="r">POST /faucet</M>,
            'Mint test motes',
            <span key="d">
              body <M>{'{ account, amountMotes }'}</M> → <M>{'{ balanceMotes }'}</M>
            </span>,
          ],
          [
            <M key="r">GET /chain/balance/:account</M>,
            'Check balance',
            <M key="d">{'{ account, balanceMotes }'}</M>,
          ],
          [
            <M key="r">POST /chain/transfers</M>,
            'Native CSPR transfer',
            <span key="d">
              body <M>{'{ fromPublicKey, to, amountMotes, transferId }'}</M> →{' '}
              <M>{'{ deployHash, timestamp }'}</M>
            </span>,
          ],
          [
            <M key="r">GET /chain/transfers/:deployHash</M>,
            'Lookup transfer',
            'full transfer record; 404 not_found if missing',
          ],
          [
            <M key="r">POST /chain/register-service</M>,
            'Register service',
            <span key="d">
              → <M>{'{ serviceId, txHash }'}</M>; 400 on invalid_endpoint_url /
              invalid_request / insufficient_balance
            </span>,
          ],
          [
            <M key="r">POST /chain/attestations</M>,
            'Record attestation',
            <span key="d">
              body <M>{'{ serviceId, paymentDeployHash, success, byPublicKey }'}</M> →{' '}
              <M>{'{ txHash }'}</M>
            </span>,
          ],
          [
            <M key="r">POST /chain/services/:id/active</M>,
            'Set active flag (owner only)',
            <span key="d">
              body <M>{'{ active, byPublicKey }'}</M> → <M>{'{ txHash }'}</M>
            </span>,
          ],
          [<M key="r">GET /chain/services</M>, 'List all services', 'array of service records'],
          [
            <M key="r">GET /chain/services/:id</M>,
            'Get one service',
            '404 not_found if missing',
          ],
          [
            <M key="r">GET /chain/services/:id/score</M>,
            'Get score',
            <M key="d">{'{ totalCalls, successCalls }'}</M>,
          ],
          [
            <M key="r">GET /chain/services/:id/attestations?limit=50</M>,
            'List attestations',
            'limit 1–1000 (default 1000), newest first',
          ],
          [
            <M key="r">GET /chain/activity?limit=50</M>,
            'Global activity log',
            'limit 1–1000 (default 50), newest first, 500 events retained',
          ],
          [
            <M key="r">GET /healthz</M>,
            'Health',
            <M key="d">{'{ "ok": true, "network": "mock" }'}</M>,
          ],
        ]}
      />
      <CodeBlock
        label="GET /chain/activity — 200 response (one event)"
        code={`[
  {
    "kind": "service_registered",
    "txHash": "<64hex>",
    "serviceId": 1,
    "amountMotes": "500000000",
    "success": true,
    "timestamp": 1718000000000,
    "detail": "Service 'Gold Spot' registered by 01..."
  }
]`}
      />
      <DocTable
        head={['Devnet constant', 'Value']}
        rows={[
          ['Body limit', '256 KB'],
          [
            'Min price',
            <span key="d">
              1000 motes (<M>MIN_PRICE_MOTES</M>, contract mirror)
            </span>,
          ],
          ['Activity log cap', '500 events (oldest dropped)'],
          ['Attestations per service cap', '100 (newest-first, oldest dropped)'],
        ]}
      />

      {/* ───────────────────────────── dashboard ───────────────────────────── */}
      <H2 id="dashboard-api">Dashboard /api routes</H2>
      <P>
        This dashboard&apos;s own read-only API, consumed by the{' '}
        <DocLink href="/catalog">catalog</DocLink>, the{' '}
        <DocLink href="/activity">activity feed</DocLink> and the service pages — all polled
        client-side with SWR every 5 seconds. On a chain outage every route answers{' '}
        <M>503 {'{ "error": "chain_unreachable" }'}</M> and the UI shows a red banner.
      </P>
      <DocTable
        head={['Route', 'Returns', 'Notes']}
        rows={[
          [
            <M key="r">GET /api/services</M>,
            <span key="d">
              <M>{'{ network, services: [{ service, score, trustTier }] }'}</M>
            </span>,
            'Full catalog with scores and trust tiers.',
          ],
          [
            <M key="r">GET /api/services/:id</M>,
            <span key="d">
              <M>
                {'{ network, mode, service, score, trustTier, attestations, revenueMotes, balanceMotes }'}
              </M>
            </span>,
            '50 most recent attestations; revenueMotes = price × successCalls (bigint); balanceMotes mock-only (null on live/error); 400 invalid_id on a bad id.',
          ],
          [
            <M key="r">GET /api/activity?limit=50</M>,
            <M key="d">{'{ network, events }'}</M>,
            'limit 1–200, default 50; newest first.',
          ],
          [
            <M key="r">GET /api/stats</M>,
            <span key="d">
              <M>{'{ network, services, activeServices, totalCalls, successCalls, revenueMotes }'}</M>
            </span>,
            'revenueMotes = Σ price × successCalls across services, computed with bigint.',
          ],
        ]}
      />
      <CodeBlock
        label="GET /api/stats — 200 response"
        code={`{
  "network": "mock",
  "services": 5,
  "activeServices": 4,
  "totalCalls": 523,
  "successCalls": 487,
  "revenueMotes": "243750000000"
}`}
      />
      <P>
        Response types are exported from <M>dashboard/lib/api-types.ts</M>:{' '}
        <M>ServicesResponse</M>, <M>ServiceDetailResponse</M>, <M>ActivityResponse</M>,{' '}
        <M>StatsResponse</M>, <M>CatalogEntry</M>, <M>ApiErrorBody</M>.
      </P>

      <NextLinks
        links={[
          { href: '/docs/protocol', label: 'Protocol reference' },
          { href: '/docs/configuration', label: 'Configuration' },
          { href: '/docs/cli', label: 'CLI reference' },
        ]}
      />
    </>
  );
}
