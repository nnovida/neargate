import { createAgentGateClient, type PayAndFetchResult } from '@agentgate/client';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  compareYocto,
  formatNear,
  formatPriceWithStorage,
  nearToYocto,
  stripTrailingSlashes,
  type AnySigner,
  type ChainClient,
  type ServiceRecord,
  type Yocto,
} from '@agentgate/shared';

export interface BuyServiceOpts {
  chain: ChainClient;
  signer: AnySigner;
  /** Service id (1-based, as shown by `neargate list`). */
  id: number;
  /** Budget cap in NEAR (e.g. "5") on the total attached: price + the 0.002 NEAR storage fee. */
  maxNear?: string;
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
}

export interface BuyServiceResult {
  service: ServiceRecord;
  /** The exact URL the paid request was sent to. */
  url: string;
  result: PayAndFetchResult;
}

/**
 * Programmatic `neargate buy`: resolve the service on-chain, fail fast on
 * anything that would waste a payment (unknown/paused service, price + storage
 * fee above the cap, malformed body), then run the full 402 → pay →
 * retry-with-proof exchange via the client's fetchPaid. Payment is a registry
 * `pay` call carrying the invoice nonce, with the price plus the storage fee
 * attached; the client refuses an invoice for any other service id.
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

  const maxYocto: Yocto | undefined = opts.maxNear !== undefined ? nearToYocto(opts.maxNear) : undefined;

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
  // Fail fast before any HTTP when what a call attaches (price + storage fee) already
  // exceeds the cap; the client re-checks the invoice's maxAmountRequired.
  const totalYocto = addYocto(service.priceYocto, PAYMENT_STORAGE_FEE_YOCTO);
  if (maxYocto !== undefined && compareYocto(totalYocto, maxYocto) > 0) {
    throw new AgentGateError(
      'BUDGET_EXCEEDED',
      `service ${id} costs ${formatPriceWithStorage(service.priceYocto)} (${formatNear(totalYocto)} attached), ` +
        `above the ${formatNear(maxYocto)} cap`,
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
    expectedServiceId: id,
    ...(maxYocto !== undefined ? { maxYocto } : {}),
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
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

/**
 * The `neargate buy` receipt (printed to stderr, so stdout carries only the body):
 * service, url, what was paid (price + storage), the payment tx, an explorer link
 * when `explorerUrl` is given, the settlement and the final status.
 */
export function formatBuyReceipt(bought: BuyServiceResult, opts: { explorerUrl?: string } = {}): string[] {
  const { service, url, result } = bought;
  const lines = [`service:  #${service.id} ${service.name}`, `url:      ${url}`];
  if (!result.paid) {
    lines.push('paid:     no — the endpoint answered without requiring payment');
  } else {
    const storageFee = result.requirements?.extra.storageFeeYocto ?? PAYMENT_STORAGE_FEE_YOCTO;
    lines.push(`paid:     ${formatPriceWithStorage(result.priceYocto ?? service.priceYocto, storageFee)}`);
    lines.push(`payment:  ${result.txHash ?? '?'}`);
    if (opts.explorerUrl !== undefined && result.txHash !== undefined) {
      lines.push(`explorer: ${stripTrailingSlashes(opts.explorerUrl)}/txns/${result.txHash}`);
    }
    if (result.settlement !== undefined) {
      const payer = result.settlement.payer !== undefined ? `  (payer ${result.settlement.payer})` : '';
      lines.push(`settled:  ${result.settlement.success ? 'ok' : 'FAILED'}${payer}`);
    }
    if (result.status === 402) {
      lines.push('warning:  payment sent but the gateway still answered 402 — see the body for the error code');
    }
  }
  lines.push(`status:   ${result.status}`);
  return lines;
}

/** The purchased body as `neargate buy` prints it on stdout: text as-is, JSON pretty-printed. */
export function formatBuyBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}
