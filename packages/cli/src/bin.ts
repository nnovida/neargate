#!/usr/bin/env node
import { Command } from 'commander';
import type { GaslessWait } from '@agentgate/client';
import { LiveNearClient, createChainClient } from '@agentgate/chain';
import {
  AgentGateError,
  DEFAULT_DASHBOARD_URL,
  formatError,
  formatNear,
  formatPriceWithStorage,
  loadConfig,
  type AgentGateConfig,
} from '@agentgate/shared';
import { addAgentKey, assertAgentKeysAvailable, formatAgentKeyAdded } from './agent-key';
import { buyService, formatBuyBody, formatBuyReceipt, formatGaslessWait } from './buy';
import { createDemoAccounts } from './demo-accounts';
import {
  balanceAccountArg,
  depositToEscrow,
  escrowBalance,
  formatEscrowBalance,
  formatEscrowChange,
  withdrawFromEscrow,
} from './escrow';
import { cliAccountId, cliSigner, type SignerFlags } from './identity';
import { formatServiceTable, listServices } from './list';
import { adminRetryCurl, mapLiveOnlyError, mapService } from './map';
import { setServiceActive } from './pause';
import { serviceStatus, STATUS_ATTESTATION_LIMIT } from './status';
import { parseServiceIdArg } from './validate';
import { resolveWrapGateway, wrapService } from './wrap';
import { startAgentGateMcpServer } from './mcp';
import { resolveCliEnv, type CliConfigFlags } from './cli-env';
import { CLI_VERSION } from './version';

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

/** The explorer link settings the receipts print: only live mode has an explorer. */
function explorerOf(config: AgentGateConfig): { explorerUrl?: string } {
  return config.mode === 'live' ? { explorerUrl: config.nearExplorerUrl } : {};
}

const program = new Command();

program
  .name('neargate')
  .description('NearGate — wrap any API into an x402 service paid in NEAR, registered on-chain')
  .version(CLI_VERSION, '-V, --version', 'print the neargate version');

withConfigFlags(
  withSignerFlags(
    program
      .command('wrap')
      .description('Wrap an upstream API behind the NearGate 402 paywall and register it on-chain')
      .argument('<upstreamUrl>', 'upstream API URL to wrap (kept private, only sent to the gateway)')
      .requiredOption('--price <near>', 'price per call in NEAR (e.g. 0.5; buyers also attach a 0.002 NEAR storage fee)')
      .requiredOption('--name <name>', 'service name (at most 64 bytes)')
      .option('--description <d>', 'service description (at most 280 bytes)', '')
      .option('--gateway <url>', 'gateway base URL (default in live mode: the hosted gateway; in mock: http://localhost:<MIDDLEWARE_PORT|4021>)')
      .option('--payment-target <accountId>', 'account that receives the price (default: the seller account)')
      .option('--attestor <accountId>', 'account allowed to record attestations (default: the seller account; behind a live gateway, name its GATEWAY_ACCOUNT_ID)')
      .option('--admin-token <token>', 'gateway admin bearer token, mock mode (leaks into shell history/ps)'),
    'seller',
  ),
).action(async (upstreamUrl: string, opts: WrapCmdOpts) => {
  const config = cliConfig(opts);
  // Settled before the chain client or the key: a live wrap with no gateway must not get that far.
  const gateway = resolveWrapGateway({
    flag: opts.gateway,
    mode: config.mode,
    middlewarePort: config.middlewarePort,
  });
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'seller', signerFlags(opts));
  const result = await wrapService({
    upstreamUrl,
    priceNear: opts.price,
    name: opts.name,
    description: opts.description,
    gateway,
    paymentTarget: opts.paymentTarget,
    attestor: opts.attestor,
    // Empty (live, a build with no hosted dashboard) means no link is printed.
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
  if (result.dashboardUrl !== null) console.log(`dashboard:       ${result.dashboardUrl}`);
  console.log(`register tx:     ${result.txHash}`);
  if (!result.adminOk) {
    // wrapService already printed the detailed warning (and the retry) to stderr.
    console.log('note: gateway upstream mapping FAILED — see the warning above for the retry.');
  }
});

withConfigFlags(
  withSignerFlags(
    program
      .command('map')
      .description(
        'Retry only the gateway mapping of a service you own (live mode): re-sends the signed self-map POST of `wrap`, never registers again',
      )
      .argument('<id>', 'service id (the one `wrap` registered)')
      .argument('<upstreamUrl>', 'upstream API URL to map (kept private, only sent to the gateway)'),
    'seller',
  ),
).action(async (idRaw: string, upstreamUrl: string, opts: CliConfigFlags & SignerFlags) => {
  const id = parseServiceIdArg(idRaw);
  const config = cliConfig(opts);
  if (config.mode !== 'live') {
    // Mock gateways map through the admin route: say so, with the exact retry.
    const adminUrl = `http://localhost:${config.middlewarePort}/admin/services`;
    throw mapLiveOnlyError(adminRetryCurl(adminUrl, id, upstreamUrl.trim()));
  }
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'seller', signerFlags(opts));
  const result = await mapService({
    serviceId: id,
    upstreamUrl,
    chain,
    signer,
    mode: config.mode,
    nearNetwork: config.nearNetwork,
    timeoutMs: config.upstreamTimeoutMs,
  });
  console.log(`service id:      ${result.serviceId}`);
  console.log(`gateway:         ${result.gateway}`);
  console.log(`public endpoint: ${result.publicUrl}`);
  console.log('mapping:         ok');
});

