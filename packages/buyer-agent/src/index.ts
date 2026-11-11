import type {
  AgentGateConfig,
  AnySigner,
  AttestationRecord,
  ChainClient,
  Logger,
  Yocto,
} from '@agentgate/shared';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  compareYocto,
  createLogger,
  formatNear,
  formatPriceWithStorage,
  isAgentGateError,
  isMockNetwork,
  loadConfig,
  nearToYocto,
  parseYocto,
  trustTier,
  yoctoToNear,
} from '@agentgate/shared';
import { createChainClient, loadNearSigner } from '@agentgate/chain';
import { createAgentGateClient, PaidNotServedError, waitForReceipt } from '@agentgate/client';
import type { CatalogEntry, LlmClient } from './llm';
import { AnthropicLlm, MockLlm } from './llm';
import { DecisionLog, DEFAULT_DECISIONS_LOG, padCell, renderBlock } from './decision-log';
import type { PrintFn } from './decision-log';

export type { CatalogEntry, LlmClient } from './llm';
export { AnthropicLlm, MockLlm } from './llm';
export type { AnthropicLlmOpts } from './llm';
export { DecisionLog, DEFAULT_DECISIONS_LOG } from './decision-log';

export interface RunBuyerAgentOpts {
  /** Natural-language task, e.g. "Get today's USD/IDR rate and gold price, summarize for a treasury report". */
  task: string;
  /**
   * Budget cap in NEAR (decimal string) on everything the run attaches: price + the 0.002 NEAR
   * storage fee per call. Defaults to config.buyerBudgetNear (BUYER_BUDGET_NEAR).
   */
  budgetNear?: string;
  /** ChainClient to use. Defaults to createChainClient(config). */
  chain?: ChainClient;
  /** Buyer signer. Defaults to defaultBuyerSigner(config). */
  signer?: AnySigner;
  /** LLM seam. Defaults to AnthropicLlm when ANTHROPIC_API_KEY is set, else MockLlm. */
  llm?: LlmClient;
  logger?: Logger;
  /** Pre-loaded config; loaded lazily from process.env only when a default above needs it. */
  config?: AgentGateConfig;
  /** Injectable fetch for the pay client + AnthropicLlm (tests). */
  fetchImpl?: typeof fetch;
  /** Forwarded to createAgentGateClient. */
  settleDelayMs?: number;
  /** JSONL decision-trace path. Default "logs/decisions.jsonl". */
  decisionLogPath?: string;
  /** How long to poll chain.listAttestations for the receipt. Default 5000 ms. */
  attestationTimeoutMs?: number;
  /** Poll interval for the attestation receipt. Default 500 ms. */
  attestationPollIntervalMs?: number;
  /** Console sink for the pretty blocks (tests can silence it). Default console.log. */
  print?: PrintFn;
}

/** Structured outcome of one buyer-agent run. */
export interface BuyerRunReport {
  chosenServiceId: number;
  reason: string;
  paid: boolean;
  paymentTxHash: string | null;
  attestationTxHash: string | null;
  summary: string;
  /** Everything the run attached: price + storage fee. */
  spentYocto: Yocto;
}

const DEFAULT_ATTESTATION_TIMEOUT_MS = 5_000;
const DEFAULT_ATTESTATION_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The attestation tx the gateway that served the call names in its receipt
 * (`GET <gateway>/receipts/<nonce>`), or null. A live activity feed cannot say which tx
 * produced an event (a contract view does not know its own tx), so this is where a buyer on a
 * live chain learns it. The payment has already gone through, so any failure only loses the hash.
 */
