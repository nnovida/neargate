import express, { type Express } from 'express';
import { createLogger, loadConfig, type AgentGateConfig, type Logger } from '@agentgate/shared';
import type { FeedResponse, FetchLike, PairKey, SinglePairResponse } from './types';
import { FeedProvider } from './feed';
import { fixtureFeed } from './fixture';

export interface OracleDeps {
  config?: AgentGateConfig;
  logger?: Logger;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/** Pure express app factory for the RWA feed (USD/IDR + gold spot + confidence) — no listen(). */
export function createApp(deps: OracleDeps = {}): Express {
  const config = deps.config ?? loadConfig();
  const logger = deps.logger ?? createLogger('oracle');
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? ((): number => Date.now());

  const provider = new FeedProvider({
    staticMode: config.oracleStatic,
    fetchImpl,
    logger,
    now,
  });

  /** Never rejects — the oracle always answers 200 with best-effort data. */
  const safeFeed = async (): Promise<FeedResponse> => {
    try {
      return await provider.getFeed();
    } catch (err) {
      logger.error('feed lookup failed — serving static fixture', {
        error: err instanceof Error ? err.message : String(err),
      });
      return fixtureFeed(now());
    }
  };

  const singlePair = (feed: FeedResponse, pair: PairKey): SinglePairResponse => ({
    pair,
    ...feed.pairs[pair],
    asOf: feed.asOf,
    attribution: feed.attribution,
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/feed', async (_req, res) => {
    res.json(await safeFeed());
  });

  app.get('/feed/usd-idr', async (_req, res) => {
    res.json(singlePair(await safeFeed(), 'usd_idr'));
  });

  app.get('/feed/gold', async (_req, res) => {
    res.json(singlePair(await safeFeed(), 'xau_usd'));
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, static: config.oracleStatic });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
