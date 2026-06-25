import type {
  AgentGateConfig,
  AnySigner,
  AttestationRecord,
  ChainClient,
  Logger,
  Motes,
} from '@agentgate/shared';
import {
  AgentGateError,
  addMotes,
  compareMotes,
  createLogger,
  csprToMotes,
  formatCspr,
  isAgentGateError,
  loadConfig,
  motesToCspr,
  parseMotes,
  trustTier,
} from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';
import { createAgentGateClient } from '@agentgate/client';
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
  /** Budget cap in CSPR (decimal string). Defaults to config.buyerBudgetCspr (BUYER_BUDGET_CSPR). */
  budgetCspr?: string;
  /** ChainClient to use. Defaults to createChainClient(config). */
  chain?: ChainClient;
  /** Buyer signer. Defaults per mode: mock → MOCK_BUYER_ACCOUNT, live → BUYER_SIGNER_PEM_PATH. */
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
  deployHash: string | null;
  attestationTxHash: string | null;
  summary: string;
  spentMotes: Motes;
}

const DEFAULT_ATTESTATION_TIMEOUT_MS = 5_000;
const DEFAULT_ATTESTATION_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Derives the default buyer signer from config per mode (SPEC §1 env contract). */
export function defaultBuyerSigner(config: AgentGateConfig): AnySigner {
  if (config.mode === 'mock') {
    if (config.mockBuyerAccount === '') {
      throw new AgentGateError(
        'NO_SIGNER',
        'mock mode needs MOCK_BUYER_ACCOUNT (run `agentgate demo-accounts` and export the printed lines)',
        500,
      );
    }
    return { kind: 'mock', publicKey: config.mockBuyerAccount };
  }
  if (config.buyerSignerPemPath === '') {
    throw new AgentGateError('NO_SIGNER', 'live mode needs BUYER_SIGNER_PEM_PATH', 500);
  }
  return { kind: 'pem', pemPath: config.buyerSignerPemPath };
}

function catalogTable(catalog: CatalogEntry[]): string[] {
  const header = `${padCell('id', 4)}${padCell('name', 28)}${padCell('price', 14)}${padCell('tier', 10)}score`;
  const rows = catalog.map((e) => {
    const score = `${e.score.successCalls}/${e.score.totalCalls}`;
    const active = e.service.active ? '' : ' (inactive)';
    return (
      padCell(String(e.service.id), 4) +
      padCell(e.service.name + active, 28) +
      padCell(formatCspr(e.service.priceMotes), 14) +
      padCell(e.tier, 10) +
      score
    );
  });
  return [header, ...rows];
}

