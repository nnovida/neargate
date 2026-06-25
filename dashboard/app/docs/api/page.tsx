import type { Metadata } from 'next';
import {
  ApiBadge,
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
} from '@/components/docs';
import { CommandBlock } from '@/components/copy';

export const metadata: Metadata = {
  title: 'HTTP API',
  description:
    'Reference for every AgentGate HTTP endpoint: the 402 paywall gateway (health, public metadata, the paywalled proxy, and the admin API) and the dashboard read-only /api routes.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="reference"
        title="HTTP API"
        lede="Two surfaces. Part 1 is the gateway (the middleware): health probes, public service metadata, the 402 paywall proxy, and the Bearer-authenticated admin API. Part 2 is the dashboard's own read-only /api routes that feed the catalog and activity views."
      />

      <P>
        The gateway is a server-to-server API for agents — CORS is intentionally off and it is not
        meant to be called from a browser. The dashboard reads the chain through its own Next.js
        routes (Part 2) instead. Both default to JSON responses; the gateway proxy passes the
        upstream&apos;s status and <M>Content-Type</M> through unchanged on a paid call. Ports below
        are the repo defaults; override with environment variables documented in{' '}
        <DocLink href="/docs/configuration">Configuration</DocLink>.
      </P>

      <DocTable
        head={['Surface', 'Base', 'Role']}
        rows={[
          [
            <M key="g">gateway / middleware</M>,
            <M key="gb">:4021</M>,
            'Health, /svc/:id/meta, the 402 paywall proxy, and /admin/*',
          ],
          [
            <M key="d">dashboard</M>,
            <M key="db">:3000</M>,
            'Read-only /api/* routes (services, services/:id, activity, stats, health)',
          ],
        ]}
      />

      {/* ════════════════════════════ PART 1 — GATEWAY ════════════════════════════ */}
      <H2 id="gateway">Part 1 — Gateway (middleware)</H2>
      <P>
        All gateway endpoints are defined in <M>packages/middleware/src/app.ts</M>. Two
        independent rate limiters apply: <M>/svc/*</M> is capped at 60 requests per 60 s window and{' '}
        <M>/admin/*</M> at 20 per minute, both keyed by client IP and returning{' '}
        <M>429 {'{ "error": "rate_limited" }'}</M> with draft-7 <M>RateLimit-*</M> headers on
        excess. The JSON request body limit is 256 KB; proxied bodies are capped at 1 MiB in both
        directions. Unknown routes return <M>404 {'{ "error": "not_found" }'}</M>.
      </P>

      {/* ─────────────── GET /healthz ─────────────── */}
      <H3 id="healthz">Liveness probe</H3>
      <ApiBadge method="GET" path="/healthz" />
      <P>
        Cheap, dependency-free liveness signal for Docker/Railway. Does not touch the chain — it
        only proves the process is up. Always <M>200</M>.
      </P>
      <CodeBlock label="200 OK" code={'{\n  "ok": true,\n  "network": "mock"\n}'} />
      <P>
        <M>network</M> is the chain network string: <M>mock</M> in mock mode, or the configured
        Casper network (for example <M>casper-test</M>) in live mode.
      </P>

      {/* ─────────────── GET /readyz ─────────────── */}
      <H3 id="readyz">Readiness probe</H3>
      <ApiBadge method="GET" path="/readyz" />
      <P>
        Readiness signal for a load balancer: it pings the backing chain. When the chain is
        reachable it returns <M>200 {'{ "ready": true, "network": "..." }'}</M>; when the ping
        fails or throws it returns <M>503 {'{ "ready": false }'}</M> so traffic can be drained from
        a gateway that cannot serve. If the chain client exposes no ping it is treated as ready.
      </P>
      <CodeBlock
        label="200 / 503"
        code={
          '// 200 OK\n{ "ready": true, "network": "mock" }\n\n// 503 Service Unavailable\n{ "ready": false }'
        }
      />

      {/* ─────────────── GET /svc/:id/meta ─────────────── */}
      <H3 id="svc-meta">Public service metadata (unpaid)</H3>
      <ApiBadge method="GET" path="/svc/:id/meta" />
      <P>
        Public, unpaid metadata for a single service: the on-chain record, its score, and the
        derived trust tier. No payment headers are required. The service id is a decimal path
        parameter of 1–15 digits; anything else is treated as not found.
      </P>
      <PropList
        items={[
          {
            name: ':id',
            type: 'path, 1–15 digits',
            required: true,
            desc: <>Numeric service id. A non-numeric or out-of-range id yields a 404.</>,
          },
        ]}
      />
      <CodeBlock
        label="200 OK"
        code={
          '{\n' +
          '  "service": {\n' +
          '    "id": 1,\n' +
          '    "name": "Gold Spot Feed",\n' +
          '    "description": "Live XAU/USD spot price",\n' +
          '    "endpointUrl": "http://gateway:4021/svc/1",\n' +
          '    "priceMotes": "500000000",\n' +
          '    "paymentTarget": "account-hash-<64hex>",\n' +
          '    "owner": "01...",\n' +
          '    "attestor": "01...",\n' +
          '    "active": true,\n' +
          '    "createdAt": 1717900000000\n' +
          '  },\n' +
          '  "score": { "totalCalls": 100, "successCalls": 95 },\n' +
          '  "trustTier": "reliable"\n' +
          '}'
        }
      />
      <DocTable
        head={['Status', 'Body', 'When']}
        rows={[
          [<M key="s">200</M>, <M key="b">{'{ service, score, trustTier }'}</M>, 'Service exists.'],
          [
            <M key="s">404</M>,
            <M key="b">{'{ "error": "service_not_found" }'}</M>,
            'Id is malformed or not registered on-chain.',
          ],
        ]}
      />

      {/* ─────────────── ALL /svc/:id ─────────────── */}
      <H3 id="paywall">The 402 paywall proxy</H3>
      <ApiBadge method="ALL" path="/svc/:id" />
      <P>
        The core endpoint. Every HTTP method is accepted (<M>app.all</M>) and the method, query
        string, and JSON body are forwarded to the seller&apos;s upstream once payment is verified.
        The flow is two-phase:
      </P>
      <DocTable
        head={['Phase', 'Request', 'Response']}
        rows={[
          [
            'Challenge',
            <span key="r">No proof headers.</span>,
            <span key="d">
              <M>402</M> with a fresh <M>Invoice402</M> (price, nonce, expiry, pay-to target).
            </span>,
          ],
          [
            'Redeem',
            <span key="r">
              <M>X-Payment-Deploy-Hash</M> + <M>X-Payment-Nonce</M> after paying on-chain.
            </span>,
            <span key="d">
              <M>200</M> (upstream response proxied) — or <M>402</M> again with an <M>error</M>{' '}
              code if the proof is rejected, or while the payment is still settling.
            </span>,
          ],
        ]}
      />

      <H3 id="proof-headers">Payment proof headers</H3>
      <P>
        Send both headers on the redeem request. Names are case-insensitive on the wire; the values
        are validated strictly.
      </P>
      <PropList
        items={[
          {
            name: 'X-Payment-Deploy-Hash',
            type: 'string',
            required: true,
            desc: (
              <>
                The deploy hash of your native CSPR transfer. Its presence (non-empty after
                trimming) flips the request from challenge to redeem. The gateway looks this transfer
                up on-chain and verifies target, amount, and transfer id against the invoice.
              </>
            ),
          },
          {
            name: 'X-Payment-Nonce',
            type: 'decimal string (1–20 digits)',
            required: true,
            desc: (
              <>
                The invoice <M>nonce</M> you received in the 402 challenge. It must equal the
                transfer&apos;s <M>transfer_id</M> on-chain. A value that fails the{' '}
                <M>^\d{'{'}1,20{'}'}$</M> shape, or that does not match a live invoice for this
                service, re-issues a fresh invoice with <M>error: "unknown_nonce"</M>.
              </>
            ),
          },
        ]}
      />

      <H3 id="challenge-response">402 challenge response</H3>
      <P>
        Issued when no proof is present. Two response headers mirror the invoice for clients that do
        not parse the body, and the JSON body is an <M>Invoice402</M>. The invoice TTL defaults to
        300,000 ms (<M>INVOICE_TTL_MS</M>).
      </P>
      <CodeBlock
        label="402 Payment Required — headers + body"
        code={
          'HTTP/1.1 402 Payment Required\n' +
          'X-AgentGate-Price: 500000000\n' +
          'X-AgentGate-Nonce: 73920184556012\n' +
          'Content-Type: application/json\n' +
          '\n' +
          '{\n' +
          '  "version": "agentgate-402/1",\n' +
          '  "network": "mock",\n' +
          '  "serviceId": 1,\n' +
          '  "serviceName": "Gold Spot Feed",\n' +
          '  "priceMotes": "500000000",\n' +
          '  "paymentTarget": "account-hash-<64hex>",\n' +
          '  "nonce": "73920184556012",\n' +
          '  "expiresAt": 1718000300000,\n' +
          '  "instructions": "Pay 0.5 CSPR as a native CSPR transfer to account-hash-<...> ' +
          'with transfer_id=73920184556012 before <ISO time>, then retry this request with ' +
          "headers 'X-Payment-Deploy-Hash: <your deploy hash>' and 'X-Payment-Nonce: 73920184556012'.\"\n" +
          '}'
        }
      />
      <DocTable
        head={['Response header', 'Value']}
        rows={[
          [<M key="h">X-AgentGate-Price</M>, 'priceMotes (decimal string of motes).'],
          [<M key="h">X-AgentGate-Nonce</M>, 'The invoice nonce / transfer_id to use.'],
        ]}
      />

      <H3 id="redeem-success">Successful redeem</H3>
      <P>
        On a valid proof the gateway verifies the transfer on-chain, burns the nonce (single-use —
        the burn happens before proxying, and exactly one concurrent request wins the race), then
        proxies to the upstream. The upstream&apos;s status and <M>Content-Type</M> pass straight
        through; the upstream URL never appears in any response. After replying, the gateway records
        an on-chain attestation asynchronously (success := upstream answered 2xx).
      </P>
      <CommandBlock
        wrap
        text={
          'curl -sS -X GET http://localhost:4021/svc/1 \\\n' +
          '  -H "X-Payment-Deploy-Hash: <deploy-hash>" \\\n' +
          '  -H "X-Payment-Nonce: 73920184556012"'
        }
      />
      <Callout tone="info" title="header forwarding">
        Only <M>accept</M>, <M>accept-language</M>, and <M>user-agent</M> are forwarded to the
        upstream. Payment proof headers, <M>authorization</M>, cookies, <M>host</M>, and{' '}
        <M>x-forwarded-*</M> are stripped. Non-JSON request bodies are rejected with <M>415</M>{' '}
        before any invoice is issued, so a buyer is never charged for a body the upstream cannot
        receive.
      </Callout>

      <H3 id="redeem-rejected">Rejected / pending redeem — 402 error codes</H3>
      <P>
        When a proof cannot be honored the gateway responds <M>402</M> again. For{' '}
        <M>pending</M> it keeps the <em>same</em> invoice alive and adds <M>retry_after_ms: 2000</M>{' '}
        so the buyer can retry the identical proof; every other reason re-issues a{' '}
        <strong className="text-white">fresh</strong> invoice (new nonce) carrying the{' '}
        <M>error</M> field. The full taxonomy is in{' '}
        <DocLink href="/docs/protocol#invoice-rejection-fields">Protocol → 402 error codes</DocLink>.
      </P>
      <DocTable
        head={['error', 'Origin', 'Meaning']}
        rows={[
          [
            <M key="e">unknown_nonce</M>,
            'invoice store',
            'Nonce is malformed, unknown, or bound to a different service.',
          ],
          [<M key="e">invoice_used</M>, 'invoice store', 'This invoice was already redeemed.'],
          [<M key="e">invoice_expired</M>, 'invoice store', 'The invoice TTL elapsed before redeem.'],
          [
            <M key="e">pending</M>,
            'verifyTransfer',
            'Transfer not yet finalized — retry the same proof after retry_after_ms (2000).',
          ],
          [<M key="e">not_found</M>, 'verifyTransfer', 'No transfer exists for the deploy hash.'],
          [
            <M key="e">wrong_target</M>,
            'verifyTransfer',
            'Transfer did not pay the service paymentTarget.',
          ],
          [
            <M key="e">amount_too_low</M>,
            'verifyTransfer',
            'Transferred fewer motes than priceMotes.',
          ],
          [
            <M key="e">wrong_transfer_id</M>,
            'verifyTransfer',
            'On-chain transfer_id does not equal the invoice nonce.',
          ],
          [
            <M key="e">expired</M>,
            'verifyTransfer',
            'Transfer is older than the max age (the invoice TTL).',
          ],
        ]}
      />
      <CodeBlock
        label="402 — rejected proof (fresh invoice)"
        code={
          '{\n' +
          '  "version": "agentgate-402/1",\n' +
          '  "network": "mock",\n' +
          '  "serviceId": 1,\n' +
          '  "serviceName": "Gold Spot Feed",\n' +
          '  "priceMotes": "500000000",\n' +
          '  "paymentTarget": "account-hash-<64hex>",\n' +
          '  "nonce": "44188205571903",\n' +
          '  "expiresAt": 1718000600000,\n' +
          '  "instructions": "Pay 0.5 CSPR ...",\n' +
          '  "error": "amount_too_low"\n' +
          '}'
        }
      />
      <CodeBlock
        label="402 — still settling (same invoice retained)"
        code={
          '{\n' +
          '  "version": "agentgate-402/1",\n' +
          '  "serviceId": 1,\n' +
          '  "nonce": "73920184556012",\n' +
          '  "error": "pending",\n' +
          '  "retry_after_ms": 2000\n' +
          '  // ...remaining invoice fields unchanged\n' +
          '}'
        }
      />

      <H3 id="svc-errors">Non-402 errors on /svc/:id</H3>
      <P>
        These are returned before, or instead of, the paywall — the gateway never charges for a
        request it cannot serve.
      </P>
      <DocTable
        head={['Status', 'Code', 'Scenario']}
        rows={[
          [
            <M key="s">404</M>,
            <M key="c">service_not_found</M>,
            'Id malformed or not registered on-chain.',
          ],
          [<M key="s">403</M>, <M key="c">service_inactive</M>, 'Service exists but active=false.'],
          [
            <M key="s">503</M>,
            <M key="c">service_unavailable</M>,
            'Registered on-chain but not mapped on this gateway, or (live) the upstream host fails the request-time SSRF re-check.',
          ],
          [
            <M key="s">415</M>,
            <M key="c">unsupported_media_type</M>,
            'Request carries a non-JSON body the gateway cannot forward.',
          ],
          [<M key="s">429</M>, <M key="c">rate_limited</M>, 'Over 60 requests/min on /svc paths.'],
          [
            <M key="s">502</M>,
            <M key="c">upstream_unreachable</M>,
            'Network error reaching the upstream.',
          ],
          [
            <M key="s">502</M>,
            <M key="c">upstream_request_too_large</M>,
            'Proxied request body exceeds 1 MiB.',
          ],
          [
            <M key="s">502</M>,
            <M key="c">upstream_response_too_large</M>,
            'Upstream response exceeds 1 MiB.',
          ],
          [
            <M key="s">504</M>,
            <M key="c">upstream_timeout</M>,
            'Upstream exceeded UPSTREAM_TIMEOUT_MS (default 30,000 ms).',
          ],
        ]}
      />
      <Callout tone="warn" title="upstream failures still consumed the invoice">
        The nonce is burned <em>before</em> proxying, so a <M>502</M>/<M>504</M> from the upstream
        still consumes that invoice — the buyer must obtain a new invoice (and pay again) to retry.
        The attestation for that call records success=false.
      </Callout>

      {/* ─────────────── Admin API ─────────────── */}
      <H2 id="admin">Admin API</H2>
      <P>
        The admin API maps on-chain service ids to the real upstream URLs this gateway will proxy
        to. The mapping lives only on the gateway (it is never on-chain). Every admin route requires{' '}
        <M>Authorization: Bearer &lt;AGENTGATE_ADMIN_TOKEN&gt;</M>, compared in constant time; a
        missing or wrong token returns <M>401 {'{ "error": "unauthorized" }'}</M>. In live mode the
        default token <M>dev-admin-token</M> is refused at config load — see{' '}
        <DocLink href="/docs/configuration">Configuration</DocLink>.
      </P>

      {/* POST /admin/services */}
      <H3 id="admin-create">Map / update an upstream</H3>
      <ApiBadge method="POST" path="/admin/services" />
      <P>
        Registers or replaces the upstream URL for a service id. The body is JSON. The URL is
        SSRF-checked: in live mode private, loopback, link-local, and reserved hosts are rejected
        (IPv4 and IPv6 literals, IPv4-mapped v6, and exotic decimal/hex IPv4 spellings are
        canonicalized and caught); mock mode allows localhost for demos. On success it stores the
        normalized URL and returns <M>204 No Content</M>.
      </P>
      <PropList
        items={[
          {
            name: 'serviceId',
            type: 'number (safe non-negative integer)',
            required: true,
            desc: <>The on-chain service id to map. Non-integer or negative yields a 400.</>,
          },
          {
            name: 'upstreamUrl',
            type: 'string (http/https URL)',
            required: true,
            desc: (
              <>
                The real API URL the gateway proxies to after payment. Must pass the SSRF guard;
                otherwise a 400 with the validator&apos;s specific reason is returned.
              </>
            ),
          },
        ]}
      />
      <CommandBlock
        wrap
        text={
          'curl -sS -X POST http://localhost:4021/admin/services \\\n' +
          '  -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          '  -d \'{ "serviceId": 1, "upstreamUrl": "https://api.example.com/gold" }\''
        }
      />
      <DocTable
        head={['Status', 'Body', 'When']}
        rows={[
          [<M key="s">204</M>, '(empty)', 'Mapping stored.'],
          [
            <M key="s">400</M>,
            <M key="b">{'{ "error": "invalid_body" }'}</M>,
            'Body is missing or not a JSON object.',
          ],
          [
            <M key="s">400</M>,
            <M key="b">{'{ "error": "invalid_service_id" }'}</M>,
            'serviceId is not a safe non-negative integer.',
          ],
          [
            <M key="s">400</M>,
            <M key="b">{'{ "error": "<ssrf reason>" }'}</M>,
            'upstreamUrl failed validation (e.g. bad scheme, private host in live mode).',
          ],
          [<M key="s">401</M>, <M key="b">{'{ "error": "unauthorized" }'}</M>, 'Missing/wrong Bearer token.'],
        ]}
      />

      {/* GET /admin/services */}
      <H3 id="admin-list">List upstream mappings</H3>
      <ApiBadge method="GET" path="/admin/services" />
      <P>
        Returns the full id → URL map this gateway holds. Bearer auth required.
      </P>
      <CodeBlock
        label="200 OK"
        code={'{\n  "1": "https://api.example.com/gold",\n  "2": "https://api.example.com/fx"\n}'}
      />

      {/* DELETE /admin/services/:id */}
      <H3 id="admin-delete">Remove an upstream mapping</H3>
      <ApiBadge method="DELETE" path="/admin/services/:id" />
      <P>
        Removes the mapping for a service id. After deletion, paid calls to <M>/svc/:id</M> return{' '}
        <M>503 service_unavailable</M> until it is mapped again. Bearer auth required.
      </P>
      <DocTable
        head={['Status', 'Body', 'When']}
        rows={[
          [<M key="s">204</M>, '(empty)', 'Mapping removed (idempotent — also 204 if absent).'],
          [
            <M key="s">400</M>,
            <M key="b">{'{ "error": "invalid_service_id" }'}</M>,
            'Path id is malformed.',
          ],
          [<M key="s">401</M>, <M key="b">{'{ "error": "unauthorized" }'}</M>, 'Missing/wrong Bearer token.'],
        ]}
      />

      {/* ════════════════════════════ PART 2 — DASHBOARD ════════════════════════════ */}
      <H2 id="dashboard">Part 2 — Dashboard read API</H2>
      <P>
        The dashboard&apos;s own read-only routes under <M>dashboard/app/api/*</M>. They run on the
        Node.js runtime, are force-dynamic and never cached, and read the chain through one
        server-side client (the browser never talks to the chain directly). On a chain outage every
        data route answers <M>503 {'{ "error": "chain_unreachable" }'}</M> (or{' '}
        <M>500 {'{ "error": "config_invalid" }'}</M> on an invalid config), and the UI shows a
        banner. Response types are exported from <M>dashboard/lib/api-types.ts</M>.
      </P>

      <H3 id="dash-services">GET /api/services</H3>
      <ApiBadge method="GET" path="/api/services" />
      <P>
        The full catalog: every service with its score and derived trust tier. Type{' '}
        <M>ServicesResponse</M>.
      </P>
      <CodeBlock
        label="200 OK"
        code={
          '{\n' +
          '  "network": "mock",\n' +
          '  "services": [\n' +
          '    {\n' +
          '      "service": { "id": 1, "name": "Gold Spot Feed", "priceMotes": "500000000", ... },\n' +
          '      "score": { "totalCalls": 100, "successCalls": 95 },\n' +
          '      "trustTier": "reliable"\n' +
          '    }\n' +
          '  ]\n' +
          '}'
        }
      />

      <H3 id="dash-service">GET /api/services/[id]</H3>
      <ApiBadge method="GET" path="/api/services/:id" />
      <P>
        Detail for one service, plus the 50 most recent attestations and money math. Type{' '}
        <M>ServiceDetailResponse</M>. <M>revenueMotes</M> = price × successCalls (bigint,
        stringified). <M>balanceMotes</M> is the payment target&apos;s wallet balance — populated in
        mock mode only, and <M>null</M> in live mode or if the lookup fails.
      </P>
      <DocTable
        head={['Status', 'Body', 'When']}
        rows={[
          [<M key="s">200</M>, <M key="b">ServiceDetailResponse</M>, 'Service found.'],
          [<M key="s">400</M>, <M key="b">{'{ "error": "invalid_id" }'}</M>, 'Id is not 1–15 digits.'],
          [
            <M key="s">404</M>,
            <M key="b">{'{ "error": "not_found" }'}</M>,
            'No service with that id.',
          ],
        ]}
      />
      <CodeBlock
        label="200 OK"
        code={
          '{\n' +
          '  "network": "mock",\n' +
          '  "mode": "mock",\n' +
          '  "service": { "id": 1, "name": "Gold Spot Feed", ... },\n' +
          '  "score": { "totalCalls": 100, "successCalls": 95 },\n' +
          '  "trustTier": "reliable",\n' +
          '  "attestations": [ { "serviceId": 1, "success": true, "timestamp": 1718000000000, ... } ],\n' +
          '  "revenueMotes": "47500000000",\n' +
          '  "balanceMotes": "12000000000"\n' +
          '}'
        }
      />

      <H3 id="dash-activity">GET /api/activity</H3>
      <ApiBadge method="GET" path="/api/activity" />
      <P>
        The recent global activity feed, newest first. Type <M>ActivityResponse</M>. The optional{' '}
        <M>?limit=</M> query is clamped to 1–200 (default 50).
      </P>
      <CodeBlock
        label="200 OK"
        code={
          '{\n' +
          '  "network": "mock",\n' +
          '  "events": [\n' +
          '    {\n' +
          '      "kind": "service_registered",\n' +
          '      "txHash": "<64hex>",\n' +
          '      "serviceId": 1,\n' +
          '      "amountMotes": "500000000",\n' +
          '      "success": true,\n' +
          '      "timestamp": 1718000000000,\n' +
          '      "detail": "Service \'Gold Spot Feed\' registered by 01..."\n' +
          '    }\n' +
          '  ]\n' +
          '}'
        }
      />

      <H3 id="dash-stats">GET /api/stats</H3>
      <ApiBadge method="GET" path="/api/stats" />
      <P>
        Aggregate platform totals. Type <M>StatsResponse</M>. <M>revenueMotes</M> = Σ (price ×
        successCalls) across all services, computed with bigint to avoid float drift on money.
      </P>
      <CodeBlock
        label="200 OK"
        code={
          '{\n' +
          '  "network": "mock",\n' +
          '  "services": 5,\n' +
          '  "activeServices": 4,\n' +
          '  "totalCalls": 523,\n' +
          '  "successCalls": 487,\n' +
          '  "revenueMotes": "243750000000"\n' +
          '}'
        }
      />

      <H3 id="dash-health">GET /api/health</H3>
      <ApiBadge method="GET" path="/api/health" />
      <P>
        Liveness probe for the dashboard process itself. Deliberately does not touch the chain (that
        is the gateway&apos;s <M>/readyz</M> job), so it stays a fast, pure up signal. Always{' '}
        <M>200</M>.
      </P>
      <CodeBlock label="200 OK" code={'{ "status": "ok" }'} />

      <NextLinks
        links={[
          { href: '/docs/buyers', label: 'Client SDK' },
          { href: '/docs/protocol#invoice-rejection-fields', label: 'Error codes' },
        ]}
      />
    </>
  );
}
