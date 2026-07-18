import { createAgentGateClient, type PayAndFetchResult } from '@agentgate/client';
import {
  AgentGateError,
  compareMotes,
  csprToMotes,
  stripTrailingSlashes,
  type AnySigner,
  type ChainClient,
  type Motes,
  type ServiceRecord,
} from '@agentgate/shared';

export interface BuyServiceOpts {
  chain: ChainClient;
  signer: AnySigner;
  /** Service id (1-based, as shown by `agentgate list`). */
  id: number;
  /** Refuse invoices priced above this, in CSPR (e.g. "5"). */
  maxCspr?: string;
  /** HTTP method for the paid request. Default GET. */
  method?: string;
  /** JSON request body — validated up front, sent on both legs. */
  body?: string;
  /** Gateway base URL override; default: the service's on-chain endpoint. */
  gateway?: string;
  /** Forwarded to createAgentGateClient. */
  settleDelayMs?: number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Buyer key algorithm for the facilitator (x402 v2) rail. Default secp256k1. */
  buyerKeyAlgo?: 'ed25519' | 'secp256k1';
}

export interface BuyServiceResult {
  service: ServiceRecord;
  /** The exact URL the paid request was sent to. */
  url: string;
  result: PayAndFetchResult;
}

/**
 * Programmatic `agentgate buy`: resolve the service on-chain, fail fast on
 * anything that would waste a payment (unknown/paused service, price above the
 * cap, malformed body), then run the full 402 → pay → retry-with-proof exchange
 * via the client's fetchPaid. No contract call is involved — payment is a
 * native transfer carrying the invoice nonce as transfer_id.
 */
export async function buyService(opts: BuyServiceOpts): Promise<BuyServiceResult> {
  const { chain, signer, id } = opts;

  if (!Number.isInteger(id) || id < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${String(id)}`,
      400,
    );
  }

  if (opts.body !== undefined) {
    try {
      JSON.parse(opts.body);
    } catch {
      throw new AgentGateError(
        'INVALID_INPUT',
        '--body must be valid JSON (the gateway rejects non-JSON request bodies before charging)',
        400,
      );
    }
  }

  const maxPriceMotes: Motes | undefined =
    opts.maxCspr !== undefined ? csprToMotes(opts.maxCspr) : undefined;

  const service = await chain.getService(id);
  if (service === null) {
    throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found`, 404);
  }
  if (!service.active) {
    throw new AgentGateError(
      'SERVICE_INACTIVE',
      `service ${id} (${service.name}) is paused by its owner — not paying`,
      403,
    );
  }
  // Fail fast before any HTTP when the on-chain price already exceeds the cap.
  if (maxPriceMotes !== undefined && compareMotes(service.priceMotes, maxPriceMotes) > 0) {
    throw new AgentGateError(
      'PRICE_EXCEEDED',
      `service price ${service.priceMotes} motes exceeds --max ${maxPriceMotes} motes`,
      402,
    );
  }

  const url =
    opts.gateway !== undefined
      ? `${stripTrailingSlashes(opts.gateway)}/svc/${id}`
      : service.endpointUrl;

  const client = createAgentGateClient({
    chain,
    signer,
    ...(maxPriceMotes !== undefined ? { maxPriceMotes } : {}),
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts.buyerKeyAlgo !== undefined ? { buyerKeyAlgo: opts.buyerKeyAlgo } : {}),
  });

  const init: RequestInit | undefined =
    opts.method !== undefined || opts.body !== undefined
      ? {
          method: (opts.method ?? 'GET').toUpperCase(),
          ...(opts.body !== undefined
            ? { body: opts.body, headers: { 'content-type': 'application/json' } }
            : {}),
        }
      : undefined;

  const result = await client.fetchPaid(url, init);
  return { service, url, result };
}
