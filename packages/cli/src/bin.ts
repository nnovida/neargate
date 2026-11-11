#!/usr/bin/env node
import { Command } from 'commander';
import { createChainClient } from '@agentgate/chain';
import {
  AgentGateError,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_URL,
  formatNear,
  formatPriceWithStorage,
  isAgentGateError,
  loadConfig,
  type AgentGateConfig,
} from '@agentgate/shared';
import { buyService, formatBuyBody, formatBuyReceipt } from './buy';
import { createDemoAccounts } from './demo-accounts';
import { cliSigner, type SignerFlags } from './identity';
import { formatServiceTable, listServices } from './list';
import { setServiceActive } from './pause';
import { serviceStatus, STATUS_ATTESTATION_LIMIT } from './status';
import { wrapService } from './wrap';
import { startAgentGateMcpServer } from './mcp';
import { resolveCliEnv, type CliConfigFlags } from './cli-env';

interface WrapCmdOpts extends CliConfigFlags, SignerFlags {
  price: string;
  name: string;
  description?: string;
  gateway?: string;
  paymentTarget?: string;
  attestor?: string;
}

/** Attach the shared chain-config flags (mode/rpc/registry) to a command. */
function withConfigFlags(cmd: Command): Command {
  return cmd
    .option('--mode <mode>', 'chain mode: mock | live (published CLI defaults to live)')
    .option('--rpc <url>', 'NEAR RPC URL (default: NEAR testnet; env NEAR_RPC_URL)')
    .option('--registry <contractId>', 'registry contract id (env REGISTRY_CONTRACT_ID)');
}

/** Attach the signer flags; `role` names whose account they select in the help text. */
function withSignerFlags(cmd: Command, role: 'seller' | 'buyer'): Command {
  const upper = role.toUpperCase();
  return cmd
    .option('--account <id>', `${role} NEAR account (env ${upper}_ACCOUNT_ID; mock: MOCK_${upper}_ACCOUNT)`)
    .option(
      '--key-file <path>',
      `${role} key, near-cli credentials JSON (env ${upper}_KEY_PATH; ${upper}_PRIVATE_KEY wins; default ~/.near-credentials/<network>/<account>.json)`,
    );
}

/** The signer flags of a parsed command. */
function signerFlags(opts: SignerFlags): SignerFlags {
  return {
    ...(opts.account !== undefined ? { account: opts.account } : {}),
    ...(opts.keyFile !== undefined ? { keyFile: opts.keyFile } : {}),
  };
}

/** A positive integer service id from argv. */
function parseServiceId(idRaw: string): number {
  if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
      400,
    );
  }
  return Number(idRaw.trim());
}

/**
 * Build runtime config from flags + env. The CLI does not need a strong admin
 * token just to load — read commands run zero-env, and wrap surfaces a
 * token/gateway problem at the mapping POST, not at config load.
 */
function cliConfig(opts: CliConfigFlags): AgentGateConfig {
  return loadConfig(
    resolveCliEnv({
      mode: opts.mode,
      rpc: opts.rpc,
      registry: opts.registry,
      adminToken: opts.adminToken,
    }),
    { requireStrongAdminToken: false },
  );
}

const program = new Command();

program
  .name('neargate')
  .description('NearGate — wrap any API into an x402 service paid in NEAR, registered on-chain');