async function attestationTxFromReceipt(opts: {
  endpointUrl: string;
  nonce: string;
  fetchImpl: typeof fetch | undefined;
  rejectPrivateHosts: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  logger: Logger;
}): Promise<string | null> {
  try {
    const receipt = await waitForReceipt(opts.endpointUrl, opts.nonce, {
      rejectPrivateHosts: opts.rejectPrivateHosts,
      timeoutMs: opts.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    return receipt?.attestation.status === 'recorded' ? (receipt.attestation.txHash ?? null) : null;
  } catch (err) {
    opts.logger.warn('attestation receipt lookup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The buyer signer from config: mock → MOCK_BUYER_ACCOUNT; live → BUYER_ACCOUNT_ID with its key
 * resolved now by `loadNearSigner` (BUYER_PRIVATE_KEY, then BUYER_KEY_PATH, then
 * ~/.near-credentials/<NEAR_NETWORK>/<account>.json), so a run never starts without a usable key.
 */
export async function defaultBuyerSigner(config: AgentGateConfig): Promise<AnySigner> {
  if (config.mode === 'mock') {
    if (config.mockBuyerAccount === '') {
      throw new AgentGateError(
        'SIGNER_MISSING',
        'mock mode needs MOCK_BUYER_ACCOUNT (run `neargate demo-accounts` and export the printed lines)',
        400,
      );
    }
    return { kind: 'mock', accountId: config.mockBuyerAccount };
  }
  if (config.buyerAccountId === '') {
    throw new AgentGateError(
      'SIGNER_MISSING',
      'live mode needs BUYER_ACCOUNT_ID (key: BUYER_PRIVATE_KEY, BUYER_KEY_PATH or ~/.near-credentials/<network>/<account>.json)',
      400,
    );
  }
  const { signer } = await loadNearSigner({
    accountId: config.buyerAccountId,
    network: config.nearNetwork,
    ...(config.buyerPrivateKey !== '' ? { secretKey: config.buyerPrivateKey } : {}),
    ...(config.buyerKeyPath !== '' ? { keyPath: config.buyerKeyPath } : {}),
  });
  return signer;
}

function catalogTable(catalog: CatalogEntry[]): string[] {
  const header = `${padCell('id', 4)}${padCell('name', 28)}${padCell('price', 14)}${padCell('tier', 10)}score`;
  const rows = catalog.map((e) => {
    const score = `${e.score.successCalls}/${e.score.totalCalls}`;
    const active = e.service.active ? '' : ' (inactive)';
    return (
      padCell(String(e.service.id), 4) +
      padCell(e.service.name + active, 28) +
      padCell(formatNear(e.service.priceYocto), 14) +
      padCell(e.tier, 10) +
      score
    );
  });
  return [header, ...rows];
}

/**
 * LLM decision loop: list services → pick (AnthropicLlm or MockLlm) →
 * budget check BEFORE paying → fetchPaid → summarize → attestation receipt.
 * Each step is printed as a console block AND appended to logs/decisions.jsonl.
 * A call that was paid but not served (PAID_NOT_SERVED) ends the run with a paid
 * report: the spend is counted and the proof (tx + nonce) is reported to re-present.
 */
export async function runBuyerAgent(opts: RunBuyerAgentOpts): Promise<BuyerRunReport> {
  if (!opts || typeof opts.task !== 'string' || opts.task.trim() === '') {
    throw new AgentGateError('BAD_TASK', 'runBuyerAgent requires a non-empty task', 400);
  }
  const task = opts.task.trim();
  const logger = opts.logger ?? createLogger('buyer-agent');
  const print: PrintFn = opts.print ?? ((text) => console.log(text));
  const decisions = new DecisionLog(opts.decisionLogPath ?? DEFAULT_DECISIONS_LOG, logger);

  // Lazily resolve config only when a default actually needs it.
  let config = opts.config;
  const getConfig = (): AgentGateConfig => {
    if (config === undefined) config = loadConfig();
    return config;
  };

  const chain = opts.chain ?? createChainClient(getConfig());
  const signer = opts.signer ?? (await defaultBuyerSigner(getConfig()));
  const llm: LlmClient =
    opts.llm ??
    (getConfig().anthropicApiKey !== ''
      ? new AnthropicLlm({
          apiKey: getConfig().anthropicApiKey,
          model: getConfig().llmModel,
          logger,
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        })
      : new MockLlm());

  const budgetNear = opts.budgetNear ?? getConfig().buyerBudgetNear;
  const budgetYocto: Yocto = nearToYocto(budgetNear); // throws INVALID_AMOUNT on garbage
  let spentYocto: Yocto = '0';

  decisions.append('run_start', { task, budgetNear, network: chain.network, llm: llm.name });

  // 1. Catalog: list services + scores + trust tiers.
  const services = await chain.listServices();
  const catalog: CatalogEntry[] = [];
  for (const service of services) {
    const score = await chain.getScore(service.id);
    catalog.push({ service, score, tier: trustTier(score) });
  }
  print(
    renderBlock(`STEP 1 · CATALOG (${chain.network})`, [
      `${catalog.length} service(s) on-chain · budget ${budgetNear} NEAR`,
      ...catalogTable(catalog),
    ]),
  );
  decisions.append('catalog', {
    count: catalog.length,
    services: catalog.map((e) => ({
      id: e.service.id,
      name: e.service.name,
      priceYocto: e.service.priceYocto,
      tier: e.tier,
      active: e.service.active,
    })),
  });
  if (catalog.length === 0) {
    decisions.append('error', { code: 'NO_SERVICES' });
    throw new AgentGateError('NO_SERVICES', 'no services registered on-chain', 404);
  }

  // 2. LLM picks a service.
  const choice = await llm.chooseService(task, catalog);
  const chosen = catalog.find((e) => e.service.id === choice.serviceId);
  if (chosen === undefined) {
    decisions.append('error', { code: 'LLM_BAD_CHOICE', serviceId: choice.serviceId });
    throw new AgentGateError(
      'LLM_BAD_CHOICE',
      `LLM chose unknown serviceId ${choice.serviceId}`,
      502,
    );
  }
  if (!chosen.service.active) {
    decisions.append('error', { code: 'LLM_BAD_CHOICE', serviceId: choice.serviceId });
    throw new AgentGateError(
      'LLM_BAD_CHOICE',
      `LLM chose inactive service ${choice.serviceId}`,
      502,
    );
  }
  print(
    renderBlock(`STEP 2 · DECISION (${llm.name})`, [
      `chose #${chosen.service.id} "${chosen.service.name}" at ${formatPriceWithStorage(chosen.service.priceYocto)}`,
      `reason: ${choice.reason}`,
    ]),
  );
  decisions.append('choice', {
    serviceId: chosen.service.id,
    serviceName: chosen.service.name,
    priceYocto: chosen.service.priceYocto,
    reason: choice.reason,
    llm: llm.name,
  });

  // 3. Budget enforcement BEFORE paying: cumulative spend + what the call attaches
  // (price + the registry storage fee) must fit the budget.
  const price = chosen.service.priceYocto;
  const callTotal = addYocto(price, PAYMENT_STORAGE_FEE_YOCTO);
  const projected = addYocto(spentYocto, callTotal);
  if (compareYocto(projected, budgetYocto) > 0) {
    const refusal =
      `refused: ${formatPriceWithStorage(price)} would exceed budget ` +
      `${formatNear(budgetYocto)} (already spent ${formatNear(spentYocto)})`;
    print(renderBlock('STEP 3 · BUDGET — REFUSED', [refusal]));
    decisions.append('budget_refusal', {
      serviceId: chosen.service.id,
      priceYocto: price,
      depositYocto: callTotal,
      spentYocto,
      budgetYocto,
    });
    logger.warn('budget refusal', { priceYocto: price, depositYocto: callTotal, budgetYocto });
    return {
      chosenServiceId: chosen.service.id,
      reason: choice.reason,
      paid: false,
      paymentTxHash: null,
      attestationTxHash: null,
      summary: refusal,
      spentYocto: '0',
    };
  }
  print(
    renderBlock('STEP 3 · BUDGET — OK', [
      `${formatPriceWithStorage(price)} fits budget ${formatNear(budgetYocto)} (spent so far ${formatNear(spentYocto)})`,
    ]),
  );
  decisions.append('budget_ok', { priceYocto: price, depositYocto: callTotal, budgetYocto, spentYocto });

  // 4. Pay & consume via the 402 client. The cap is the total the budget gate just
  // approved (on-chain price + storage fee) — NOT the whole remaining budget — so a
  // 402 invoice that quotes more than the advertised price is refused instead of
  // silently charged up to the full budget, and an invoice for another service is
  // refused outright.
  const client = createAgentGateClient({
    chain,
    signer,
    maxYocto: callTotal,
    expectedServiceId: chosen.service.id,
    logger,
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });

  let result;
  try {
    result = await client.fetchPaid(chosen.service.endpointUrl);
  } catch (err) {
    if (isAgentGateError(err) && err.code === 'BUDGET_EXCEEDED') {
      const refusal = `refused: the invoice asks more than the approved ${formatNear(callTotal)} — ${err.message}`;
      print(renderBlock('STEP 4 · PAYMENT — REFUSED', [refusal]));
      decisions.append('budget_refusal', { serviceId: chosen.service.id, error: err.message });
      return {
        chosenServiceId: chosen.service.id,
        reason: choice.reason,
        paid: false,
        paymentTxHash: null,
        attestationTxHash: null,
        summary: refusal,
        spentYocto: '0',
      };
    }
    if (err instanceof PaidNotServedError) {
      // The deposit is spent but nothing was served: account for the spend and report the
      // proof (tx + nonce) to re-present. Never pay a fresh invoice for the same call.
      spentYocto = addYocto(spentYocto, err.depositYocto);
      const remaining: Yocto = (parseYocto(budgetYocto) - parseYocto(spentYocto)).toString();
      const status = err.status !== undefined ? ` (HTTP ${err.status})` : '';
      const summary =
        `paid ${formatNear(err.depositYocto)} (tx ${err.txHash}) but the call was not served: ${err.reason}${status}. ` +
        `Re-present the proof (nonce ${err.nonce}) instead of paying again.`;
      print(
        renderBlock('STEP 4 · PAYMENT — NOT SERVED', [
          `paid ${formatNear(err.depositYocto)} → tx ${err.txHash}`,
          `not served: ${err.reason}${status}`,
          `re-present the proof (nonce ${err.nonce}) instead of paying again`,
          `remaining budget: ${yoctoToNear(remaining)} NEAR`,
        ]),
      );
      decisions.append('payment', {
        serviceId: chosen.service.id,
        paid: true,
        served: false,
        reason: err.reason,
        status: err.status ?? null,
        paymentTxHash: err.txHash,
        nonce: err.nonce,
        depositYocto: err.depositYocto,
        spentYocto,
      });
      const report: BuyerRunReport = {
        chosenServiceId: chosen.service.id,
        reason: choice.reason,
        paid: true,
        paymentTxHash: err.txHash,
        attestationTxHash: null,
        summary,
        spentYocto,
      };
      decisions.append('run_end', { ...report });
      return report;
    }
    decisions.append('error', {
      code: isAgentGateError(err) ? err.code : 'FETCH_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const paymentTxHash = result.txHash ?? null;
  if (result.paid && result.depositYocto !== undefined) {
    spentYocto = addYocto(spentYocto, result.depositYocto);
  }
  const remainingAfter: Yocto = (parseYocto(budgetYocto) - parseYocto(spentYocto)).toString();
  print(
    renderBlock('STEP 4 · PAYMENT', [
      result.paid
        ? `paid ${formatPriceWithStorage(
            result.priceYocto ?? price,
            result.requirements?.extra.storageFeeYocto,
          )} → tx ${paymentTxHash ?? '?'}`
        : 'no payment was required',
      `upstream status: ${result.status}`,
      `remaining budget: ${yoctoToNear(remainingAfter)} NEAR`,
    ]),
  );
  decisions.append('payment', {
    serviceId: chosen.service.id,
    paid: result.paid,
    paymentTxHash,
    priceYocto: result.priceYocto ?? null,
    depositYocto: result.depositYocto ?? null,
    status: result.status,
    spentYocto,
  });

  const ok = result.status >= 200 && result.status < 300;

  // 5. Summarize the purchased data for the task.
  let summary: string;
  if (ok) {
    summary = await llm.summarize(task, result.body);
  } else {
    summary = `service request failed with HTTP ${result.status} after ${
      result.paid ? 'payment' : 'no payment'
    } — no data to summarize`;
  }
  print(renderBlock('STEP 5 · REPORT', summary.split('\n')));
  decisions.append('summary', { serviceId: chosen.service.id, ok, summary });

  // 6. Receipt: poll the chain (≤5 s) for the attestation our payment triggered. The
  // payment has already gone through, so a failing read only loses the receipt.
  let attestationTxHash: string | null = null;
  if (paymentTxHash !== null) {
    const timeoutMs = opts.attestationTimeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
    const pollMs = opts.attestationPollIntervalMs ?? DEFAULT_ATTESTATION_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let found: AttestationRecord | undefined;
    let pollWarned = false;
    for (;;) {
      try {
        const attestations = await chain.listAttestations(chosen.service.id, 50);
        found = attestations.find((a) => a.paymentTxHash === paymentTxHash);
      } catch (err) {
        if (!pollWarned) {
          pollWarned = true;
          logger.warn('attestation poll failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (found !== undefined || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    if (found !== undefined) {
      // An AttestationRecord carries no tx hash of its own: the attestation tx is
      // the matching `attestation` event (same service + nonce) in the activity feed.
      // The payment has already gone through, so a failing feed read only loses the hash.
      const nonce = found.nonce;
      try {
        const activity = await chain.listRecentActivity(50);
        const event = activity.find(
          (e) => e.kind === 'attestation' && e.serviceId === chosen.service.id && e.nonce === nonce,
        );
        attestationTxHash = event?.txHash ?? null;
      } catch (err) {
        attestationTxHash = null;
        logger.warn('attestation tx lookup failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // A live feed has no tx for its events (txHash null): ask the gateway's receipt.
      if (attestationTxHash === null) {
        attestationTxHash = await attestationTxFromReceipt({
          endpointUrl: chosen.service.endpointUrl,
          nonce,
          fetchImpl: opts.fetchImpl,
          rejectPrivateHosts: !isMockNetwork(chain.network),
          timeoutMs,
          pollIntervalMs: pollMs,
          logger,
        });
      }
      print(
        renderBlock('STEP 6 · RECEIPT', [
          `payment tx: ${paymentTxHash}`,
          `attestation tx: ${attestationTxHash ?? '?'} (success=${String(found.success)})`,
          `remaining budget: ${yoctoToNear(remainingAfter)} NEAR`,
        ]),
      );
    } else {
      print(
        renderBlock('STEP 6 · RECEIPT', [
          `payment tx: ${paymentTxHash}`,
          `attestation not observed within ${String(timeoutMs)} ms — check the dashboard feed`,
        ]),
      );
    }
    decisions.append('attestation', {
      serviceId: chosen.service.id,
      paymentTxHash,
      attestationTxHash,
      success: found?.success ?? null,
    });
  }

  const report: BuyerRunReport = {
    chosenServiceId: chosen.service.id,
    reason: choice.reason,
    paid: result.paid,
    paymentTxHash,
    attestationTxHash,
    summary,
    spentYocto,
  };
  decisions.append('run_end', { ...report });
  return report;
}
