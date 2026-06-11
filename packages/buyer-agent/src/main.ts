/**
 * CLI entry for `npm run agent -- --task "..." [--budget 5]` (root forwarder, SPEC §8).
 * Builds its dependencies from loadConfig() + createChainClient() and runs the loop once.
 */
import { createLogger, csprToMotes, isAgentGateError, loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';
import { AnthropicLlm, MockLlm, defaultBuyerSigner, runBuyerAgent } from './index';
import type { LlmClient } from './index';

const USAGE = 'usage: npm run agent -- --task "<task>" [--budget <cspr>]';

function parseArgs(argv: string[]): { task: string; budgetCspr?: string } {
  let task = '';
  let budgetCspr: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--task') {
      task = argv[++i] ?? '';
    } else if (arg.startsWith('--task=')) {
      task = arg.slice('--task='.length);
    } else if (arg === '--budget') {
      budgetCspr = argv[++i];
    } else if (arg.startsWith('--budget=')) {
      budgetCspr = arg.slice('--budget='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }
  if (task.trim() === '') {
    console.error(USAGE);
    process.exit(2);
  }
  if (budgetCspr !== undefined) {
    try {
      csprToMotes(budgetCspr);
    } catch {
      console.error(`--budget must be a CSPR decimal string (e.g. "5" or "0.5"), got "${budgetCspr}"`);
      process.exit(2);
    }
  }
  return budgetCspr !== undefined ? { task, budgetCspr } : { task };
}

async function main(): Promise<void> {
  const { task, budgetCspr } = parseArgs(process.argv.slice(2));
  const logger = createLogger('buyer-agent');

  const config = loadConfig();
  const chain = createChainClient(config);
  const signer = defaultBuyerSigner(config);
  const llm: LlmClient =
    config.anthropicApiKey !== ''
      ? new AnthropicLlm({ apiKey: config.anthropicApiKey, model: config.llmModel, logger })
      : new MockLlm();
  logger.info('buyer agent starting', {
    mode: config.mode,
    llm: llm.name,
    budgetCspr: budgetCspr ?? config.buyerBudgetCspr,
  });

  const report = await runBuyerAgent({
    task,
    ...(budgetCspr !== undefined ? { budgetCspr } : {}),
    chain,
    signer,
    llm,
    logger,
    config,
  });

  if (!report.paid && report.deployHash === null && report.summary.startsWith('refused')) {
    // Budget refusal is a clean, intentional stop — exit 0 with the refusal already printed.
    logger.info('run finished: refused within budget policy');
  } else {
    logger.info('run finished', {
      serviceId: report.chosenServiceId,
      deployHash: report.deployHash,
      attestationTxHash: report.attestationTxHash,
      spentMotes: report.spentMotes,
    });
  }
}

main().catch((err: unknown) => {
  if (isAgentGateError(err)) {
    console.error(`[${err.code}] ${err.message}`);
  } else {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  process.exit(1);
});