/**
 * LLM decision loop (SPEC §8): list services → pick (AnthropicLlm or MockLlm) →
 * budget check BEFORE paying → fetchPaid → summarize → attestation receipt.
 * Each step is printed as a console block AND appended to logs/decisions.jsonl.
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
  const signer = opts.signer ?? defaultBuyerSigner(getConfig());
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

  const budgetCspr = opts.budgetCspr ?? getConfig().buyerBudgetCspr;
  const budgetMotes: Motes = csprToMotes(budgetCspr); // throws INVALID_AMOUNT on garbage
  let spentMotes: Motes = '0';

  decisions.append('run_start', { task, budgetCspr, network: chain.network, llm: llm.name });

  // 1. Catalog: list services + scores + trust tiers.
  const services = await chain.listServices();
  const catalog: CatalogEntry[] = [];
  for (const service of services) {
    const score = await chain.getScore(service.id);
    catalog.push({ service, score, tier: trustTier(score) });
  }
  print(
    renderBlock(`STEP 1 · CATALOG (${chain.network})`, [
      `${catalog.length} service(s) on-chain · budget ${budgetCspr} CSPR`,
      ...catalogTable(catalog),
    ]),
  );
  decisions.append('catalog', {
    count: catalog.length,
    services: catalog.map((e) => ({
      id: e.service.id,
      name: e.service.name,
      priceMotes: e.service.priceMotes,
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
      `chose #${chosen.service.id} "${chosen.service.name}" at ${formatCspr(chosen.service.priceMotes)}`,
      `reason: ${choice.reason}`,
    ]),
  );
  decisions.append('choice', {
    serviceId: chosen.service.id,
    serviceName: chosen.service.name,
    priceMotes: chosen.service.priceMotes,
    reason: choice.reason,
    llm: llm.name,
  });

  // 3. Budget enforcement BEFORE paying: cumulative spend + next price must fit the budget.
  const price = chosen.service.priceMotes;
  const projected = addMotes(spentMotes, price);
  if (compareMotes(projected, budgetMotes) > 0) {
    const refusal =
      `refused: price ${formatCspr(price)} would exceed budget ` +
      `${formatCspr(budgetMotes)} (already spent ${formatCspr(spentMotes)})`;
    print(renderBlock('STEP 3 · BUDGET — REFUSED', [refusal]));
    decisions.append('budget_refusal', {
      serviceId: chosen.service.id,
      priceMotes: price,
      spentMotes,
      budgetMotes,
    });
    logger.warn('budget refusal', { priceMotes: price, budgetMotes });
    return {
      chosenServiceId: chosen.service.id,
      reason: choice.reason,
      paid: false,
      deployHash: null,
      attestationTxHash: null,
      summary: refusal,
      spentMotes: '0',
    };
  }
  print(
    renderBlock('STEP 3 · BUDGET — OK', [
      `price ${formatCspr(price)} fits budget ${formatCspr(budgetMotes)} (spent so far ${formatCspr(spentMotes)})`,
    ]),
  );
  decisions.append('budget_ok', { priceMotes: price, budgetMotes, spentMotes });

  // 4. Pay & consume via the 402 client. maxPriceMotes is bound to the on-chain
  // price the budget gate just approved — NOT the whole remaining budget — so a
  // 402 invoice that quotes more than the advertised price is refused instead of
  // silently charged up to the full budget.
  const client = createAgentGateClient({
    chain,
    signer,
    maxPriceMotes: price,
    logger,
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });

  let result;
  try {
    result = await client.fetchPaid(chosen.service.endpointUrl);
  } catch (err) {
    if (isAgentGateError(err) && err.code === 'PRICE_EXCEEDED') {
      const refusal = `refused: invoice price exceeded remaining budget — ${err.message}`;
      print(renderBlock('STEP 4 · PAYMENT — REFUSED', [refusal]));
      decisions.append('budget_refusal', { serviceId: chosen.service.id, error: err.message });
      return {
        chosenServiceId: chosen.service.id,
        reason: choice.reason,
        paid: false,
        deployHash: null,
        attestationTxHash: null,
        summary: refusal,
        spentMotes: '0',
      };
    }
    decisions.append('error', {
      code: isAgentGateError(err) ? err.code : 'FETCH_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const deployHash = result.deployHash ?? null;
  if (result.paid && result.priceMotes !== undefined) {
    spentMotes = addMotes(spentMotes, result.priceMotes);
  }
  const remainingAfter: Motes = (parseMotes(budgetMotes) - parseMotes(spentMotes)).toString();
  print(
    renderBlock('STEP 4 · PAYMENT', [
      result.paid
        ? `paid ${formatCspr(result.priceMotes ?? '0')} → deploy ${deployHash ?? '?'}`
        : 'no payment was required',
      `upstream status: ${result.status}`,
      `remaining budget: ${motesToCspr(remainingAfter)} CSPR`,
    ]),
  );
  decisions.append('payment', {
    serviceId: chosen.service.id,
    paid: result.paid,
    deployHash,
    priceMotes: result.priceMotes ?? null,
    status: result.status,
    spentMotes,
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

  // 6. Receipt: poll the chain (≤5 s) for the attestation our payment triggered.
  let attestationTxHash: string | null = null;
  if (deployHash !== null) {
    const timeoutMs = opts.attestationTimeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS;
    const pollMs = opts.attestationPollIntervalMs ?? DEFAULT_ATTESTATION_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let found: AttestationRecord | undefined;
    for (;;) {
      const attestations = await chain.listAttestations(chosen.service.id, 50);
      found = attestations.find((a) => a.paymentDeployHash === deployHash);
      if (found !== undefined || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    if (found !== undefined) {
      attestationTxHash = found.recordTxHash;
      print(
        renderBlock('STEP 6 · RECEIPT', [
          `payment deploy: ${deployHash}`,
          `attestation tx: ${found.recordTxHash} (success=${String(found.success)})`,
          `remaining budget: ${motesToCspr(remainingAfter)} CSPR`,
        ]),
      );
    } else {
      print(
        renderBlock('STEP 6 · RECEIPT', [
          `payment deploy: ${deployHash}`,
          `attestation not observed within ${String(timeoutMs)} ms — check the dashboard feed`,
        ]),
      );
    }
    decisions.append('attestation', {
      serviceId: chosen.service.id,
      paymentDeployHash: deployHash,
      attestationTxHash,
      success: found?.success ?? null,
    });
  }

  const report: BuyerRunReport = {
    chosenServiceId: chosen.service.id,
    reason: choice.reason,
    paid: result.paid,
    deployHash,
    attestationTxHash,
    summary,
    spentMotes,
  };
  decisions.append('run_end', { ...report });
  return report;
}
