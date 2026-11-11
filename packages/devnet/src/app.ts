import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { AgentGateError, MOCK_NETWORK, createLogger, parseYocto } from '@agentgate/shared';
import type { AgentGateConfig, Logger, Yocto } from '@agentgate/shared';
import { DevnetState } from './state';

export interface DevnetDeps {
  config?: AgentGateConfig;
  logger?: Logger;
}

const MAX_QUERY_LIMIT = 1000;

function badRequest(message: string, code = 'invalid_request'): AgentGateError {
  return new AgentGateError(code, message, 400);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function reqString(body: Record<string, unknown>, field: string, allowEmpty = false): string {
  const value = body[field];
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string`);
  if (!allowEmpty && value.trim() === '') throw badRequest(`"${field}" must not be empty`);
  return value;
}

/** An account id field: any string (empty included); `isNearAccountId` gives the verdict. */
function reqAccountId(body: Record<string, unknown>, field: string): string {
  return reqString(body, field, true);
}

function reqBool(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') throw badRequest(`"${field}" must be a boolean`);
  return value;
}

/** Yocto amounts are bigint-backed decimal strings (at most u128::MAX), never floats. */
function reqYocto(body: Record<string, unknown>, field: string): Yocto {
  const value = reqString(body, field);
  try {
    return parseYocto(value).toString();
  } catch {
    throw badRequest(`"${field}" must be a non-negative integer yocto string (at most 2^128 - 1)`);
  }
}

/** The contract's `service_id` is a u64: 0 is a well-formed id that simply does not exist. */
function reqServiceIdBody(body: Record<string, unknown>): number {
  const value = body['serviceId'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest('"serviceId" must be a non-negative integer');
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

/** The 4xx `status`/`statusCode` a framework (body-parser, the router) put on an error, or null. */
function frameworkClientStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  for (const candidate of [status, statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 499) {
      return candidate;
    }
  }
  return null;
}

type SyncHandler = (req: Request, res: Response) => void;

/**
 * Pure express app factory for the in-memory mock chain — no listen().
 *
 * Writes name the signing account as `signer` (an account id; the devnet trusts it) and answer a
 * rejected contract call with HTTP 400 `{ error: 'ERR_*', message }`. Reads of a missing service
 * or payment answer 404.
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

  // ---- accounts -------------------------------------------------------------

  // POST /faucet {accountId, amountYocto} → {accountId, balanceYocto, publicKey, secretKey}
  app.post(
    '/faucet',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(state.faucet(reqAccountId(body, 'accountId'), reqYocto(body, 'amountYocto')));
    }),
  );

  // GET /accounts/:id → {accountId, exists}
  app.get(
    '/accounts/:id',
    wrap((req, res) => {
      const accountId = req.params['id'] ?? '';
      res.json({ accountId, exists: state.accountExists(accountId) });
    }),
  );

  // GET /accounts/:id/balance → {accountId, balanceYocto}
  app.get(
    '/accounts/:id/balance',
    wrap((req, res) => {
      const accountId = req.params['id'] ?? '';
      res.json({ accountId, balanceYocto: state.getBalance(accountId) });
    }),
  );

  // GET /accounts/:id/keys/:publicKey → {fullAccess}
  app.get(
    '/accounts/:id/keys/:publicKey',
    wrap((req, res) => {
      res.json({
        fullAccess: state.hasFullAccessKey(req.params['id'] ?? '', req.params['publicKey'] ?? ''),
      });
    }),
  );

  // ---- registry writes ------------------------------------------------------

  // POST /registry/register {signer, input: RegisterServiceInput, depositYocto} → {serviceId, txHash}
  app.post(
    '/registry/register',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      const input = asObject(body['input'], '"input"');
      res.json(
        state.registerService(
          reqAccountId(body, 'signer'),
          {
            name: reqString(input, 'name', true), // blankness is the contract's ERR_EMPTY_NAME
            description: reqString(input, 'description', true),
            gatewayBaseUrl: reqString(input, 'gatewayBaseUrl', true),
            priceYocto: reqYocto(input, 'priceYocto'),
            paymentTarget: reqAccountId(input, 'paymentTarget'),
            attestor: reqAccountId(input, 'attestor'),
          },
          reqYocto(body, 'depositYocto'),
        ),
      );
    }),
  );

  // POST /registry/pay {signer, serviceId, nonce, depositYocto} → {txHash}
  app.post(
    '/registry/pay',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(
        state.pay(
          reqAccountId(body, 'signer'),
          reqServiceIdBody(body),
          reqString(body, 'nonce', true), // the shape is the contract's ERR_INVALID_NONCE
          reqYocto(body, 'depositYocto'),
        ),
      );
    }),
  );

  // POST /registry/deposit-escrow {signer, depositYocto} → {txHash}
  app.post(
    '/registry/deposit-escrow',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(state.depositEscrow(reqAccountId(body, 'signer'), reqYocto(body, 'depositYocto')));
    }),
  );

  // POST /registry/withdraw-escrow {signer, amountYocto, depositYocto} → {txHash}
  // (`depositYocto` is what the call attaches: the contract wants exactly 1 yocto)
  app.post(
    '/registry/withdraw-escrow',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(
        state.withdrawEscrow(
          reqAccountId(body, 'signer'),
          reqYocto(body, 'amountYocto'),
          reqYocto(body, 'depositYocto'),
        ),
      );
    }),
  );

  // POST /registry/pay-from-escrow {signer, serviceId, nonce, depositYocto} → {txHash}
  // (`depositYocto` is what the call attaches: the contract wants none)
  app.post(
    '/registry/pay-from-escrow',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(
        state.payFromEscrow(
          reqAccountId(body, 'signer'),
          reqServiceIdBody(body),
          reqString(body, 'nonce', true), // the shape is the contract's ERR_INVALID_NONCE
          reqYocto(body, 'depositYocto'),
        ),
      );
    }),
  );

  // POST /registry/attest {signer, serviceId, nonce, paymentTxHash, success} → {txHash}
  app.post(
    '/registry/attest',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(
        state.recordAttestation(
          reqAccountId(body, 'signer'),
          reqServiceIdBody(body),
          reqString(body, 'nonce', true), // an unknown nonce is the contract's ERR_PAYMENT_NOT_FOUND
          reqString(body, 'paymentTxHash', true),
          reqBool(body, 'success'),
        ),
      );
    }),
  );

  // POST /registry/active {signer, serviceId, active} → {txHash} — owner only
  app.post(
    '/registry/active',
    wrap((req, res) => {
      const body = asObject(req.body, 'request body');
      res.json(state.setActive(reqAccountId(body, 'signer'), reqServiceIdBody(body), reqBool(body, 'active')));
    }),
  );

  // ---- registry reads -------------------------------------------------------

  // GET /registry/services → ServiceRecord[] (ids ascending)
  app.get(
    '/registry/services',
    wrap((_req, res) => {
      res.json(state.listServices());
    }),
  );

  // GET /registry/services/:id → ServiceRecord or 404
  app.get(
    '/registry/services/:id',
    wrap((req, res) => {
      res.json(state.getService(serviceIdParam(req)));
    }),
  );

  // GET /registry/services/:id/score → ServiceScore
  app.get(
    '/registry/services/:id/score',
    wrap((req, res) => {
      res.json(state.getScore(serviceIdParam(req)));
    }),
  );

  // GET /registry/services/:id/attestations?limit= → AttestationRecord[] (newest first)
  app.get(
    '/registry/services/:id/attestations',
    wrap((req, res) => {
      res.json(state.listAttestations(serviceIdParam(req), parseLimit(req, MAX_QUERY_LIMIT)));
    }),
  );

  // GET /registry/payments/:nonce → PaymentRecord or 404
  app.get(
    '/registry/payments/:nonce',
    wrap((req, res) => {
      res.json(state.getPayment(req.params['nonce'] ?? ''));
    }),
  );

  // GET /registry/escrow/:accountId → {accountId, escrowYocto} ("0" for an account without an escrow)
  app.get(
    '/registry/escrow/:accountId',
    wrap((req, res) => {
      const accountId = req.params['accountId'] ?? '';
      res.json({ accountId, escrowYocto: state.escrowOf(accountId) });
    }),
  );

  // GET /registry/activity?limit= → ActivityEvent[] (newest first, default 50)
  app.get(
    '/registry/activity',
    wrap((req, res) => {
      res.json(state.listActivity(parseLimit(req, 50)));
    }),
  );

  // GET /healthz → {ok:true, network:'near-mock'}
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, network: MOCK_NETWORK });
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
    // Framework client errors keep their status: body-parser's 413 over the body limit, the
    // router's 400 for a malformed percent-escape in a path parameter.
    const status = frameworkClientStatus(error);
    if (status !== null) {
      res.status(status).json({
        error: 'invalid_request',
        message: error instanceof Error ? error.message : 'invalid request',
      });
      return;
    }
    logger.error('devnet middleware error', {
      err: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'internal_error', message: 'unexpected devnet error' });
  });

  return app;
}
