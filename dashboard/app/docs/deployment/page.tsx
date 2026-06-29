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
  StepFlow,
} from '@/components/docs';
import { CommandBlock } from '@/components/copy';

export const metadata: Metadata = {
  title: 'Deploy to production',
  description:
    'Deploy the AgentGate 402 gateway: what to host, the hosting docker-compose stack, Railway + Vercel, the live-mode checklist enforced by loadConfig(), health/readiness probes, and built-in hardening.',
};

export default function DeploymentPage() {
  return (
    <>
      <DocHeader
        kicker="docs / deployment"
        title="Deploy to production"
        lede="The only public service that matters is the middleware gateway — a stateless 402 paywall reverse proxy. This guide covers what to host, the hosting compose stack, Railway/Vercel, the live-mode checklist that loadConfig() refuses to start without, health probes, and the hardening that ships in the box."
      />

      <H2 id="what-to-deploy">What to deploy</H2>
      <P>
        AgentGate is a monorepo, but a production deployment exposes one process: the{' '}
        <strong className="text-white">middleware gateway</strong>. Everything else is either an
        example, a build-time tool, or a separately hosted UI.
      </P>
      <DocTable
        head={['Component', 'Role', 'Deploy?']}
        rows={[
          [
            <M key="c">packages/middleware</M>,
            <span key="r">
              The 402 paywall reverse proxy + admin API. The public service. Stateless apart from a
              small upstream-map JSON file (<M>serviceId → upstream URL</M>).
            </span>,
            <strong key="d" className="text-white">
              Yes — this is the product.
            </strong>,
          ],
          [
            <M key="c">packages/oracle</M>,
            <span key="r">
              The demo &ldquo;sellable API&rdquo; (an RWA FX &amp; gold feed). It is an example
              upstream, not part of the gateway — your real upstream is whatever HTTP API you put
              behind a service.
            </span>,
            'Optional — only to run the demo.',
          ],
          [
            <M key="c">packages/devnet</M>,
            <span key="r">
              An <strong className="text-white">in-memory MOCK Casper chain</strong>. It exists so
              the whole stack runs offline in <M>AGENTGATE_MODE=mock</M>.
            </span>,
            <strong key="d" className="text-warn">
              Never in live mode. Never expose it.
            </strong>,
          ],
          [
            <span key="c">
              <M>dashboard</M> (Next.js)
            </span>,
            <span key="r">
              The read-only UI (catalog, trust scores, docs). It talks to chain/gateway through its
              own server routes; it is not on the payment path.
            </span>,
            'Vercel / any Next.js host.',
          ],
          [
            <span key="c">
              <M>cli</M>, <M>buyer-agent</M>, <M>client</M>, <M>shared</M>, <M>chain</M>
            </span>,
            'Operator tools and libraries — run locally or import as packages.',
            'No standalone deploy.',
          ],
        ]}
      />
      <Callout tone="warn" title="devnet is a mock chain">
        The <M>packages/devnet</M> image is for the self-contained demo only (see{' '}
        <M>docker-compose.hosting.yml</M> and its Dockerfile comment: &ldquo;a live deployment never
        runs this image&rdquo;). In <M>live</M> mode the gateway talks to Casper Testnet via{' '}
        <M>CASPER_NODE_URL</M> + CSPR.cloud — there is no devnet to point at, and exposing one would
        be a mock chain serving real-looking data.
      </Callout>

      <H2 id="docker">Docker &amp; docker-compose</H2>
      <P>
        Each service ships a workspace-aware Dockerfile built from the repo root (the build context
        is <M>.</M>, so the monorepo lockfile and manifests are available for a cached{' '}
        <M>npm ci</M>). The stack runs TypeScript directly via <M>tsx</M>, so the images
        deliberately keep dev dependencies; all run as the non-root <M>node</M> user with{' '}
        <M>NODE_ENV=production</M> and a built-in <M>HEALTHCHECK</M> that hits <M>/healthz</M>.
      </P>

      <H3 id="hosting-compose">The hosting compose stack (mock)</H3>
      <P>
        <M>docker-compose.hosting.yml</M> brings up a self-contained demo — <M>devnet</M> +{' '}
        <M>oracle</M> + <M>middleware</M>, all in <M>AGENTGATE_MODE=mock</M>, built from the
        production Dockerfiles. The dashboard is intentionally not containerized; run it locally or
        on Vercel pointed at these ports. Host ports are in the <M>1xxxx</M> range so they never
        collide with a local dev stack on <M>4030/4010/4021</M>.
      </P>
      <CommandBlock text="docker compose -f docker-compose.hosting.yml up -d --build" />
      <DocTable
        head={['Service', 'Host port', 'Container port', 'Health']}
        rows={[
          [
            <M key="s">middleware</M>,
            <M key="h">14021</M>,
            <M key="c">4021</M>,
            <span key="x">
              <M>GET /healthz</M> — the 402 gateway.
            </span>,
          ],
          [
            <M key="s">oracle</M>,
            <M key="h">14010</M>,
            <M key="c">4010</M>,
            <span key="x">
              <M>GET /healthz</M> — RWA feed (runs with <M>ORACLE_STATIC=1</M>, deterministic /
              offline).
            </span>,
          ],
          [
            <M key="s">devnet</M>,
            <M key="h">14030</M>,
            <M key="c">4030</M>,
            <span key="x">
              <M>GET /healthz</M> — mock chain.
            </span>,
          ],
        ]}
      />
      <P>Verify each service once the stack is healthy:</P>
      <CommandBlock
        prompt={null}
        wrap
        text={
          'curl http://localhost:14021/healthz   # middleware (402 gateway)\n' +
          'curl http://localhost:14010/healthz   # oracle     (RWA feed)\n' +
          'curl http://localhost:14030/healthz   # devnet     (mock chain)'
        }
      />
      <P>Point the dashboard at the stack, or tear it down (the second form also wipes state):</P>
      <CommandBlock
        prompt={null}
        wrap
        text={
          'AGENTGATE_MODE=mock DEVNET_URL=http://localhost:14030 npm run dev:dashboard\n' +
          'docker compose -f docker-compose.hosting.yml down -v'
        }
      />
      <P>
        Two production details to note. The middleware service depends on <M>devnet</M> being{' '}
        <M>service_healthy</M> before it starts and reaches it container-to-container at{' '}
        <M>http://devnet:4030</M> (a service name, not <M>localhost</M>). Its upstream map is
        persisted to a named volume mounted at{' '}
        <M>/app/packages/middleware/data</M>, so <M>serviceId → upstream</M> mappings survive
        restarts. The compose file sets <M>AGENTGATE_ADMIN_TOKEN=dev-admin-token</M> — fine for a
        mock demo, but override it for anything reachable from the internet.
      </P>

      <H3 id="single-image">Building a single image</H3>
      <P>
        To host the gateway by itself, build only its Dockerfile from the repo root. The image
        EXPOSEs <M>4021</M>; the entrypoint maps the platform-injected <M>PORT</M> onto the
        config&apos;s <M>MIDDLEWARE_PORT</M> (<M>MIDDLEWARE_PORT=${'{'}PORT:-4021{'}'}</M>) and runs{' '}
        <M>tsx</M> as PID 1 so it receives <M>SIGTERM</M> for a clean drain.
      </P>
      <CommandBlock
        wrap
        text="docker build -f packages/middleware/Dockerfile -t agentgate-middleware ."
      />
      <Callout tone="info" title="pin the base image for production">
        The Dockerfiles use <M>FROM node:22-alpine</M> and note in a comment: &ldquo;For production,
        pin to a digest: <M>FROM node:22-alpine@sha256:&lt;digest&gt;</M>&rdquo;. Pin it before you
        ship.
      </Callout>

      <H2 id="railway-vercel">Railway &amp; Vercel</H2>
      <H3 id="railway">Railway (gateway + oracle)</H3>
      <P>
        Both <M>packages/middleware</M> and <M>packages/oracle</M> ship a <M>railway.json</M>. Each
        uses the <M>DOCKERFILE</M> builder pointed at its own Dockerfile, declares{' '}
        <M>healthcheckPath: /healthz</M> with a <M>120</M>-second timeout, and restarts{' '}
        <M>ON_FAILURE</M> up to <M>10</M> times. Railway injects <M>PORT</M>, which the Dockerfile
        entrypoints translate to <M>MIDDLEWARE_PORT</M> / <M>ORACLE_PORT</M> automatically.
      </P>
      <Callout tone="warn" title="set TRUST_PROXY=1 behind Railway">
        Railway terminates TLS and forwards to your container through a single proxy hop, so set{' '}
        <M>TRUST_PROXY=1</M>. That makes Express trust exactly one <M>X-Forwarded-For</M> hop, so
        rate limiting keys off the real client IP. Never set it higher than the real hop count or{' '}
        <M>X-Forwarded-For</M> becomes spoofable.
      </Callout>

      <H3 id="vercel">Vercel (dashboard only)</H3>
      <P>
        <M>vercel.json</M> deploys the Next.js dashboard from the monorepo:{' '}
        <M>framework: nextjs</M>, <M>installCommand: npm install</M>,{' '}
        <M>buildCommand: npm run build -w dashboard</M>, output at <M>dashboard/.next</M>. Deploy the
        gateway elsewhere (Railway/Docker) — Vercel hosts only the UI, which reads through its own
        server routes and is never on the payment path.
      </P>

      <H2 id="live-checklist">Live-mode checklist</H2>
      <P>
        In <M>AGENTGATE_MODE=live</M> two layers enforce safe configuration. First,{' '}
        <M>loadConfig()</M> in <M>@agentgate/shared</M> refuses to return a config for an unsafe
        environment. Second, <M>createApp()</M> in the middleware adds a fail-closed signer check.
        If any required value is missing the process throws <M>CONFIG_INVALID</M> (HTTP 500) on boot
        — it does not start degraded.
      </P>
      <DocTable
        head={['Set in live mode', 'Why / enforcement']}
        rows={[
          [
            <M key="v">AGENTGATE_MODE=live</M>,
            'Selects the Casper Testnet backend (node RPC + CSPR.cloud) instead of the in-memory devnet.',
          ],
          [
            <M key="v">CSPR_CLOUD_API_KEY</M>,
            <span key="d">
              <strong className="text-white">Required.</strong> <M>loadConfig()</M> throws &ldquo;live
              mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)&rdquo; when empty.
              Used to verify on-chain transfers.
            </span>,
          ],
          [
            <M key="v">AGENTGATE_ADMIN_TOKEN</M>,
            <span key="d">
              A <strong className="text-white">strong, unique</strong> token. <M>loadConfig()</M>{' '}
              throws &ldquo;live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique
              token&rdquo; if it is still <M>dev-admin-token</M>. Compared in constant time on{' '}
              <M>/admin</M>.
            </span>,
          ],
          [
            <M key="v">GATE_SIGNER_PEM_PATH</M>,
            <span key="d">
              <strong className="text-white">Required by the middleware.</strong>{' '}
              <M>createApp()</M> throws &ldquo;live mode requires GATE_SIGNER_PEM_PATH … refusing the
              mock-signer fallback&rdquo; when empty — this is the attestor key that signs on-chain
              attestations.
            </span>,
          ],
          [
            <M key="v">REGISTRY_CONTRACT_PACKAGE_HASH</M>,
            <span key="d">
              The deployed registry&apos;s <M>hash-&lt;64hex&gt;</M>. Empty is accepted by{' '}
              <M>loadConfig()</M> but every registry read/write then fails — see{' '}
              <DocLink href="/docs/contract#deploy-status">Contract → Deploy status</DocLink>.
            </span>,
          ],
          [
            <M key="v">TRUST_PROXY=1</M>,
            <span key="d">
              Set to the real reverse-proxy hop count (1 behind a single Railway/Vercel proxy) so
              rate limiting keys off the true client IP. Validated to <M>0–10</M>.
            </span>,
          ],
          [
            'HTTPS in front of the gateway',
            'Terminate TLS at the platform/proxy. The admin token and payment proofs travel in headers; never serve them over plain HTTP.',
          ],
        ]}
      />
      <P>
        The Casper endpoints have working Testnet defaults you usually keep:{' '}
        <M>CASPER_NODE_URL</M>, <M>CSPR_CLOUD_API_URL</M>, <M>CSPR_CLOUD_STREAMING_URL</M>,{' '}
        <M>CASPER_NETWORK=casper-test</M>. The full variable reference, including types, defaults and
        validation rules, is in <DocLink href="/docs/configuration">Configuration</DocLink>.
      </P>
      <Callout tone="info" title="how the guardrails read in code">
        <M>loadConfig()</M> validates the environment once and throws{' '}
        <M>AgentGateError(&apos;CONFIG_INVALID&apos;, …, 500)</M> on an unknown mode, a missing
        CSPR.cloud key in live mode, or the default admin token in live mode. The signer guard lives
        in <M>createApp()</M>. There is no &ldquo;run anyway&rdquo; flag — fix the env and restart.
      </Callout>

      <H2 id="health">Health and readiness</H2>
      <P>
        The gateway exposes two distinct probes. Wire <M>/healthz</M> to your container/PaaS
        liveness check and <M>/readyz</M> to a load balancer&apos;s routing check.
      </P>
      <DocTable
        head={['Endpoint', 'Checks', 'Response']}
        rows={[
          [
            <M key="e">GET /healthz</M>,
            'Liveness — the process is up. Cheap, dependency-free; never touches the chain.',
            <span key="r">
              <M>200</M> <M>{'{ ok: true, network }'}</M>. Used by the Docker <M>HEALTHCHECK</M> and{' '}
              <M>railway.json</M>.
            </span>,
          ],
          [
            <M key="e">GET /readyz</M>,
            <span key="c">
              Readiness — calls <M>chain.ping()</M> to confirm the backing chain is reachable.
            </span>,
            <span key="r">
              <M>200</M> <M>{'{ ready: true, network }'}</M> when reachable;{' '}
              <strong className="text-white">503</strong> <M>{'{ ready: false }'}</M> when the chain
              is down, so a load balancer stops routing to a gateway that can&apos;t serve.
            </span>,
          ],
        ]}
      />
      <CodeBlock
        label="healthy gateway"
        code={
          'GET /healthz  →  200  {"ok":true,"network":"casper-test"}\n' +
          'GET /readyz   →  200  {"ready":true,"network":"casper-test"}\n' +
          '\n' +
          '# chain unreachable\n' +
          'GET /readyz   →  503  {"ready":false}'
        }
      />
      <Callout tone="info" title="probe choice matters">
        Use <M>/healthz</M> for liveness (restarting on a 503 from <M>/readyz</M> would loop while
        Casper is briefly unreachable). Use <M>/readyz</M> for the load balancer so traffic drains
        away from an instance that can&apos;t reach the chain, instead of returning errors to buyers.
      </Callout>

      <H2 id="hardening">Hardening already built in</H2>
      <P>
        The gateway ships with production defenses on by default — you mostly just need to set{' '}
        <M>TRUST_PROXY</M> correctly and front it with HTTPS. The full threat model is in{' '}
        <DocLink href="/docs/security">the Security model</DocLink>; in brief:
      </P>
      <StepFlow
        steps={[
          {
            title: 'Rate limiting',
            body: (
              <>
                Per-IP limits via <M>express-rate-limit</M>: 60 req/min on <M>/svc</M> and a stricter
                20 req/min on <M>/admin</M> to blunt admin-token brute force (draft-7 standard
                headers). Keying is correct only when <M>TRUST_PROXY</M> matches your hop count.
              </>
            ),
          },
          {
            title: 'SSRF guard',
            body: (
              <>
                Upstream URLs are validated on registration and, in live mode, re-resolved at request
                time before any payment — private/loopback/link-local hosts are rejected, defeating
                DNS rebinding. Live mode also disables redirect-following on the upstream call.
              </>
            ),
          },
          {
            title: 'Fail-closed signer',
            body: (
              <>
                Live mode refuses to start without <M>GATE_SIGNER_PEM_PATH</M> rather than falling
                back to the mock signer (which carries no key material). No silent degradation.
              </>
            ),
          },
          {
            title: 'Process safety net',
            body: (
              <>
                <M>SIGTERM</M>/<M>SIGINT</M> drain in-flight requests (up to 5s), flush the upstream
                map, then exit. An <M>uncaughtException</M> logs and exits non-zero so the
                orchestrator restarts a process left in an undefined state.
              </>
            ),
          },
        ]}
      />
      <P>
        Additional defaults: <M>helmet</M> security headers, <M>x-powered-by</M> disabled, a 256&nbsp;KB
        JSON body limit, single-use nonces (burned before proxying), constant-time admin-token
        comparison, and structured logs that never include upstream URLs or tokens. CORS is
        intentionally off — the gateway is a server-to-server API for agents.
      </P>

      <H2 id="deferred">What is deferred</H2>
      <Callout tone="info" title="Registry contract is live on Casper Testnet">
        AgentGateRegistry is deployed and running on Casper Testnet (network{' '}
        <M>casper-test</M>, Casper 2.0). Package hash:{' '}
        <M>hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9</M>. Set this as{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> in <M>.env</M> to enable live contract reads and
        writes. Real transaction links are in the repo README under &ldquo;Deployed addresses
        (Casper Testnet)&rdquo;.
      </Callout>
      <DocTable
        head={['Item', 'Status']}
        rows={[
          [
            'Registry contract deploy',
            <span key="s">
              <strong className="text-white">Live on Casper Testnet.</strong> Package hash:{' '}
              <M>hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9</M>. Set
              this as <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> in <M>.env</M>. Transaction links are in
              the repo README under &ldquo;Deployed addresses (Casper Testnet)&rdquo;.
            </span>,
          ],
          [
            'Contract wasm',
            <span key="s">
              A prebuilt <M>AgentGateRegistry.wasm</M> is checked in, but it should be rebuilt at
              deploy time with the pinned toolchain (<M>cargo-odra</M> + nightly{' '}
              <M>nightly-2026-01-01</M> + <M>wasm32</M>) so the installed bytecode is reproducible.
            </span>,
          ],
          [
            <M key="i">SPENDGUARD_CONTRACT_PACKAGE_HASH</M>,
            <span key="s">
              Reserved and currently <strong className="text-white">unused</strong>. No code reads it
              (it is deliberately absent from <M>.env.example</M> and <M>loadConfig()</M>); it is held
              for planned SpendGuard wiring. Not a required live-mode setting today.
            </span>,
          ],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/security', label: 'Security model' },
          { href: '/docs/configuration', label: 'Configuration' },
        ]}
      />
    </>
  );
}