withConfigFlags(
  withSignerFlags(
    program
      .command('wrap')
      .description('Wrap an upstream API behind the NearGate 402 paywall and register it on-chain')
      .argument('<upstreamUrl>', 'upstream API URL to wrap (kept private, only sent to the gateway)')
      .requiredOption('--price <near>', 'price per call in NEAR (e.g. 0.5; buyers also attach a 0.002 NEAR storage fee)')
      .requiredOption('--name <name>', 'service name (at most 64 bytes)')
      .option('--description <d>', 'service description (at most 280 bytes)', '')
      .option('--gateway <url>', 'gateway base URL (default: the hosted gateway in live, http://localhost:<MIDDLEWARE_PORT|4021> in mock)')
      .option('--payment-target <accountId>', 'account that receives the price (default: the seller account)')
      .option('--attestor <accountId>', 'account allowed to record attestations (default: the seller account)')
      .option('--admin-token <token>', 'gateway admin bearer token, mock mode (leaks into shell history/ps)'),
    'seller',
  ),
).action(async (upstreamUrl: string, opts: WrapCmdOpts) => {
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'seller', signerFlags(opts));
  const gateway =
    opts.gateway ??
    (config.mode === 'live' ? DEFAULT_GATEWAY_URL : `http://localhost:${config.middlewarePort}`);
  const result = await wrapService({
    upstreamUrl,
    priceNear: opts.price,
    name: opts.name,
    description: opts.description,
    gateway,
    paymentTarget: opts.paymentTarget,
    attestor: opts.attestor,
    dashboardBaseUrl:
      config.mode === 'live' ? DEFAULT_DASHBOARD_URL : `http://localhost:${config.dashboardPort}`,
    chain,
    signer,
    adminToken: config.adminToken,
    mode: config.mode,
    network: chain.network,
    nearNetwork: config.nearNetwork,
    timeoutMs: config.upstreamTimeoutMs,
  });
  console.log(`service id:      ${result.serviceId}`);
  console.log(`public endpoint: ${result.publicUrl}`);
  console.log(`dashboard:       ${result.dashboardUrl}`);
  console.log(`register tx:     ${result.txHash}`);
  if (!result.adminOk) {
    // wrapService already printed the detailed warning to stderr.
    console.log('note: gateway upstream mapping FAILED — see the warning above.');
  }
});

withConfigFlags(
  program.command('list').description('List the on-chain service catalog with scores and trust tiers'),
).action(async (opts: CliConfigFlags) => {
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const listings = await listServices({ chain });
  if (listings.length === 0) {
    console.log('no services registered yet — wrap one with `neargate wrap <upstreamUrl> --price 0.5 --name "My API"`');
    return;
  }
  console.log(formatServiceTable(listings));
});

interface BuyCmdOpts extends CliConfigFlags, SignerFlags {
  max?: string;
  method: string;
  body?: string;
  gateway?: string;
}

withConfigFlags(
  withSignerFlags(
    program
      .command('buy')
      .description(
        'Buy one call to a service: pay its 402 invoice with a registry `pay` call in NEAR and print the response (body → stdout, receipt → stderr)',
      )
      .argument('<id>', 'service id (see `neargate list`)')
      .option('--max <near>', 'budget cap in NEAR on the total attached (price + 0.002 NEAR storage)')
      .option('--method <method>', 'HTTP method for the paid request', 'GET')
      .option('--body <json>', 'JSON request body to send with the paid request')
      .option('--gateway <url>', "gateway base URL (default: the service's on-chain endpoint)"),
    'buyer',
  ),
).action(async (idRaw: string, opts: BuyCmdOpts) => {
  const id = parseServiceId(idRaw);
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'buyer', signerFlags(opts));
  const bought = await buyService({
    chain,
    signer,
    id,
    method: opts.method,
    ...(opts.max !== undefined ? { maxNear: opts.max } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.gateway !== undefined ? { gateway: opts.gateway } : {}),
  });

  // The receipt → stderr so the response body on stdout stays pipeable.
  const explorer = config.mode === 'live' ? { explorerUrl: config.nearExplorerUrl } : {};
  for (const line of formatBuyReceipt(bought, explorer)) console.error(line);
  console.log(formatBuyBody(bought.result.body));
});

