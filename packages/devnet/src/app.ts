import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { AgentGateError, createLogger, MIN_PRICE_YOCTO } from '@agentgate/shared';
import type { AgentGateConfig, Logger, Yocto } from '@agentgate/shared';
import { DevnetState } from './state';

export interface DevnetDeps {
  config?: AgentGateConfig;
  logger?: Logger;
}

const U64_MAX = 18_446_744_073_709_551_615n;
const YOCTO_RE = /^(0|[1-9]\d*)$/;
const MAX_QUERY_LIMIT = 1000;

function badRequest(message: string, code = 'invalid_request'): AgentGateError {
  return new AgentGateError(code, message, 400);
}

function asBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function reqString(body: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = body[field];
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string`);
  if (!allowEmpty && value.trim() === '') throw badRequest(`"${field}" must not be empty`);
  return value;
}

function reqBool(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') throw badRequest(`"${field}" must be a boolean`);
  return value;
}

/** Yocto amounts are bigint-backed decimal strings — never floats. */
function reqYocto(body: Record<string, unknown>, field: string, minInclusive = 0n): Yocto {
  const value = reqString(body, field);
  if (!YOCTO_RE.test(value)) {
    throw badRequest(`"${field}" must be a non-negative integer yocto string`);
  }
  if (BigInt(value) < minInclusive) {
    throw badRequest(`"${field}" must be ≥ ${minInclusive} yocto`);
  }
  return value;
}

/** transfer_id is a u64 decimal string. */
function reqU64(body: Record<string, unknown>, field: string): string {
  const value = reqString(body, field);
  if (!YOCTO_RE.test(value) || BigInt(value) > U64_MAX) {
    throw badRequest(`"${field}" must be a u64 decimal string`);
  }
  return value;
}

function reqServiceIdBody(body: Record<string, unknown>, field = 'serviceId'): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw badRequest(`"${field}" must be a positive integer`);
  }
  return value;
}

function serviceIdParam(req: Request): number {
  const raw = req.params['id'] ?? '';
  if (!/^\d{1,15}$/.test(raw)) throw badRequest('service id must be a positive integer');
  const id = Number(raw);
  if (id < 1) throw badRequest('service id must be a positive integer');
  return id;
}

function parseLimit(req: Request, fallback: number): number {
  const raw = req.query['limit'];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) {
    throw badRequest('"limit" must be a positive integer', 'invalid_limit');
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw badRequest(`"limit" must be between 1 and ${MAX_QUERY_LIMIT}`, 'invalid_limit');
  }
  return limit;
}

function reqUrl(body: Record<string, unknown>, field: string): string {
  const value = reqString(body, field);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest(`"${field}" must be a valid URL`, 'invalid_endpoint_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest(`"${field}" must be an http(s) URL`, 'invalid_endpoint_url');
  }
  return value;
}

type SyncHandler = (req: Request, res: Response) => void;

/**
 * Pure express app factory for the in-memory mock chain — no listen().
 * TODO(Task 3): move to the /registry/* routes that mirror the NEAR registry.
 */
export function createApp(deps: DevnetDeps = {}): Express {
  const logger = deps.logger ?? createLogger('devnet');
  const state = new DevnetState();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const wrap = (fn: SyncHandler): SyncHandler => {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (error) {
        if (error instanceof AgentGateError) {
          res.status(error.httpStatus).json({ error: error.code, message: error.message });
          return;
        }
        logger.error('unhandled devnet error', {
          path: req.path,
          method: req.method,
          err: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: 'internal_error', message: 'unexpected devnet error' });
      }
    };
  };

  // POST /faucet {account, amountYocto} → {balanceYocto}
  app.post(
    '/faucet',
    wrap((req, res) => {
      const body = asBody(req);
      const account = reqString(body, 'account');
      const amountYocto = reqYocto(body, 'amountYocto');
      res.json(state.faucet(account, amountYocto));
    }),
  );

  // GET /chain/balance/:account → {account, balanceYocto}
  app.get(
    '/chain/balance/:account',
    wrap((req, res) => {
      const account = req.params['account'] ?? '';
      if (account.trim() === '') throw badRequest('account must not be empty');
      res.json({ account, balanceYocto: state.getBalance(account) });
    }),
  );

  // POST /chain/transfers {fromAccountId, to, amountYocto, transferId} → {txHash, timestamp}
  app.post(
    '/chain/transfers',
    wrap((req, res) => {
      const body = asBody(req);
      res.json(
        state.transfer({
          fromAccountId: reqString(body, 'fromAccountId'),
          to: reqString(body, 'to'),
          amountYocto: reqYocto(body, 'amountYocto', 1n),
          transferId: reqU64(body, 'transferId'),
        }),
      );
    }),
  );

  // GET /chain/transfers/:txHash → transfer record or 404
  app.get(
    '/chain/transfers/:txHash',
    wrap((req, res) => {
      const txHash = req.params['txHash'] ?? '';
      if (txHash.trim() === '') throw badRequest('txHash must not be empty');
      res.json(state.getTransfer(txHash));
    }),
  );

  // POST /chain/register-service RegisterServiceInput & {ownerAccountId} → {serviceId, txHash}
  app.post(
    '/chain/register-service',
    wrap((req, res) => {
      const body = asBody(req);
      res.json(
        state.registerService({
          name: reqString(body, 'name', true), // emptiness mirrored as the contract's empty_name error
          description: reqString(body, 'description', true),
          gatewayBaseUrl: reqUrl(body, 'gatewayBaseUrl'),
          priceYocto: reqYocto(body, 'priceYocto'),
          paymentTarget: reqString(body, 'paymentTarget'),
          attestor: reqString(body, 'attestor'),
          ownerAccountId: reqString(body, 'ownerAccountId'),
        }),
      );
    }),
  );

  // POST /chain/attestations {serviceId, nonce, paymentTxHash, success, byAccountId} → {txHash}
  app.post(
    '/chain/attestations',
    wrap((req, res) => {
      const body = asBody(req);
      res.json(
        state.recordAttestation({
          serviceId: reqServiceIdBody(body),
          nonce: reqString(body, 'nonce'),
          paymentTxHash: reqString(body, 'paymentTxHash'),
          success: reqBool(body, 'success'),
          byAccountId: reqString(body, 'byAccountId'),
        }),
      );
    }),
  );

  // POST /chain/services/:id/active {active, byAccountId} → {txHash} — owner only
  app.post(
    '/chain/services/:id/active',
    wrap((req, res) => {
      const body = asBody(req);
      res.json(
        state.setActive(serviceIdParam(req), reqBool(body, 'active'), reqString(body, 'byAccountId')),
      );
    }),
  );

  // GET /chain/services → ServiceRecord[]
  app.get(
    '/chain/services',
    wrap((_req, res) => {
      res.json(state.listServices());
    }),
  );

  // GET /chain/services/:id → ServiceRecord or 404
  app.get(
    '/chain/services/:id',
    wrap((req, res) => {
      res.json(state.getService(serviceIdParam(req)));
    }),
  );

  // GET /chain/services/:id/score → ServiceScore
  app.get(
    '/chain/services/:id/score',
    wrap((req, res) => {
      res.json(state.getScore(serviceIdParam(req)));
    }),
  );

  // GET /chain/services/:id/attestations?limit= → AttestationRecord[] (newest first)
  app.get(
    '/chain/services/:id/attestations',
    wrap((req, res) => {
      res.json(state.listAttestations(serviceIdParam(req), parseLimit(req, MAX_QUERY_LIMIT)));
    }),
  );

  // GET /chain/activity?limit= → ActivityEvent[] (newest first, default 50)
  app.get(
    '/chain/activity',
    wrap((req, res) => {
      res.json(state.listActivity(parseLimit(req, 50)));
    }),
  );

  // GET /healthz → {ok:true, network:'mock'}
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, network: 'mock' });
  });

  // Unknown routes → 404 JSON.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'unknown devnet route' });
  });

  // Body-parser / unexpected errors → JSON (4-arg signature is required by express).
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid_json', message: 'request body is not valid JSON' });
      return;
    }
    if (error instanceof AgentGateError) {
      res.status(error.httpStatus).json({ error: error.code, message: error.message });
      return;
    }
    logger.error('devnet middleware error', {
      err: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'internal_error', message: 'unexpected devnet error' });
  });

  // Expose the contract floor for tooling/tests without re-hardcoding it.
  app.set('minPriceYocto', MIN_PRICE_YOCTO);

  return app;
}
