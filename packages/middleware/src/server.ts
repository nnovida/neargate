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
  /** Delay before the single attestation retry. Default 5000 ms. */
  attestationRetryDelayMs?: number;
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

  const app = createApp({
    config,
    chain,
    logger,
    ...(opts.upstreamsFile !== undefined ? { upstreamsFile: opts.upstreamsFile } : {}),
    ...(opts.invoiceStore !== undefined ? { invoiceStore: opts.invoiceStore } : {}),
    ...(opts.attestationRetryDelayMs !== undefined
      ? { attestationRetryDelayMs: opts.attestationRetryDelayMs }
      : {}),
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
