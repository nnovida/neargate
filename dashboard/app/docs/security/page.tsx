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
import { CommandBlock } from '@/components/copy';

export const metadata: Metadata = {
  title: 'Security model',
  description:
    'How AgentGate defends a money-moving gateway: SSRF guards against seller-controlled URLs, fail-closed live configuration, single-use payment nonces, secret redaction, rate limiting, request limits, and prompt-injection containment.',
};

export default function SecurityPage() {
  return (
    <>
      <DocHeader
        kicker="docs / security"
        title="Security model"
        lede="AgentGate is a payment gateway that moves real CSPR and proxies traffic to seller-supplied URLs, so security is not a feature — it is the contract. This page documents the threats the codebase actually defends against and the exact mechanisms that do it, file by file."
      />
      <P>
        Two principles run through the implementation. First, <strong>everything a seller or buyer
        supplies is untrusted</strong>: upstream URLs, invoices, request bodies, and catalog text all
        cross a trust boundary and are re-validated at the point of use. Second, the system{' '}
        <strong>fails closed</strong>: in live mode a missing secret, a default token, or a host that
        resolves to a private address aborts the operation rather than degrading to an insecure
        fallback.
      </P>

      <H2 id="ssrf">SSRF protection</H2>
      <P>
        The gateway makes outbound HTTP requests to URLs that a <em>seller</em> controls (the
        on-chain <M>endpointUrl</M> / the admin-mapped <M>upstreamUrl</M>). Without guards, a seller
        could point a service at <M>http://169.254.169.254/</M> (cloud metadata),{' '}
        <M>http://127.0.0.1</M>, or an RFC1918 address and turn the gateway into a Server-Side Request
        Forgery proxy into the operator&apos;s internal network. AgentGate blocks this at two
        independent layers, both implemented in{' '}
        <M>@agentgate/shared/net-guard</M> (kept in a subpath module so it never gets pulled into a
        browser bundle).
      </P>

      <H3 id="ssrf-register">Layer 1 — registration-time literal check</H3>
      <P>
        When an upstream is mapped via <M>POST /admin/services</M>, the middleware runs{' '}
        <M>validateUpstreamUrl(upstreamUrl, &#123; rejectPrivateHosts &#125;)</M> (a thin wrapper over{' '}
        <M>validateHttpUrl</M>). It enforces: a parseable URL no longer than{' '}
        <M>2048</M> characters (<M>MAX_URL_LENGTH</M>); a protocol of exactly <M>http:</M> or{' '}
        <M>https:</M>; <strong>no embedded credentials</strong> (a non-empty{' '}
        <M>username</M>/<M>password</M> is rejected); a non-empty hostname; and, when{' '}
        <M>rejectPrivateHosts</M> is set, a hostname that is not in the private blocklist. The same
        check is re-applied at boot in <M>upstreams.loadSync(...)</M>, so a persisted mapping to a host
        that has since become forbidden is dropped, not trusted. Invalid URLs return{' '}
        <M>invalid_upstream_url</M>; private hosts return <M>forbidden_upstream_host</M>.
      </P>
      <Callout tone="info" title="WHATWG canonicalisation closes spelling tricks">
        URLs are parsed with the WHATWG <M>URL</M> constructor, which canonicalises exotic IPv4
        spellings — <M>http://2130706433</M> becomes <M>127.0.0.1</M>, hex and octal forms collapse to
        dotted-decimal — so the literal-IP checks below catch decimal/hex/octal bypass attempts.
      </Callout>

      <H3 id="ssrf-rebind">Layer 2 — fetch-time re-resolution (DNS rebinding / TOCTOU)</H3>
      <P>
        A hostname that was public at registration can later be re-pointed at a private address. To
        defeat this rebinding / time-of-check-to-time-of-use gap, the live-mode paywall calls{' '}
        <M>resolvedHostIsPublic(host)</M> on <strong>every</strong> request, immediately before
        connecting (see <DocLink href="/docs/protocol">the paywall flow</DocLink>). IP literals are
        decided synchronously; DNS names are resolved with <M>dns.lookup(host, &#123; all: true &#125;)</M>{' '}
        and the request is refused if <strong>any</strong> resolved address is private. Resolution
        failure also refuses (fail closed). If the host is forbidden, the gateway returns{' '}
        <M>503 service_unavailable</M> <em>before any payment is charged</em> and logs{' '}
        <M>upstream_host_forbidden</M>.
      </P>
      <Callout tone="warn" title="Residual rebinding race">
        Node&apos;s global <M>fetch</M> resolves DNS again internally after this check, so a
        sub-millisecond re-resolution race remains. Closing it fully needs connection-level IP pinning
        (a custom undici dispatcher) — that is not yet implemented. The current check still closes the
        practical &quot;rebind after registration&quot; attack.
      </Callout>

      <H3 id="ssrf-blocklist">What counts as a private host</H3>
      <P>
        <M>isPrivateHost</M> rejects empty hosts, <M>localhost</M> and any <M>*.localhost</M> name, and
        the IP ranges below. Hostname normalisation strips IPv6 brackets, a trailing dot, and
        lowercases before matching.
      </P>
      <DocTable
        head={['Family', 'Range / value', 'Why blocked']}
        rows={[
          [<M key="a">IPv4</M>, <M key="b">0.0.0.0/8</M>, '"this network" / unspecified.'],
          [<M key="a">IPv4</M>, <M key="b">10.0.0.0/8</M>, 'RFC1918 private.'],
          [<M key="a">IPv4</M>, <M key="b">127.0.0.0/8</M>, 'Loopback.'],
          [<M key="a">IPv4</M>, <M key="b">100.64.0.0/10</M>, 'CGNAT (carrier-grade NAT).'],
          [
            <M key="a">IPv4</M>,
            <M key="b">169.254.0.0/16</M>,
            'Link-local — includes 169.254.169.254 cloud metadata.',
          ],
          [<M key="a">IPv4</M>, <M key="b">172.16.0.0/12</M>, 'RFC1918 private.'],
          [<M key="a">IPv4</M>, <M key="b">192.168.0.0/16</M>, 'RFC1918 private.'],
          [<M key="a">IPv4</M>, <M key="b">192.0.0.0/24, 192.0.2.0/24</M>, 'IETF special-use / documentation.'],
          [<M key="a">IPv4</M>, <M key="b">198.18.0.0, 198.19.0.0</M>, 'Benchmarking range.'],
          [<M key="a">IPv4</M>, <M key="b">224.0.0.0+</M>, 'Multicast, reserved, broadcast.'],
          [<M key="a">IPv6</M>, <M key="b">::, ::1</M>, 'Unspecified and loopback.'],
          [<M key="a">IPv6</M>, <M key="b">fc00::/7</M>, 'Unique-local (fc/fd prefixes).'],
          [<M key="a">IPv6</M>, <M key="b">fe80::/10</M>, 'Link-local.'],
          [
            <M key="a">IPv6</M>,
            <M key="b">::ffff:&lt;v4&gt;</M>,
            'IPv4-mapped addresses are decoded and re-checked against the IPv4 rules; unparseable mapped forms are refused conservatively.',
          ],
        ]}
      />
      <Callout tone="info" title="Private hosts are allowed in mock mode by design">
        The SSRF guard only rejects private hosts when <M>rejectPrivateHosts</M> is true, which the
        middleware sets to <M>config.mode === &apos;live&apos;</M>. In <M>mock</M> mode private hosts
        are allowed so you can map a service at <M>http://localhost:PORT</M> for local demos. Private
        hosts are <strong>only</strong> blocked in live mode.
      </Callout>

      <H3 id="ssrf-buyer">The buyer client guards the seller endpoint too</H3>
      <P>
        SSRF is symmetric: a buyer agent fetches a URL that came from seller-controlled on-chain data,
        so the client in <M>@agentgate/client</M> applies the same guard before it spends money. In{' '}
        <M>fetchPaid</M> it runs <M>validateHttpUrl(url, &#123; rejectPrivateHosts &#125;)</M> and, when
        guarding, <M>await resolvedHostIsPublic(...)</M>. The default for{' '}
        <M>rejectPrivateHosts</M> is <M>chain.network !== &apos;mock&apos;</M> — on by default off-mock.
        A rejected URL throws <M>FORBIDDEN_HOST</M> (private host) or <M>BAD_URL</M> (bad scheme/shape)
        with HTTP <M>400</M> — <em>before</em> any transfer is signed.
      </P>

      <H2 id="fail-closed">Fail-closed configuration</H2>
      <P>
        <DocLink href="/docs/configuration">Configuration</DocLink> is validated once by{' '}
        <M>loadConfig()</M> in <M>@agentgate/shared</M>, which throws <M>CONFIG_INVALID</M> on bad
        values. Live mode adds hard preconditions so the gateway cannot boot in an insecure-but-running
        state:
      </P>
      <DocTable
        head={['Live-mode requirement', 'Enforced by', 'Failure']}
        rows={[
          [
            <span key="a">
              <M>CSPR_CLOUD_API_KEY</M> must be set
            </span>,
            <M key="b">loadConfig()</M>,
            'CONFIG_INVALID — live mode needs the chain data API key.',
          ],
          [
            <span key="a">
              <M>AGENTGATE_ADMIN_TOKEN</M> must not be the shipped default (<M>dev-admin-token</M>)
            </span>,
            <M key="b">loadConfig()</M>,
            'CONFIG_INVALID — refuses the default token, demands a strong unique one.',
          ],
          [
            <span key="a">
              <M>GATE_SIGNER_PEM_PATH</M> (the attestor key) must be set
            </span>,
            <M key="b">createApp()</M>,
            'CONFIG_INVALID — refuses the mock-signer fallback, which would record keyless attestations.',
          ],
        ]}
      />
      <P>
        There is one more boot-time guard worth knowing: the in-process <M>devnet</M> refuses to start
        in live mode. There is no path where the mock chain quietly backs a &quot;live&quot; gateway.
        See <DocLink href="/docs/deployment">Deploy to production</DocLink> for the full live checklist.
      </P>

      <H2 id="payment-integrity">Payment integrity</H2>
      <P>
        The paywall in <M>packages/middleware/src/app.ts</M> enforces several invariants so a buyer
        cannot replay, underpay, or pay on the wrong chain. Payment is a <strong>native CSPR</strong>{' '}
        transfer whose <M>transfer_id</M> equals the invoice nonce.
      </P>
      <H3 id="payment-nonce">Single-use nonce burn</H3>
      <P>
        Each 402 challenge issues a fresh random nonce and persists an invoice record. When a buyer
        retries with proof, the gateway looks up the invoice, rejects it if{' '}
        <M>invoice.used</M> (<M>invoice_used</M>), if it has expired (<M>invoice_expired</M>), or if its{' '}
        <M>serviceId</M> does not match (<M>unknown_nonce</M>). Critically, after the on-chain transfer
        verifies, the nonce is burned with <M>invoices.markUsed(nonce)</M>{' '}
        <strong>before</strong> proxying to the upstream — so the nonce is single-use even if the
        upstream call later fails, and the atomic mark-used means exactly one of several concurrent
        requests can win the race; the losers get a fresh 402.
      </P>
      <H3 id="payment-verify">On-chain transfer verification</H3>
      <P>
        Before serving anything, the gateway calls <M>chain.verifyTransfer(...)</M> against the
        presented deploy hash and checks the transfer actually landed: it must go to the
        service&apos;s <M>paymentTarget</M>, carry at least <M>priceMotes</M>{' '}
        (<M>minAmountMotes</M> — an underpayment fails), carry the matching{' '}
        <M>transfer_id</M> (the nonce), and be no older than the invoice TTL (<M>maxAgeMs</M>). A still-settling
        transfer returns <M>pending</M>, which keeps the <em>same</em> invoice alive and tells the buyer
        to retry the identical proof after <M>retry_after_ms</M> (<M>2000</M> ms) — it does not burn the
        nonce or issue a new one.
      </P>
      <H3 id="payment-network">Network binding and buyer budget cap</H3>
      <P>
        Two checks live on the buyer side in <M>@agentgate/client</M>. The invoice{' '}
        <M>network</M> must equal the chain the client transfers on — a mismatch throws{' '}
        <M>NETWORK_MISMATCH</M>, so the agent never pays on a different network than the one it signs
        for. And the agent&apos;s budget cap is bound to the approved price: if{' '}
        <M>maxPriceMotes</M> is set and the invoice price exceeds it, <M>fetchPaid</M> throws{' '}
        <M>PRICE_EXCEEDED</M> (HTTP <M>402</M>) <em>before</em> signing any transfer. The whole invoice
        is also strictly validated by <M>parseInvoice402</M> (exact version{' '}
        <M>agentgate-402/1</M>, <M>paymentTarget</M> must match{' '}
        <M>account-hash-&lt;64 hex&gt;</M>, nonce must be a u64 decimal{' '}
        <M>&le; 2^64-1</M>, <M>expiresAt</M> must be in the future) — anything off throws{' '}
        <M>BAD_INVOICE</M>.
      </P>

      <H2 id="keys">Key handling and secret redaction</H2>
      <P>
        Live mode signs with PEM private keys on disk (<M>GATE_SIGNER_PEM_PATH</M>,{' '}
        <M>BUYER_SIGNER_PEM_PATH</M>, <M>SELLER_SIGNER_PEM_PATH</M>). Treat these like any production
        signing key: restrict file permissions to the service account, never commit them, and rotate on
        suspected exposure.
      </P>
      <P>
        Defense-in-depth against accidental leakage lives in the logger (<M>@agentgate/shared</M> /{' '}
        <M>logger.ts</M>). Every structured log field is recursively scanned and any key whose name
        matches a sensitive pattern is masked before it reaches stdout. The pattern matches (case-insensitive,
        as a substring) <M>token</M>, <M>secret</M>, <M>api-key</M>/<M>apikey</M>, <M>password</M>/
        <M>passwd</M>, <M>authorization</M>, <M>private-key</M>/<M>privatekey</M>, <M>pem</M>,{' '}
        <M>mnemonic</M>, <M>seed</M>, <M>credential</M>, <M>signature</M>, and <M>bearer</M> — so{' '}
        <M>adminToken</M>, <M>csprCloudApiKey</M>, <M>Authorization</M>, and <M>gateSignerPem</M> all
        redact. Values longer than 8 chars become a length-tagged hint; shorter ones become{' '}
        <M>[redacted]</M>. The redactor is depth- and cycle-guarded so it cannot loop on circular
        structures.
      </P>
      <CodeBlock
        label="A stray secret in a log field is masked automatically"
        code={
          'logger.info("startup", { adminToken: "s3cr3t-admin-token-value" });\n' +
          '// stdout:\n' +
          '{"ts":"...","level":"info","name":"middleware","msg":"startup",\n' +
          ' "adminToken":"s3…[redacted:23]"}'
        }
      />
      <Callout tone="info" title="Use HTTPS for the live gateway">
        The admin token and proof headers are bearer credentials. Terminate TLS in front of the
        gateway (or behind a platform proxy that does) so they are never sent in cleartext — see{' '}
        <DocLink href="/docs/deployment">Deploy to production</DocLink>.
      </Callout>

      <H2 id="rate-limit">Rate limiting and the reverse proxy</H2>
      <P>
        The middleware mounts <M>helmet()</M> for hardened response headers, disables the{' '}
        <M>x-powered-by</M> banner, and applies two per-IP rate limits via{' '}
        <M>express-rate-limit</M> over a 60-second window:
      </P>
      <DocTable
        head={['Scope', 'Limit / minute', 'Purpose']}
        rows={[
          [<M key="a">/svc</M>, <M key="b">60</M>, 'Paywall / proxy traffic per client IP.'],
          [
            <M key="a">/admin</M>,
            <M key="b">20</M>,
            'Stricter — blunts brute force against the admin bearer token.',
          ],
        ]}
      />
      <P>
        Over-limit requests get <M>429</M> with <M>&#123; error: &quot;rate_limited&quot; &#125;</M>{' '}
        and draft-7 standard rate-limit headers. The admin API additionally compares the bearer token
        in <strong>constant time</strong> (<M>safeEqual</M> hashes both sides with SHA-256 first so
        lengths never short-circuit the comparison), defeating timing side-channels on the token.
        CORS is intentionally off: the gateway is a server-to-server API, not called from browsers.
      </P>
      <Callout tone="warn" title="TRUST_PROXY must equal the real hop count">
        Rate limiting keys off <M>req.ip</M>. Behind a reverse proxy you must set{' '}
        <M>TRUST_PROXY</M> to the number of trusted hops (Express <M>trust proxy</M>) so{' '}
        <M>req.ip</M> reflects the real client and not the proxy. The default is <M>0</M> (trust none).
        Behind one platform proxy (Railway/Vercel) set <M>TRUST_PROXY=1</M>. <strong>Never set it
        higher than the real hop count</strong> — doing so makes <M>X-Forwarded-For</M> spoofable,
        which lets an attacker forge client IPs and evade the rate limiter entirely. The accepted range
        is <M>0</M>&ndash;<M>10</M>.
      </Callout>

      <H2 id="request-limits">Request limits and the proxy</H2>
      <P>
        The gateway only relays bodies it can faithfully forward, and bounds every dimension of an
        inbound request so it cannot be used to exhaust resources or to bill a buyer for an
        undeliverable call.
      </P>
      <DocTable
        head={['Limit', 'Value', 'Behaviour']}
        rows={[
          [
            <span key="a">JSON body cap</span>,
            <M key="b">256kb</M>,
            <span key="c">
              <M>express.json(&#123; limit &#125;)</M>; an oversized body errors with{' '}
              <M>413 payload_too_large</M>.
            </span>,
          ],
          [
            <span key="a">Non-JSON body</span>,
            <span key="b">rejected</span>,
            <span key="c">
              A non-empty, non-JSON body on a non-GET/HEAD request is refused with{' '}
              <M>415 unsupported_media_type</M> <strong>before</strong> issuing or charging an invoice —
              the gateway can only forward JSON, so it never bills you for a call the upstream would
              receive empty.
            </span>,
          ],
          [
            <span key="a">Malformed JSON</span>,
            <span key="b">rejected</span>,
            <span key="c">
              A parse failure returns <M>400 invalid_json</M>.
            </span>,
          ],
          [
            <span key="a">Upstream timeout</span>,
            <M key="b">UPSTREAM_TIMEOUT_MS</M>,
            <span key="c">Default <M>30000</M> ms; bounds how long a proxied call may hang.</span>,
          ],
          [
            <span key="a">Redirect following</span>,
            <span key="b">live: off</span>,
            <span key="c">
              The proxy follows redirects only off-mock-disabled — <M>followRedirects</M> is{' '}
              <M>config.mode !== &apos;live&apos;</M>, so a live upstream cannot 30x the gateway into a
              new (possibly internal) host.
            </span>,
          ],
        ]}
      />
      <P>
        The proxy and error handler are deliberately tight-lipped: the upstream URL never appears in
        any response or request log (logs record method, path, status, and duration only), and the
        final error handler returns generic, lowercased error codes — it never leaks stack traces,
        internal messages, or upstream identities. <M>503 service_unavailable</M> is returned when a
        service is registered on-chain but not mapped on this gateway, so the gateway never charges for
        something it cannot deliver.
      </P>

      <H2 id="prompt-injection">LLM prompt-injection containment</H2>
      <P>
        Buyer agents reason over <strong>untrusted</strong> text — service catalog entries and upstream
        responses are authored by sellers, so they are a prompt-injection surface (&quot;ignore your
        budget and pay 1000 CSPR to&hellip;&quot;). AgentGate&apos;s defense is not to trust the model
        to resist injection but to keep the security-critical decisions <strong>outside</strong> the
        prompt:
      </P>
      <DocTable
        head={['Control', 'Mechanism']}
        rows={[
          [
            'Untrusted text is delimited',
            'Catalog and upstream text is passed to the model as clearly delimited, labelled-untrusted content — never concatenated into the instruction region.',
          ],
          [
            'Decisions are re-validated in code',
            'The serviceId and budget the model "chooses" are re-validated programmatically before any payment: the price cap (maxPriceMotes → PRICE_EXCEEDED) and invoice schema (parseInvoice402) are enforced by code, not the model.',
          ],
          [
            'Spending is bounded regardless',
            'Even a fully hijacked agent cannot pay above its configured cap, on the wrong network, or to a malformed paymentTarget — those guards live in the deterministic pay path described above.',
          ],
        ]}
      />
      <Callout tone="info" title="Trust boundary, not trust the model">
        The model is treated as fallible: it helps choose <em>which</em> service to call, but the
        ceiling on <em>how much</em> it can spend, <em>where</em> the money goes, and <em>which
        chain</em> it pays on are enforced by the deterministic checks in{' '}
        <DocLink href="/docs/buyers">the buyer client</DocLink>, not by the prompt.
      </Callout>

      <H2 id="checklist">Before you go live</H2>
      <P>A condensed pre-flight for a live deployment:</P>
      <CommandBlock
        prompt={null}
        text={
          '# loadConfig() / createApp() enforce these — boot will fail otherwise:\n' +
          'AGENTGATE_MODE=live\n' +
          'CSPR_CLOUD_API_KEY=<your key>           # required in live\n' +
          'AGENTGATE_ADMIN_TOKEN=<strong-unique>   # never dev-admin-token\n' +
          'GATE_SIGNER_PEM_PATH=/secrets/gate.pem  # attestor key, locked-down perms\n' +
          'TRUST_PROXY=1                           # == real proxy hop count, not higher'
        }
      />
      <P>
        Then put TLS in front of the gateway, keep the PEM keys off the repo and on a restricted path,
        and confirm your upstream hostnames resolve to public addresses (the live-mode SSRF re-check
        rejects anything that resolves private). See{' '}
        <DocLink href="/docs/deployment">Deploy to production</DocLink> for the full procedure.
      </P>

      <NextLinks
        links={[
          { href: '/docs/configuration', label: 'Configuration' },
          { href: '/docs/deployment', label: 'Deploy to production' },
        ]}
      />
    </>
  );
}
