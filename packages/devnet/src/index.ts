import type { Server } from 'node:http';
import { AgentGateError, createLogger, loadConfig } from '@agentgate/shared';
import { createApp } from './app';
import type { DevnetDeps } from './app';

export { createApp } from './app';
export type { DevnetDeps } from './app';
export {
  ACTIVITY_LOG_CAP,
  ATTESTATIONS_PER_SERVICE_CAP,
  MIN_PRICE_MOTES,
  TRANSFER_LOG_CAP,
  MAX_SERVICES,
  deriveAccountHash,
} from './state';
export type { TransferRecord } from './state';

export interface DevnetStartOpts extends DevnetDeps {
  /** Port to listen on (0 = ephemeral, for in-process e2e). Defaults to config.devnetPort (4030). */
  port?: number;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Boots the devnet HTTP server; resolves with the bound port and a close() handle. */
export async function startServer(opts: DevnetStartOpts = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  // Fail closed: devnet is the in-memory mock chain and must never stand in for
  // a real backend. Code-enforce the guarantee so it can't be a doc-only promise.
  if (config.mode === 'live') {
    throw new AgentGateError(
      'DEVNET_LIVE_REFUSED',
      'devnet is the mock chain and must not run in live mode',
      500,
    );
  }
  const logger = opts.logger ?? createLogger('devnet');
  const app = createApp({ config, logger });
  const requestedPort = opts.port ?? config.devnetPort;

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(requestedPort);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('devnet failed to bind a TCP port');
  }
  const port = address.port;
  logger.info('devnet listening', { port, network: 'mock' });

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
