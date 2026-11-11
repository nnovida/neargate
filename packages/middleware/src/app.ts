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
  addYocto,
  AgentGateError,
  caip2For,
  chainErrorCode,
  createLogger,
  decodeXPayment,
  encodeXPaymentResponse,
  isNearTxHash,
  isValidNonce,
  PAYMENT_STORAGE_FEE_YOCTO,
  randomNonce,
  trustTier,
  X402_ASSET_NEAR,
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
import { FileInvoiceStore } from './invoice-store-file';
import { MemoryAttestationQueue, type AttestationQueue } from './attestation-queue';
import { FileAttestationQueue } from './attestation-queue-file';
import { UpstreamStore } from './upstream-store';
import { ServiceCache } from './service-cache';
import { isUpstreamSuccess, proxyToUpstream } from './proxy';
import { ReceiptStore } from './receipts';
import { createSelfMapHandler } from './self-map';
import { parseServiceId } from './service-id';
import { resolvedHostIsPublic, validateUpstreamUrl } from './ssrf';
import {
  HEADER_X_PAYMENT,
  HEADER_X_PAYMENT_RESPONSE,
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
  /**
   * When set (and no `invoiceStore` is injected), persist invoices to this JSON
   * file so they survive a restart (finding F2). The gateway owns and closes it.
   */
  invoiceStorePath?: string;
  /** Custom attestation queue (default: in-memory). Injected queues are not closed on dispose. */
  attestationQueue?: AttestationQueue;
  /**
   * When set (and no `attestationQueue` is injected), persist pending attestations
   * to this JSON file so a served+paid call whose on-chain attestation never
   * confirmed is replayed after a restart instead of being under-counted (F7).
   */
  attestationQueuePath?: string;
  /** Base delay before the first attestation retry (exponential backoff). Default 5000 ms. */
  attestationRetryDelayMs?: number;
  /** Total attestation attempts before giving up (1 = no retry). Default 4. */
  attestationMaxAttempts?: number;
}

/** Internal handles startServer() uses for graceful shutdown. */
export interface AppInternals {
  dispose(): Promise<void>;
}

const DEFAULT_ATTESTATION_RETRY_DELAY_MS = 5_000;
const DEFAULT_ATTESTATION_MAX_ATTEMPTS = 4;
const JSON_BODY_LIMIT = '256kb';
const SVC_RATE_LIMIT_PER_MINUTE = 60;
const ADMIN_RATE_LIMIT_PER_MINUTE = 20;
const SELF_MAP_RATE_LIMIT_PER_MINUTE = 20;
const RECEIPTS_RATE_LIMIT_PER_MINUTE = 60;

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

/**
 * The tx hash a TX_TIMEOUT failure names (a change call that was sent but whose outcome is
 * unknown), or undefined for any other failure. Read by duck typing: the gateway does not pull
 * the live chain client in just to recognise its error.
 */