withConfigFlags(
  program.command('list').description('List the on-chain service catalog with scores and trust tiers'),
).action(async (opts: CliConfigFlags) => {
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const listings = await listServices({ chain });
  // stdout always carries the table, header line included (scripts parse it); the hint goes to stderr.
  console.log(formatServiceTable(listings));
  if (listings.length === 0) {
    console.error('no services registered yet — wrap one with `neargate wrap <upstreamUrl> --price 0.5 --name "My API"`');
  }
});

interface BuyCmdOpts extends CliConfigFlags, SignerFlags {
  max?: string;
  method: string;
  body?: string;
  gateway?: string;
  fromEscrow?: boolean;
  gasless?: boolean;
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
      .option('--gateway <url>', "gateway base URL (default: the service's on-chain endpoint)")
      .option(
        '--from-escrow',
        'pay out of the prepaid escrow (`pay_from_escrow`, nothing attached) instead of attaching a deposit; the escrow must hold price + 0.002 NEAR',
      )
      .option(
        '--gasless',
        'implies --from-escrow: sign `pay_from_escrow` as a NEP-366 delegate that the gateway relays and pays the gas for (its 402 must offer a relayer)',
      ),
    'buyer',
  ),
).action(async (idRaw: string, opts: BuyCmdOpts) => {
  const id = parseServiceIdArg(idRaw);
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'buyer', signerFlags(opts));
  const explorer = explorerOf(config);
  const bought = await buyService({
    chain,
    signer,
    id,
    method: opts.method,
    ...(opts.max !== undefined ? { maxNear: opts.max } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.gateway !== undefined ? { gateway: opts.gateway } : {}),
    ...(opts.fromEscrow === true ? { fromEscrow: true } : {}),
    ...(opts.gasless === true
      ? {
          gasless: true,
          ...explorer,
          escrowBalanceHint: '`neargate escrow balance`',
          // One progress line on stderr while the relay settles; stdout stays the body's.
          onGaslessWait: (wait: GaslessWait) => {
            if (wait.attempt === 1) console.error(formatGaslessWait(wait, explorer));
          },
        }
      : {}),
  });

  // The receipt → stderr so the response body on stdout stays pipeable.
  for (const line of formatBuyReceipt(bought, explorer)) console.error(line);
  console.log(formatBuyBody(bought.result.body));
});

