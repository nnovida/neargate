import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import {
  AgentGateError,
  createLogger,
  decodeXPayment,
  encodeXPaymentResponse,
  randomNonce,
  trustTier,
  X402_ASSET_CSPR,
  X402_SCHEME,
  X402_VERSION,
  type AgentGateConfig,
  type AnySigner,
  type ChainClient,
  type Logger,
  type PaymentRequiredResponse,
  type PaymentRequirements,
  type ServiceRecord,
} from '@agentgate/shared';
import { MemoryInvoiceStore, type InvoiceStore } from './invoice-store';
import { UpstreamStore } from './upstream-store';
import { ServiceCache } from './service-cache';
import { isUpstreamSuccess, proxyToUpstream } from './proxy';
import { resolvedHostIsPublic, validateUpstreamUrl } from './ssrf';
import {
  HEADER_X_PAYMENT,
  HEADER_X_PAYMENT_RESPONSE,
  type PaywallErrorCode,
} from './types';

export interface MiddlewareDeps {
  config: AgentGateConfig;
  chain: ChainClient;
  logger?: Logger;
  /**
   * Path of the upstream-map JSON file. Relative paths resolve against cwd.
   * Default: `data/upstreams.json` under the middleware package directory.
   */
  upstreamsFile?: string;
  /** Custom invoice store (default: in-memory + TTL sweep). Injected stores are not closed on dispose. */
  invoiceStore?: InvoiceStore;
  /** Delay before the single attestation retry. Default 5000 ms. */
  attestationRetryDelayMs?: number;
}

/** Internal handles startServer() uses for graceful shutdown. */
export interface AppInternals {
  dispose(): Promise<void>;
}

const DEFAULT_ATTESTATION_RETRY_DELAY_MS = 5_000;
const JSON_BODY_LIMIT = '256kb';
const SVC_RATE_LIMIT_PER_MINUTE = 60;
const ADMIN_RATE_LIMIT_PER_MINUTE = 20;
const SERVICE_ID_RE = /^\d{1,15}$/;

/**
 * True when the request carries a body the gateway cannot faithfully forward.
 * We only relay JSON bodies (express.json parsed them); a non-JSON body would be
 * silently dropped, so we reject it BEFORE charging rather than bill the buyer
 * for an upstream call that receives an empty body.
 */
function hasUnsupportedRequestBody(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const contentLength = req.header('content-length');
  const hasBody =
    (contentLength !== undefined && contentLength !== '0') ||
    req.header('transfer-encoding') !== undefined;
  if (!hasBody) return false;
  return !req.is('application/json');
}

function defaultUpstreamsFile(): string {
  // <package>/src/app.ts → <package>/data/upstreams.json
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(packageDir, 'data', 'upstreams.json');
}

function parseServiceId(raw: string | undefined): number | null {
  if (raw === undefined || !SERVICE_ID_RE.test(raw)) return null;
  return Number(raw);
}

/** Constant-time string comparison (hash first so lengths never short-circuit). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Express 4 does not catch async handler rejections — wrap them. */
function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Builds the 402 paywall reverse proxy + admin API (SPEC §5).
 * Pure factory — no listen(); startServer() wires it to a port.
 */
