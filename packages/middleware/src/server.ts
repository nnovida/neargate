import type { AddressInfo } from 'node:net';
import {
  AgentGateError,
  createLogger,
  loadConfig,
  type AgentGateConfig,
  type ChainClient,
  type Logger,
} from '@agentgate/shared';
import { createApp, type AppInternals } from './app';
import type { InvoiceStore } from './invoice-store';
import type { FacilitatorClient } from '@x402/core/http';

export interface MiddlewareStartOpts {
  /** Port to listen on (0 = ephemeral, for in-process e2e). Defaults to config.middlewarePort (4021). */
  port?: number;
  config?: AgentGateConfig;
  chain?: ChainClient;
  logger?: Logger;
  /** Path of the upstream-map JSON file (see MiddlewareDeps.upstreamsFile). */
  upstreamsFile?: string;
  /** Custom invoice store (default: in-memory + TTL sweep). */
  invoiceStore?: InvoiceStore;
  /**
   * Persist invoices to this JSON file so they survive a restart (F2). Defaults
   * to the INVOICE_STORE_PATH env var. Ignored when `invoiceStore` is injected.
   */
  invoiceStorePath?: string;
  /**
   * Persist pending attestations to this JSON file so a served+paid call whose
   * on-chain attestation never confirmed is replayed after a restart (F7).
   * Defaults to the ATTESTATION_QUEUE_PATH env var. Ignored when `attestationQueue`
   * is injected.
   */
  attestationQueuePath?: string;
  /** Base delay before the first attestation retry (exponential backoff). Default 5000 ms. */
  attestationRetryDelayMs?: number;
  /** Total attestation attempts before giving up. Default 4. */
  attestationMaxAttempts?: number;
  /** Injected facilitator client for the x402 v2 rail (tests bypass the real HTTP client). */
  facilitatorClient?: FacilitatorClient;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** How long close() waits for in-flight requests before force-closing sockets. */
const FORCE_CLOSE_AFTER_MS = 5_000;

/**
 * Boots the middleware HTTP server; resolves with the bound port and a
 * close() handle. Graceful shutdown: SIGTERM/SIGINT trigger close(), which
 * stops accepting connections, lets in-flight requests finish (up to 5s),
 * flushes the upstream map, and stops the invoice TTL sweep.
 */
export async function startServer(opts: MiddlewareStartOpts = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  const logger = opts.logger ?? createLogger('middleware');

  let chain = opts.chain;
  if (!chain) {
    // Lazy import so in-process consumers that inject a ChainClient never
    // load the chain package (and its casper-js-sdk dependency) at all.
    const { createChainClient } = await import('@agentgate/chain');
    chain = createChainClient(config);
  }

  // Persist invoices across restarts when a path is configured (F2).
  const invoiceStorePath = opts.invoiceStorePath ?? process.env.INVOICE_STORE_PATH;
  // Persist pending attestations across restarts when a path is configured (F7).
  const attestationQueuePath = opts.attestationQueuePath ?? process.env.ATTESTATION_QUEUE_PATH;

  const app = createApp({
    config,
    chain,
    logger,
    ...(opts.upstreamsFile !== undefined ? { upstreamsFile: opts.upstreamsFile } : {}),
    ...(opts.invoiceStore !== undefined ? { invoiceStore: opts.invoiceStore } : {}),
    ...(invoiceStorePath !== undefined ? { invoiceStorePath } : {}),
    ...(attestationQueuePath !== undefined ? { attestationQueuePath } : {}),
    ...(opts.attestationRetryDelayMs !== undefined
      ? { attestationRetryDelayMs: opts.attestationRetryDelayMs }
      : {}),
    ...(opts.attestationMaxAttempts !== undefined
      ? { attestationMaxAttempts: opts.attestationMaxAttempts }
      : {}),
    ...(opts.facilitatorClient !== undefined ? { facilitatorClient: opts.facilitatorClient } : {}),
  });
  const internals = app.locals['agentgate'] as AppInternals | undefined;

  const port = opts.port ?? config.middlewarePort;
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const s = app.listen(port);
    s.once('listening', () => resolve(s));
    s.once('error', (err) => reject(new AgentGateError('LISTEN_FAILED', err.message, 500)));
  });
  const boundPort = (server.address() as AddressInfo).port;
  logger.info('middleware_listening', { port: boundPort, mode: config.mode });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      await new Promise<void>((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS);
        force.unref();
        server.close((err) => {
          clearTimeout(force);
          if (err) reject(err);
          else resolve();
        });
        server.closeIdleConnections();
      });
      await internals?.dispose();
      logger.info('middleware_closed', { port: boundPort });
    })();
    return closing;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info('shutdown_signal', { signal });
    close().catch((err: unknown) => {
      logger.error('shutdown_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { port: boundPort, close };
}
