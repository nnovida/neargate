import { createLogger, loadConfig } from '@agentgate/shared';
import { createApp, type OracleDeps } from './app';

export { createApp, type OracleDeps } from './app';
export type {
  FeedResponse,
  PairFeed,
  PairKey,
  SinglePairResponse,
  SourceQuote,
  FetchLike,
  FetchResponseLike,
} from './types';
export {
  FIXTURE_USD_IDR,
  FIXTURE_XAU_USD,
  FIXTURE_CONFIDENCE,
  STATIC_ATTRIBUTION,
  fixtureFeed,
} from './fixture';
export { CACHE_TTL_MS, buildFeed, FeedProvider } from './feed';
export { SOURCES, SOURCE_TIMEOUT_MS } from './sources';
export { confidenceOf } from './math';

export interface OracleStartOpts extends OracleDeps {
  /** Port to listen on (0 = ephemeral, for in-process e2e). Defaults to config.oraclePort (4010). */
  port?: number;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/** Boots the oracle HTTP server; resolves with the bound port and a close() handle. */
export async function startServer(opts: OracleStartOpts = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  const logger = opts.logger ?? createLogger('oracle');
  const app = createApp({ ...opts, config, logger });
  const port = opts.port ?? config.oraclePort;

  return new Promise<RunningServer>((resolve, reject) => {
    const server = app.listen(port, () => {
      server.off('error', reject);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      logger.info('oracle listening', { port: boundPort, static: config.oracleStatic });
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
    server.once('error', reject);
  });
}