withConfigFlags(
  program
    .command('status')
    .description('Show one service: record, score, trust tier and recent attestations')
    .argument('<id>', 'service id'),
).action(async (idRaw: string, opts: CliConfigFlags) => {
  const id = parseServiceId(idRaw);
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const { service, score, tier, attestations } = await serviceStatus({ chain, id });
  console.log(`service:        #${service.id} ${service.name}${service.active ? '' : '  [INACTIVE]'}`);
  if (service.description !== '') console.log(`description:    ${service.description}`);
  console.log(`endpoint:       ${service.endpointUrl}`);
  console.log(`price:          ${formatPriceWithStorage(service.priceYocto)}`);
  console.log(`payment target: ${service.paymentTarget}`);
  console.log(`owner:          ${service.owner}`);
  console.log(`attestor:       ${service.attestor}`);
  console.log(`trust:          ${tier} (${score.successCalls}/${score.totalCalls} calls ok)`);
  if (attestations.length === 0) {
    console.log('attestations:   none yet');
    return;
  }
  console.log(`attestations (latest ${STATUS_ATTESTATION_LIMIT}):`);
  for (const a of attestations) {
    const when = new Date(a.timestamp).toISOString();
    console.log(`  [${a.success ? 'ok  ' : 'FAIL'}] ${when}  nonce ${a.nonce}  payment ${a.paymentTxHash}`);
  }
});

/** Shared action for `pause` / `resume`: toggle the on-chain active flag and report. */
async function toggleActive(idRaw: string, active: boolean, opts: CliConfigFlags & SignerFlags): Promise<void> {
  const id = parseServiceId(idRaw);
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'seller', signerFlags(opts));
  const { txHash, service } = await setServiceActive({ chain, signer, id, active });
  console.log(`service:       #${service.id} ${service.name}`);
  console.log(`active:        ${service.active ? 'yes' : 'no (paused)'}`);
  console.log(`set_active tx: ${txHash}`);
}

withConfigFlags(
  withSignerFlags(
    program
      .command('pause')
      .description('Pause a service you own: set_active(false) on-chain, the paywall answers 403')
      .argument('<id>', 'service id'),
    'seller',
  ),
).action(async (idRaw: string, opts: CliConfigFlags & SignerFlags) => toggleActive(idRaw, false, opts));

withConfigFlags(
  withSignerFlags(
    program
      .command('resume')
      .description('Resume a paused service you own: set_active(true) on-chain, calls flow again')
      .argument('<id>', 'service id'),
    'seller',
  ),
).action(async (idRaw: string, opts: CliConfigFlags & SignerFlags) => toggleActive(idRaw, true, opts));

withConfigFlags(
  program
    .command('demo-accounts')
    .description('Create faucet-funded buyer/seller demo accounts on the mock devnet (mock mode only)'),
).action(async (opts: CliConfigFlags) => {
  const config = cliConfig(opts);
  if (config.mode !== 'mock') {
    throw new AgentGateError('MOCK_ONLY', 'demo-accounts only works in mock mode (--mode mock or AGENTGATE_MODE=mock)', 400);
  }
  const result = await createDemoAccounts({ devnetUrl: config.devnetUrl, timeoutMs: config.upstreamTimeoutMs });
  console.log(`buyer:  ${result.buyer.accountId}  (${formatNear(result.buyer.balanceYocto)})`);
  console.log(`seller: ${result.seller.accountId}  (${formatNear(result.seller.balanceYocto)})`);
  console.log('');
  console.log('# paste into your shell (used by the buyer agent and `neargate wrap`):');
  for (const line of [...result.exportLines, ...result.publicKeyLines]) {
    console.log(line);
  }
});

withConfigFlags(
  withSignerFlags(
    program
      .command('mcp')
      .description(
        'Serve NearGate as an MCP (Model Context Protocol) stdio server — any MCP-capable agent gets NearGate discover/inspect/buy tools',
      ),
    'buyer',
  ),
).action(async (opts: CliConfigFlags & SignerFlags) => {
  // stdio is the MCP JSON-RPC channel — never write to stdout here. The server
  // stays alive until the client closes stdin.
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const flags = signerFlags(opts);
  await startAgentGateMcpServer({
    chain,
    signerProvider: () => cliSigner(config, 'buyer', flags),
  });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = isAgentGateError(err)
    ? err.message.startsWith(err.code)
      ? err.message
      : `${err.code}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
