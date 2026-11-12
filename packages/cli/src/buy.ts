import { createAgentGateClient, type GaslessWait, type PayAndFetchResult } from '@agentgate/client';
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
  /**
   * Pay out of the prepaid escrow (`pay_from_escrow`, nothing attached) instead of attaching a
   * deposit to `pay`. The budget cap still compares price + storage fee; an escrow below that
   * refuses with ERR_ESCROW_INSUFFICIENT before anything is sent.
   */
  fromEscrow?: boolean;
  /**
   * The gasless rail (implies `fromEscrow`): sign `pay_from_escrow` as a NEP-366 delegate that the
   * gateway relays, paying the gas; the escrow pays price + storage fee and nothing is sent from
   * the account. A gateway whose 402 offers no relay is RELAYER_UNAVAILABLE before anything is signed.
   * While the gateway's relay settles, the same delegate is presented again until the gateway
   * answers definitively (`gaslessWaitMs`, `onGaslessWait`).
   */
  gasless?: boolean;
  /** Gasless: forwarded to createAgentGateClient (default 150 s). */
  gaslessWaitMs?: number;
  /** Gasless: called on each settlement_pending answer (the CLI prints one progress line). */
  onGaslessWait?: (wait: GaslessWait) => void;
  /** The explorer's base URL (live mode): a GASLESS_NOT_SERVED message links the relay tx there. */
  explorerUrl?: string;
  /** How a GASLESS_NOT_SERVED message names the escrow balance read on this surface (CLI command, MCP tool). */
  escrowBalanceHint?: string;
  /** Forwarded to createAgentGateClient. */
  settleDelayMs?: number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /**
   * Forwarded to createAgentGateClient. Off-mock the client refuses private/loopback gateway
   * hosts; pass `false` to lift that for this one call (a dev-only escape hatch).
   */
  rejectPrivateHosts?: boolean;
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
 * attached (or, with `fromEscrow`, `pay_from_escrow` out of the prepaid escrow,
 * attaching nothing, or with `gasless`, a signed `pay_from_escrow` delegate the gateway relays);
 * the client refuses an invoice for any other service id, never follows a redirect
 * (REDIRECT_REFUSED), and throws PAID_NOT_SERVED (with the tx hash and nonce to re-present), or
 * GASLESS_NOT_SERVED (with the signed delegate), when a paid call is not served.
 */
export async function buyService(opts: BuyServiceOpts): Promise<BuyServiceResult> {
  const { chain, signer, id } = opts;

  if (!Number.isSafeInteger(id) || id < 1) {
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
    ...(opts.fromEscrow === true || opts.gasless === true ? { payFrom: 'escrow' as const } : {}),
    ...(opts.gasless === true ? { gasless: true } : {}),
    ...(opts.gaslessWaitMs !== undefined ? { gaslessWaitMs: opts.gaslessWaitMs } : {}),
    ...(opts.onGaslessWait !== undefined ? { onGaslessWait: opts.onGaslessWait } : {}),
    ...(opts.explorerUrl !== undefined ? { explorerUrl: opts.explorerUrl } : {}),
    ...(opts.escrowBalanceHint !== undefined ? { escrowBalanceHint: opts.escrowBalanceHint } : {}),
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts.rejectPrivateHosts !== undefined ? { rejectPrivateHosts: opts.rejectPrivateHosts } : {}),
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
    if (result.payFrom === 'escrow') lines.push('from:     escrow (nothing attached; the escrow was debited)');
    if (result.gasless === true) {
      lines.push(`relayed:  gasless — ${result.relayer ?? 'the gateway'} relayed the signed pay_from_escrow and paid the gas`);
    }
    lines.push(`payment:  ${result.txHash ?? '?'}`);
    if (opts.explorerUrl !== undefined && result.txHash !== undefined) {
      lines.push(`explorer: ${stripTrailingSlashes(opts.explorerUrl)}/txns/${result.txHash}`);
    }
    if (result.settlement !== undefined) {
      const payer = result.settlement.payer !== undefined ? `  (payer ${result.settlement.payer})` : '';
      lines.push(`settled:  ${result.settlement.success ? 'ok' : 'FAILED'}${payer}`);
    }
    // A paid call the gateway does not serve never gets here: fetchPaid throws PAID_NOT_SERVED
    // (or GASLESS_NOT_SERVED).
  }
  lines.push(`status:   ${result.status}`);
  return lines;
}

/**
 * The one progress line `neargate buy --gasless` prints to stderr while the gateway's relay
 * settles (its first settlement_pending answer): the relay tx, with an explorer link when
 * `explorerUrl` is given, and how long the CLI keeps presenting the same signed delegate.
 */
export function formatGaslessWait(wait: GaslessWait, opts: { explorerUrl?: string } = {}): string {
  const tx = wait.transaction;
  const named =
    tx === undefined
      ? ''
      : ` (tx ${tx}${opts.explorerUrl === undefined ? '' : `, ${stripTrailingSlashes(opts.explorerUrl)}/txns/${tx}`})`;
  return (
    `waiting:  the gateway's relay${named} is settling; presenting the same signed delegate again ` +
    `for up to ${Math.round(wait.capMs / 1000)} s`
  );
}

/** The purchased body as `neargate buy` prints it on stdout: text as-is, JSON pretty-printed. */
export function formatBuyBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}