function timedOutTxHash(err: unknown): string | undefined {
  if (!(err instanceof AgentGateError) || err.code !== 'TX_TIMEOUT') return undefined;
  const txHash = (err as { txHash?: unknown }).txHash;
  return isNearTxHash(txHash) ? txHash : undefined;
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
 * Builds the 402 paywall reverse proxy + admin API.
 * Pure factory — no listen(); startServer() wires it to a port.
 */
export function createApp(deps: MiddlewareDeps): Express {
  if (!deps || !deps.config || !deps.chain) {
    throw new AgentGateError('BAD_DEPS', 'createApp requires { config, chain }', 500);
  }
  const { config, chain } = deps;
  // Fail closed: live mode must use a real attestor account, never the
  // mock-signer fallback (which would record attestations with no key material).
  if (config.mode === 'live' && config.gatewayAccountId.trim() === '') {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'live mode requires GATEWAY_ACCOUNT_ID (the attestor account) — refusing the mock-signer fallback',
      500,
    );
  }
  const logger = deps.logger ?? createLogger('middleware');
  // Persistent when a path is configured (F2), else in-memory. Either way, a
  // store the gateway constructs itself is closed on dispose; an injected one is not.
  const invoices =
    deps.invoiceStore ??
    (deps.invoiceStorePath !== undefined && deps.invoiceStorePath.trim() !== ''
      ? new FileInvoiceStore(deps.invoiceStorePath)
      : new MemoryInvoiceStore());
  const ownsInvoiceStore = deps.invoiceStore === undefined;
  // Durable when a path is configured (F7), else in-memory. Owned queues (not
  // injected) are closed on dispose.
  const attestations =
    deps.attestationQueue ??
    (deps.attestationQueuePath !== undefined && deps.attestationQueuePath.trim() !== ''
      ? new FileAttestationQueue(deps.attestationQueuePath)
      : new MemoryAttestationQueue());
  const ownsAttestationQueue = deps.attestationQueue === undefined;
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
  const receipts = new ReceiptStore();
  const attestationRetryDelayMs = deps.attestationRetryDelayMs ?? DEFAULT_ATTESTATION_RETRY_DELAY_MS;
  const attestationMaxAttempts = deps.attestationMaxAttempts ?? DEFAULT_ATTESTATION_MAX_ATTEMPTS;

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

  /** Gateway/attestor signer: the gateway NEAR account in live mode, mock identity otherwise. */
  function gateSignerFor(service: ServiceRecord): AnySigner {
    if (config.mode === 'live') {
      return {
        kind: 'near',
        accountId: config.gatewayAccountId,
        ...(config.gatewayPrivateKey !== '' ? { secretKey: config.gatewayPrivateKey } : {}),
        ...(config.gatewayKeyPath !== '' ? { keyPath: config.gatewayKeyPath } : {}),
      };
    }
    // Mock mode: the devnet authorizes by account id; act as the service's
    // registered attestor (mock signers carry no key material).
    return { kind: 'mock', accountId: service.attestor };
  }

  /**
   * The x402 requirement for one invoice: pay `price + storage fee` through the
   * registry's `pay(service_id, nonce)`. `relayer` lands in Task 10.
   */
  function buildRequirements(
    service: ServiceRecord, nonce: string, expiresAt: number, resource: string,
  ): PaymentRequirements {
    return {
      scheme: X402_SCHEME,
      network: chain.network,
      maxAmountRequired: addYocto(service.priceYocto, PAYMENT_STORAGE_FEE_YOCTO),
      asset: X402_ASSET_NEAR,
      payTo: chain.registryId,
      resource,
      description: service.name,
      maxTimeoutSeconds: Math.floor(config.invoiceTtlMs / 1000),
      extra: {
        nonce,
        serviceId: service.id,
        expiresAtMs: expiresAt,
        settlement: 'neargate-registry-pay',
        contractId: chain.registryId,
        method: 'pay',
        priceYocto: service.priceYocto,
        storageFeeYocto: PAYMENT_STORAGE_FEE_YOCTO,
        seller: service.paymentTarget,
        caip2: caip2For(chain.network),
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
    await invoices.put({ nonce, serviceId: service.id, priceYocto: service.priceYocto, expiresAt, used: false });
    send402(res, error, buildRequirements(service, nonce, expiresAt, resource));
  }

  /**
   * Run the on-chain attestation attempt loop for one payment (success := upstream
   * 2xx). Never blocks the buyer; on failure retries with exponential backoff up
   * to `attestationMaxAttempts` total tries (timers unref'd so they never keep the
   * process alive). On success the payment is dropped from the durable queue; a
   * run whose attempts all fail leaves it queued for replay on the next boot (F7),
   * so a served+paid call is under-counted only until the next restart, never
   * over-counted. A payment the registry already attested (`ERR_ALREADY_ATTESTED`:
   * an earlier attempt landed after all, or the owner attested it) is done, not a
   * failure: it leaves the queue and is never retried.
   */
  function runAttestation(
    service: ServiceRecord,
    nonce: string,
    paymentTxHash: string,
    success: boolean,
  ): void {
    const input = { serviceId: service.id, nonce, paymentTxHash, success };
    const signer = gateSignerFor(service);
    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    // The last attempt whose outcome was unknown (TX_TIMEOUT) named a tx that may have landed.
    let timedOutTx: string | undefined;
    const attempt = (n: number): void => {
      chain.recordAttestation(input, signer).then(
        (r) => {
          logger.info(n === 1 ? 'attestation_recorded' : 'attestation_recorded_on_retry', {
            ...input,
            attempt: n,
            txHash: r.txHash,
          });
          // Confirmed on-chain — drop it from the durable queue so it is not replayed.
          void attestations.remove(nonce);
          receipts.settle(nonce, { status: 'recorded', txHash: r.txHash });
        },
        (err: unknown) => {
          if (chainErrorCode(err) === 'ERR_ALREADY_ATTESTED') {
            logger.info('attestation_already_recorded', { ...input, attempt: n });
            void attestations.remove(nonce);
            // Recorded either way. After an attempt that timed out, that tx most likely landed
            // and is what made the retry see the payment attested: name it. Otherwise another
            // party attested it and this gateway has no tx to name.
            receipts.settle(
              nonce,
              timedOutTx !== undefined ? { status: 'recorded', txHash: timedOutTx } : { status: 'recorded' },
            );
            return;
          }
          timedOutTx = timedOutTxHash(err) ?? timedOutTx;
          if (n >= attestationMaxAttempts) {
            // Leave it queued: a persistent queue replays it on the next boot; an
            // in-memory one drops it (under-count, never over-count).
            logger.error('attestation_failed_final', { ...input, attempts: n, error: msg(err) });
            receipts.settle(nonce, { status: 'failed' });
            return;
          }
          const retryInMs = attestationRetryDelayMs * 2 ** (n - 1);
          logger.warn('attestation_failed_retrying', {
            ...input,
            attempt: n,
            retryInMs,
            error: msg(err),
          });
          const timer = setTimeout(() => attempt(n + 1), retryInMs);
          timer.unref();
        },
      );
    };
    attempt(1);
  }

  /**
   * Enqueue a served+paid call for attestation (durably, when a queue path is
   * configured), then run the attempt loop. The enqueue happens before the first
   * on-chain attempt, so a crash mid-attest still leaves a replayable record.
   * Fire-and-forget — never blocks the buyer response (F7).
   */
  function scheduleAttestation(
    service: ServiceRecord,
    nonce: string,
    paymentTxHash: string,
    success: boolean,
  ): void {
    attestations
      .enqueue({ nonce, paymentTxHash, serviceId: service.id, success, enqueuedAt: Date.now() })
      .then(() => runAttestation(service, nonce, paymentTxHash, success))
      .catch((err: unknown) => {
        // Nothing was sent and nothing is queued for replay: say so, never leave the receipt pending.
        logger.error('attestation_schedule_failed', {
          serviceId: service.id,
          nonce,
          error: err instanceof Error ? err.message : String(err),
        });
        receipts.settle(nonce, { status: 'failed' });
      });
  }

  /**
   * Replay attestations persisted from a previous run that never confirmed (F7).
   * The registry attests a payment at most once (`ERR_ALREADY_ATTESTED`), so an
   * already-scored payment is dropped from the queue on its first replay.
   * Fire-and-forget on boot.
   */
  function replayPendingAttestations(): void {
    void attestations.list().then(async (pending) => {
      for (const p of pending) {
        const service = await services.get(p.serviceId).catch(() => null);
        if (service) {
          receipts.open(
            { nonce: p.nonce, serviceId: p.serviceId, paymentTxHash: p.paymentTxHash },
            { status: 'pending' },
          );
          runAttestation(service, p.nonce, p.paymentTxHash, p.success);
        } else {
          logger.warn('attestation_replay_skipped_unknown_service', {
            serviceId: p.serviceId,
            nonce: p.nonce,
          });
        }
      }
    });
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

  // Self-service mapping is unauthenticated-by-token (auth is the owner
  // signature) — rate-limit it to blunt signature-spam / mapping churn.
  app.use(
    '/services',
    rateLimit({
      windowMs: 60_000,
      limit: SELF_MAP_RATE_LIMIT_PER_MINUTE,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
  );

  // Receipts are polled while a buyer waits for its attestation; same budget as /svc.
  app.use(
    '/receipts',
    rateLimit({
      windowMs: 60_000,
      limit: RECEIPTS_RATE_LIMIT_PER_MINUTE,
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

  // Public: what the gateway did about attesting one paid call, keyed by the invoice nonce.
  // Everything in it is already public on chain (service id, payment tx, attestation tx).
  app.get('/receipts/:nonce', (req, res) => {
    const nonce = req.params.nonce;
    const receipt = nonce !== undefined && isValidNonce(nonce) ? receipts.get(nonce) : undefined;
    // Never cached: a pending receipt changes, and a 404 becomes a 200 once the buyer is served.
    res.set('Cache-Control', 'no-store');
    if (receipt === undefined) {
      res.status(404).json({ error: 'receipt_not_found' });
      return;
    }
    res.json(receipt);
  });

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
        await respond402Fresh(res, service, resource, 'invalid_payment_header');
        return;
      }
      if (payment.payload.kind !== 'tx') {
        // The gasless delegate rail stays off until the relayer lands (Task 10).
        await respond402Fresh(res, service, resource, 'relayer_disabled');
        return;
      }
      const txHashHeader = payment.payload.transaction;
      const nonceHeader = payment.payload.nonce;

      // 3. Validate the invoice behind the presented nonce.
      const invoice = await invoices.get(nonceHeader);
      if (!invoice || invoice.serviceId !== id) { await respond402Fresh(res, service, resource, 'unknown_nonce'); return; }
      if (invoice.used) { await respond402Fresh(res, service, resource, 'invoice_used'); return; }
      if (Date.now() > invoice.expiresAt) { await respond402Fresh(res, service, resource, 'invoice_expired'); return; }

      // 3b. Verify the payment the registry holds for this nonce.
      const verdict = await chain.verifyPayment({
        nonce: nonceHeader,
        serviceId: id,
        minAmountYocto: service.priceYocto,
        maxAgeMs: config.invoiceTtlMs,
        txHash: txHashHeader,
        payer: payment.payload.payer,
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
        pinToPublicIp: config.mode === 'live',
      });
      const success = isUpstreamSuccess(outcome);

      // Attest only when the upstream actually returned a response (F4): a
      // gateway-level failure (upstream_unreachable/upstream_timeout/too_large)
      // is the seller's backend being unreachable, not a service outcome, so it
      // is not scored either way. And never let a self-paid call earn trust
      // (F1): the registry flags a payment whose payer is the owner or the payout
      // account (`verdict.selfPaid`) and rejects attesting it, so we do not try.
      const attest = outcome.kind === 'response' && !verdict.selfPaid;

      // The receipt exists before the buyer is answered, so it can ask for it at once.
      receipts.open(
        { nonce: nonceHeader, serviceId: id, paymentTxHash: txHashHeader },
        {
          status: attest ? 'pending' : verdict.selfPaid ? 'skipped_self_paid' : 'skipped_upstream_failed',
        },
      );

      // 5. Respond to the buyer first, then attest asynchronously.
      // Always set the settlement confirmation header (payment was processed).
      res.set(
        HEADER_X_PAYMENT_RESPONSE,
        encodeXPaymentResponse({
          success: true,
          transaction: txHashHeader,
          network: chain.network,
          payer: verdict.payer,
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

      if (attest) {
        scheduleAttestation(service, nonceHeader, txHashHeader, success);
      } else {
        logger.info('attestation_skipped', {
          serviceId: id,
          reason: verdict.selfPaid ? 'self_payment' : outcome.kind === 'failure' ? outcome.error : 'skipped',
        });
      }
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

  // -------------------------------------------- self-service mapping (no token)
  //
  // A service OWNER maps their upstream by signing a canonical challenge
  // (`buildSelfMapMessage`) with a full-access key of their NEAR account — no
  // shared admin token needed. The check order lives in ./self-map.
  app.post(
    '/services/:id/map',
    wrap(
      createSelfMapHandler({
        config,
        chain,
        logger,
        upstreams,
        getService: (id) => services.get(id),
      }),
    ),
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
      if (ownsAttestationQueue) attestations.close();
      await upstreams.flush();
    },
  };
  app.locals['agentgate'] = internals;

  // Replay any attestations left pending by a previous run (F7). Fire-and-forget;
  // idempotent on-chain, so it is safe even if the previous run partially recorded.
  replayPendingAttestations();

  return app;
}