withConfigFlags(
  program
    .command('status')
    .description('Show one service: record, score, trust tier and recent attestations')
    .argument('<id>', 'service id'),
).action(async (idRaw: string, opts: CliConfigFlags) => {
  const id = parseServiceIdArg(idRaw);
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
  const id = parseServiceIdArg(idRaw);
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

const escrowCommand = program
  .command('escrow')
  .description(
    'Prepaid escrow in the registry: fund it, read it, take it back; `buy --from-escrow` and restricted agent keys spend it',
  );

/** Shared action for `escrow deposit` / `escrow withdraw`: move the amount and report the escrow. */
async function escrowChange(
  kind: 'deposit' | 'withdraw',
  amountNear: string,
  opts: CliConfigFlags & SignerFlags,
): Promise<void> {
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = await cliSigner(config, 'buyer', signerFlags(opts));
  const move = kind === 'deposit' ? depositToEscrow : withdrawFromEscrow;
  const result = await move({ chain, signer, amountNear });
  for (const line of formatEscrowChange(kind, result, explorerOf(config))) console.log(line);
}

withConfigFlags(
  withSignerFlags(
    escrowCommand
      .command('deposit')
      .description(
        'Deposit NEAR into your escrow (`deposit_escrow`). The first deposit must be more than 0.002 NEAR, which the registry keeps as the escrow entry\'s storage fee',
      )
      .argument('<near>', 'amount in NEAR (e.g. 1)'),
    'buyer',
  ),
).action(async (amountNear: string, opts: CliConfigFlags & SignerFlags) => escrowChange('deposit', amountNear, opts));

withConfigFlags(
  withSignerFlags(
    escrowCommand
      .command('withdraw')
      .description(
        'Withdraw NEAR from your escrow back to your account (`withdraw_escrow`, 1 yocto attached: needs the account\'s full-access key, not an agent key)',
      )
      .argument('<near>', 'amount in NEAR (at most the escrow balance)'),
    'buyer',
  ),
).action(async (amountNear: string, opts: CliConfigFlags & SignerFlags) => escrowChange('withdraw', amountNear, opts));

withConfigFlags(
  escrowCommand
    .command('balance')
    .description('Show an account\'s escrow balance (no key needed)')
    .argument('[account]', 'NEAR account id (default: the buyer account)')
    .option('--account <id>', 'same as [account] (env BUYER_ACCOUNT_ID; mock: MOCK_BUYER_ACCOUNT)'),
).action(async (account: string | undefined, opts: CliConfigFlags & SignerFlags) => {
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const result = await escrowBalance({
    chain,
    account: balanceAccountArg(account, opts.account) ?? cliAccountId(config, 'buyer'),
  });
  for (const line of formatEscrowBalance(result)) console.log(line);
});

const agentKeyCommand = program
  .command('agent-key')
  .description('Restricted keys for AI agents: a NEAR function-call key that can only spend your escrow (live mode only)');

withConfigFlags(
  withSignerFlags(
    agentKeyCommand
      .command('add')
      .description(
        'Add a new function-call key to your account that may call only `pay_from_escrow` on the registry. The secret is written to ~/.near-credentials/<network>/<account>.neargate-agent.json (mode 0600, never overwritten); only the public key and the path are printed',
      )
      .requiredOption('--allowance <near>', 'gas the agent key may spend, in NEAR (e.g. 0.25); the escrow is its spending limit'),
    'buyer',
  ),
).action(async (opts: CliConfigFlags & SignerFlags & { allowance: string }) => {
  const config = cliConfig(opts);
  assertAgentKeysAvailable(config.mode);
  const client = new LiveNearClient(config);
  // The account's own full-access key signs the AddKey: --key-file here is that key, not the agent's.
  const signer = await cliSigner(config, 'buyer', signerFlags(opts));
  const added = await addAgentKey({ client, signer, allowanceNear: opts.allowance, network: config.nearNetwork });
  for (const line of formatAgentKeyAdded(added, explorerOf(config))) console.log(line);
});

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
    ...explorerOf(config),
  });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`error: ${formatError(err)}`);
  process.exit(1);
});