export function createApp(deps: MiddlewareDeps): Express {
  if (!deps || !deps.config || !deps.chain) {
    throw new AgentGateError('BAD_DEPS', 'createApp requires { config, chain }', 500);
  }
  const { config, chain } = deps;
  // Fail closed: live mode must use a real attestor key, never the mock-signer
  // fallback (which would record attestations with no key material).
  if (config.mode === 'live' && config.gateSignerPemPath.trim() === '') {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'live mode requires GATE_SIGNER_PEM_PATH (the attestor signing key) — refusing the mock-signer fallback',
      500,
    );
  }
  const logger = deps.logger ?? createLogger('middleware');
  const invoices = deps.invoiceStore ?? new MemoryInvoiceStore();
  const ownsInvoiceStore = deps.invoiceStore === undefined;
  const upstreams = new UpstreamStore(
    deps.upstreamsFile !== undefined
      ? path.resolve(process.cwd(), deps.upstreamsFile)
      : defaultUpstreamsFile(),
    logger,
  );
  // Boot-time load (throws on corrupt file); re-apply the SSRF guard so a
  // persisted mapping to a now-forbidden host is dropped, not trusted.
  upstreams.loadSync(
    (url) => validateUpstreamUrl(url, { rejectPrivateHosts: config.mode === 'live' }).ok,
  );
  const services = new ServiceCache(chain);
  const attestationRetryDelayMs = deps.attestationRetryDelayMs ?? DEFAULT_ATTESTATION_RETRY_DELAY_MS;

  const app = express();
  app.disable('x-powered-by');
  // Number of trusted reverse-proxy hops, so req.ip (and thus rate-limit keying)
  // reflects the real client behind Railway/Vercel. Default 0 (trust none); set
  // TRUST_PROXY to the real hop count in production. Never blindly trust all
  // hops, which would make X-Forwarded-For spoofable.
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  // CORS is intentionally OFF: the gateway is a server-to-server API for agents,
  // not called directly from browsers (the dashboard reads via its own server
  // routes). Add an explicit allowlist here only if a browser client is needed.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Structured request logs (no upstream URLs, no tokens — path + outcome only).
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    next();
  });

  // ---------------------------------------------------------------- helpers

  /** Gate/attestor signer: PEM key in live mode, mock identity otherwise. */
  function gateSignerFor(service: ServiceRecord): AnySigner {
    if (config.mode === 'live' && config.gateSignerPemPath !== '') {
      return { kind: 'pem', pemPath: config.gateSignerPemPath };
    }
    // Mock mode: the devnet authorizes by public key string; act as the
    // service's registered attestor (mock signers carry no key material).
    return { kind: 'mock', publicKey: service.attestor };
  }

  function buildRequirements(
    service: ServiceRecord, nonce: string, expiresAt: number, resource: string,
  ): PaymentRequirements {
    return {
      scheme: X402_SCHEME,
      network: chain.network,
      maxAmountRequired: service.priceMotes,
      asset: X402_ASSET_CSPR,
      payTo: service.paymentTarget,
      resource,
      description: service.name,
      maxTimeoutSeconds: Math.floor(config.invoiceTtlMs / 1000),
      extra: {
        nonce,
        serviceId: service.id,
        expiresAtMs: expiresAt,
        settlement: 'casper-native-transfer',
        transferIdEncoding: 'u64-decimal',
      },
    };
  }

  function send402(
    res: Response, error: string, requirements: PaymentRequirements, retryAfterSeconds?: number,
  ): void {
    if (retryAfterSeconds !== undefined) res.set('Retry-After', String(retryAfterSeconds));
    const body: PaymentRequiredResponse = { x402Version: X402_VERSION, error, accepts: [requirements] };
    res.status(402).json(body);
  }

  /** Issues + persists a fresh invoice, then responds 402. */
  async function respond402Fresh(
    res: Response, service: ServiceRecord, resource: string, error: string,
  ): Promise<void> {
    const nonce = randomNonce();
    const expiresAt = Date.now() + config.invoiceTtlMs;
    await invoices.put({ nonce, serviceId: service.id, priceMotes: service.priceMotes, expiresAt, used: false });
    send402(res, error, buildRequirements(service, nonce, expiresAt, resource));
  }

  /**
   * Fire-and-forget on-chain attestation (success := upstream 2xx).
   * Never blocks the buyer's response; on failure logs and retries exactly
   * once after `attestationRetryDelayMs` (timer unref'd).
   */
  function scheduleAttestation(
    service: ServiceRecord,
    paymentDeployHash: string,
    success: boolean,
  ): void {
    const input = { serviceId: service.id, paymentDeployHash, success };
    const signer = gateSignerFor(service);
    const fields = { serviceId: service.id, paymentDeployHash, success };
    chain.recordAttestation(input, signer).then(
      (r) => logger.info('attestation_recorded', { ...fields, txHash: r.txHash }),
      (err: unknown) => {
        logger.warn('attestation_failed_retrying', {
          ...fields,
          retryInMs: attestationRetryDelayMs,
          error: err instanceof Error ? err.message : String(err),
        });
        const timer = setTimeout(() => {
          chain.recordAttestation(input, signer).then(
            (r) => logger.info('attestation_recorded_on_retry', { ...fields, txHash: r.txHash }),
            (err2: unknown) =>
              logger.error('attestation_failed_final', {
                ...fields,
                error: err2 instanceof Error ? err2.message : String(err2),
              }),
          );
        }, attestationRetryDelayMs);
        timer.unref();
      },
    );
  }

  // ------------------------------------------------------------- rate limit

  app.use(
    '/svc',
    rateLimit({
      windowMs: 60_000,
      limit: SVC_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // Stricter limit on the admin API to blunt admin-token brute force.
  app.use(
    '/admin',
    rateLimit({
      windowMs: 60_000,
      limit: ADMIN_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // ------------------------------------------------------- public endpoints

  // Liveness: the process is up. Cheap and dependency-free (for Docker/Railway).
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, network: chain.network });
  });

  // Readiness: the backing chain is reachable (bounded). Returns 503 when not,
  // so a load balancer can stop routing traffic to a gateway that can't serve.
  app.get(
    '/readyz',
    wrap(async (_req, res) => {
      try {
        if (chain.ping) await chain.ping();
        res.json({ ready: true, network: chain.network });
      } catch {
        res.status(503).json({ ready: false });
      }
    }),
  );

  // Public, unpaid metadata: service record + score + trust tier.
  app.get(
    '/svc/:id/meta',
    wrap(async (req, res) => {
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      const service = await services.get(id);
      if (!service) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      const score = await chain.getScore(id);
      res.json({ service, score, trustTier: trustTier(score) });
    }),
  );

  // ---------------------------------------------------------------- paywall

  app.all(
    '/svc/:id',
    wrap(async (req, res) => {
      // 1. Resolve the service (60s cache).
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      const service = await services.get(id);
      if (!service) {
        res.status(404).json({ error: 'service_not_found' });
        return;
      }
      if (!service.active) {
        res.status(403).json({ error: 'service_inactive' });
        return;
      }
      const upstreamUrl = upstreams.get(id);
      if (upstreamUrl === undefined) {
        // Registered on-chain but not mapped on this gateway — cannot serve,
        // and we must not charge for something we cannot deliver.
        res.status(503).json({ error: 'service_unavailable' });
        return;
      }

      // 1b. Reject a body we cannot forward BEFORE issuing/charging an invoice,
      //     so the buyer is never billed for a request the upstream can't receive.
      if (hasUnsupportedRequestBody(req)) {
        res.status(415).json({ error: 'unsupported_media_type' });
        return;
      }

      // 1c. Live-mode SSRF re-check at request time (defeats DNS rebinding of a
      //     host that was public at registration). Refuse before any payment.
      if (config.mode === 'live') {
        let host = '';
        try {
          host = new URL(upstreamUrl).hostname;
        } catch {
          host = '';
        }
        if (!(await resolvedHostIsPublic(host))) {
          logger.warn('upstream_host_forbidden', { serviceId: id });
          res.status(503).json({ error: 'service_unavailable' });
          return;
        }
      }

      const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;

      // 2. No payment proof → fresh 402 challenge.
      const xPayment = req.header(HEADER_X_PAYMENT)?.trim() ?? '';
      if (xPayment === '') {
        await respond402Fresh(res, service, resource, 'X-PAYMENT header is required');
        return;
      }

      // 2b. Decode the proof (malformed → re-challenge, never 5xx).
      let payment;
      try {
        payment = decodeXPayment(xPayment);
      } catch {
        await respond402Fresh(res, service, resource, 'invalid_payment_header');
        return;
      }
      if (payment.network !== chain.network) {
        await respond402Fresh(res, service, resource, 'wrong_target');
        return;
      }
      const deployHashHeader = payment.payload.transaction;
      const nonceHeader = payment.payload.transferId;

      // 3. Validate the invoice behind the presented nonce.
      const invoice = await invoices.get(nonceHeader);
      if (!invoice || invoice.serviceId !== id) { await respond402Fresh(res, service, resource, 'unknown_nonce'); return; }
      if (invoice.used) { await respond402Fresh(res, service, resource, 'invoice_used'); return; }
      if (Date.now() > invoice.expiresAt) { await respond402Fresh(res, service, resource, 'invoice_expired'); return; }

      // 3b. Verify the on-chain transfer.
      const verdict = await chain.verifyTransfer({
        deployHash: deployHashHeader,
        expectedTarget: service.paymentTarget,
        minAmountMotes: service.priceMotes,
        expectedTransferId: nonceHeader,
        maxAgeMs: config.invoiceTtlMs,
      });
      if (!verdict.ok) {
        if (verdict.reason === 'pending') {
          // Still settling: keep the SAME invoice alive so the buyer can
          // retry the identical proof after Retry-After seconds.
          send402(res, 'settlement_pending', buildRequirements(service, nonceHeader, invoice.expiresAt, resource), 2);
          return;
        }
        await respond402Fresh(res, service, resource, verdict.reason);
        return;
      }

      // 3c. Burn the nonce BEFORE proxying — single-use even if the upstream
      // fails, and exactly one concurrent request can win the race.
      const consumed = await invoices.markUsed(nonceHeader);
      if (!consumed) {
        await respond402Fresh(res, service, resource, 'invoice_used');
        return;
      }

      // 4. Proxy to the upstream (status/content-type passthrough; the
      //    upstream URL never appears in any response).
      const outcome = await proxyToUpstream({
        upstreamUrl,
        req,
        timeoutMs: config.upstreamTimeoutMs,
        followRedirects: config.mode !== 'live',
      });
      const success = isUpstreamSuccess(outcome);

      // 5. Respond to the buyer first, then attest asynchronously.
      // Always set the settlement confirmation header (payment was processed).
      res.set(
        HEADER_X_PAYMENT_RESPONSE,
        encodeXPaymentResponse({
          success: true,
          transaction: deployHashHeader,
          network: chain.network,
          payer: verdict.from,
        }),
      );
      if (outcome.kind === 'response') {
        res.status(outcome.status);
        if (outcome.contentType) res.set('Content-Type', outcome.contentType);
        res.send(outcome.body);
      } else {
        logger.warn('proxy_failed', { serviceId: id, error: outcome.error });
        res.status(outcome.status).json({ error: outcome.error });
      }
      scheduleAttestation(service, deployHashHeader, success);
    }),
  );

  // -------------------------------------------------------------- admin API

  const adminAuth: RequestHandler = (req, res, next) => {
    const header = req.header('authorization') ?? '';
    if (!safeEqual(header, `Bearer ${config.adminToken}`)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.post(
    '/admin/services',
    adminAuth,
    wrap(async (req, res) => {
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object') {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const { serviceId, upstreamUrl } = body as { serviceId?: unknown; upstreamUrl?: unknown };
      if (typeof serviceId !== 'number' || !Number.isSafeInteger(serviceId) || serviceId < 0) {
        res.status(400).json({ error: 'invalid_service_id' });
        return;
      }
      const verdict = validateUpstreamUrl(upstreamUrl, {
        rejectPrivateHosts: config.mode === 'live', // SSRF guard (live only; mock allows localhost demos)
      });
      if (!verdict.ok) {
        res.status(400).json({ error: verdict.error });
        return;
      }
      await upstreams.set(serviceId, verdict.url.toString());
      logger.info('upstream_mapped', { serviceId });
      res.status(204).end();
    }),
  );

  app.get('/admin/services', adminAuth, (_req, res) => {
    res.json(upstreams.list());
  });

  app.delete(
    '/admin/services/:id',
    adminAuth,
    wrap(async (req, res) => {
      const id = parseServiceId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'invalid_service_id' });
        return;
      }
      await upstreams.delete(id);
      logger.info('upstream_unmapped', { serviceId: id });
      res.status(204).end();
    }),
  );

  // ------------------------------------------------------ fallbacks & errors

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Final error handler: structured, generic, never leaks internals/upstreams.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const httpError = err as { type?: string; status?: number };
    if (httpError.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (httpError.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (err instanceof AgentGateError) {
      logger.error('request_failed', { code: err.code, message: err.message });
      res.status(err.httpStatus).json({ error: err.code.toLowerCase() });
      return;
    }
    logger.error('request_failed', {
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    res.status(500).json({ error: 'internal_error' });
  });

  // Handles for startServer()'s graceful shutdown.
  const internals: AppInternals = {
    async dispose(): Promise<void> {
      if (ownsInvoiceStore) invoices.close();
      await upstreams.flush();
    },
  };
  app.locals['agentgate'] = internals;

  return app;
}
