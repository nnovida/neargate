#!/usr/bin/env node
import { Command } from 'commander';
import { createChainClient } from '@agentgate/chain';
import {
  AgentGateError,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_URL,
  formatNear,
  isAgentGateError,
  loadConfig,
  type AgentGateConfig,
  type AnySigner,
  type NearKeySigner,
} from '@agentgate/shared';
import { buyService } from './buy';
import { createDemoAccounts } from './demo-accounts';
import { listServices } from './list';
import { setServiceActive } from './pause';
import { serviceStatus, STATUS_ATTESTATION_LIMIT } from './status';
import { wrapService } from './wrap';
import { startAgentGateMcpServer } from './mcp';
import { resolveCliEnv, type CliConfigFlags } from './cli-env';

interface WrapCmdOpts extends CliConfigFlags {
  price: string;
  name: string;
  description?: string;
  gateway?: string;
  paymentTarget?: string;
  attestor?: string;
}

/**
 * A NEAR key signer for `accountId` carrying whichever key sources are set.
 * TODO(Task 5): resolve keys via @agentgate/chain `loadNearSigner` (D4 order) and add `--account`.
 */
function nearSigner(accountId: string, keyPath: string, secretKey: string): NearKeySigner {
  return {
    kind: 'near',
    accountId,
    ...(keyPath.trim() !== '' ? { keyPath } : {}),
    ...(secretKey.trim() !== '' ? { secretKey } : {}),
  };
}

/** Seller signer per mode: mock → MOCK_SELLER_ACCOUNT, live → SELLER_ACCOUNT_ID + its key. */
function sellerSigner(config: AgentGateConfig): AnySigner {
  if (config.mode === 'mock') {
    if (config.mockSellerAccount === '') {
      throw new AgentGateError(
        'SIGNER_MISSING',
        'mock mode needs MOCK_SELLER_ACCOUNT — run `agentgate demo-accounts` and paste the printed export lines first',
        400,
      );
    }
    return { kind: 'mock', accountId: config.mockSellerAccount };
  }
  if (config.sellerAccountId === '') {
    throw new AgentGateError(
      'SIGNER_MISSING',
      'live mode needs a seller account — set SELLER_ACCOUNT_ID (key: --key-file <path>, SELLER_KEY_PATH or SELLER_PRIVATE_KEY)',
      400,
    );
  }
  return nearSigner(config.sellerAccountId, config.sellerKeyPath, config.sellerPrivateKey);
}

/** Buyer signer per mode: mock → MOCK_BUYER_ACCOUNT, live → BUYER_ACCOUNT_ID + --key-file | BUYER_KEY_PATH | BUYER_PRIVATE_KEY. */
function buyerSigner(config: AgentGateConfig, keyFileFlag?: string): AnySigner {
  if (config.mode === 'mock') {
    if (config.mockBuyerAccount === '') {
      throw new AgentGateError(
        'SIGNER_MISSING',
        'mock mode needs MOCK_BUYER_ACCOUNT — run `agentgate demo-accounts` and paste the printed export lines first',
        400,
      );
    }
    return { kind: 'mock', accountId: config.mockBuyerAccount };
  }
  if (config.buyerAccountId === '') {
    throw new AgentGateError(
      'SIGNER_MISSING',
      'live mode needs a buyer account — set BUYER_ACCOUNT_ID (key: --key-file <path>, BUYER_KEY_PATH or BUYER_PRIVATE_KEY)',
      400,
    );
  }
  const keyPath =
    keyFileFlag !== undefined && keyFileFlag.trim() !== '' ? keyFileFlag : config.buyerKeyPath;
  return nearSigner(config.buyerAccountId, keyPath, config.buyerPrivateKey);
}

/** Plain monospace table: pads every column to its widest cell. */
function renderTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

/** Attach the shared chain-config flags (mode/rpc/registry) to a command. */
function withConfigFlags(cmd: Command): Command {
  return cmd
    .option('--mode <mode>', 'chain mode: mock | live (published CLI defaults to live)')
    .option('--rpc <url>', 'NEAR RPC URL (default: NEAR testnet)')
    .option('--registry <contractId>', 'registry contract id (default: the deployed one)');
}

/**
 * Build runtime config from flags + env. The CLI does not need a strong admin
 * token just to load — read commands run zero-env, and wrap surfaces a
 * token/gateway problem at the admin POST, not at config load.
 */
function cliConfig(opts: CliConfigFlags): AgentGateConfig {
  return loadConfig(
    resolveCliEnv({
      mode: opts.mode,
      rpc: opts.rpc,
      registry: opts.registry,
      keyFile: opts.keyFile,
      adminToken: opts.adminToken,
    }),
    { requireStrongAdminToken: false },
  );
}

const program = new Command();

program
  .name('agentgate')
  .description('AgentGate — wrap any API into a 402-paywalled, on-chain-registered service');

withConfigFlags(
  program
    .command('wrap')
    .description('Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain')
    .argument('<upstreamUrl>', 'upstream API URL to wrap (kept private, only sent to the gateway)')
    .requiredOption('--price <near>', 'price per call in NEAR (e.g. 0.5)')
    .requiredOption('--name <name>', 'service name')
    .option('--description <d>', 'service description', '')
    .option('--gateway <url>', 'gateway base URL (default: http://localhost:<MIDDLEWARE_PORT|4021>)')
    .option(
      '--payment-target <accountId>',
      'account that receives the price (default: the seller account)',
    )
    .option(
      '--attestor <accountId>',
      'account allowed to record attestations (default: the seller account)',
    )
    .option('--key-file <path>', 'seller key file, near-cli credentials JSON (live writes)')
    .option('--admin-token <token>', 'gateway admin bearer token (leaks into shell history/ps)'),
).action(async (upstreamUrl: string, opts: WrapCmdOpts) => {
    const config = cliConfig(opts);
    const chain = createChainClient(config);
    const signer = sellerSigner(config);
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
        config.mode === 'live'
          ? DEFAULT_DASHBOARD_URL
          : `http://localhost:${config.dashboardPort}`,
      chain,
      signer,
      adminToken: config.adminToken,
      mode: config.mode,
      network: chain.network,
      timeoutMs: config.upstreamTimeoutMs,
    });
    console.log(`service id:      ${result.serviceId}`);
    console.log(`public endpoint: ${result.publicUrl}`);
    console.log(`dashboard:       ${result.dashboardUrl}`);
    console.log(`register tx:     ${result.txHash}`);
    if (!result.adminOk) {
      // wrapService already printed the detailed warning + retry curl to stderr.
      console.log('note: gateway upstream mapping FAILED — see the warning above for the retry curl.');
    }
  });

withConfigFlags(
  program
    .command('list')
    .description('List the on-chain service catalog with scores and trust tiers'),
).action(async (opts: CliConfigFlags) => {
    const config = cliConfig(opts);
    const chain = createChainClient(config);
    const listings = await listServices({ chain });
    if (listings.length === 0) {
      console.log(
        'no services registered yet — wrap one with `agentgate wrap <upstreamUrl> --price 0.5 --name "My API"`',
      );
      return;
    }
    const rows = listings.map(({ service, score, tier }) => [
      String(service.id),
      service.name,
      formatNear(service.priceYocto),
      tier,
      `${score.successCalls}/${score.totalCalls}`,
      service.active ? 'yes' : 'no',
      service.endpointUrl,
    ]);
    console.log(renderTable(['ID', 'NAME', 'PRICE', 'TIER', 'SCORE', 'ACTIVE', 'ENDPOINT'], rows));
  });

interface BuyCmdOpts extends CliConfigFlags {
  max?: string;
  method: string;
  body?: string;
  gateway?: string;
}

withConfigFlags(
  program
    .command('buy')
    .description(
      'Buy one call to a service: pay its 402 invoice with a registry `pay` call in NEAR and print the response (body → stdout, payment details → stderr)',
    )
    .argument('<id>', 'service id (see `agentgate list`)')
    .option('--max <near>', 'refuse invoices priced above this many NEAR')
    .option('--method <method>', 'HTTP method for the paid request', 'GET')
    .option('--body <json>', 'JSON request body to send with the paid request')
    .option('--gateway <url>', "gateway base URL (default: the service's on-chain endpoint)")
    .option('--key-file <path>', 'buyer key file (live mode; or set BUYER_KEY_PATH)'),
).action(async (idRaw: string, opts: BuyCmdOpts) => {
  // Service ids are 1-based, matching status/pause/resume.
  if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
      400,
    );
  }
  // The shared --key-file flag means the SELLER key in cliConfig; for buy it is
  // the buyer key, so keep it out of the config env and hand it to buyerSigner.
  const config = cliConfig({ ...opts, keyFile: undefined });
  const chain = createChainClient(config);
  const signer = buyerSigner(config, opts.keyFile);
  const { service, url, result } = await buyService({
    chain,
    signer,
    id: Number(idRaw.trim()),
    method: opts.method,
    ...(opts.max !== undefined ? { maxNear: opts.max } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.gateway !== undefined ? { gateway: opts.gateway } : {}),
  });

  // Payment metadata → stderr so the response body on stdout stays pipeable.
  console.error(`service:  #${service.id} ${service.name}`);
  console.error(`url:      ${url}`);
  if (result.paid) {
    console.error(`paid:     ${formatNear(result.priceYocto ?? service.priceYocto)}`);
    console.error(`payment:  ${result.txHash}`);
    if (config.mode === 'live' && result.txHash !== undefined) {
      console.error(`explorer: ${config.nearExplorerUrl}/txns/${result.txHash}`);
    }
    if (result.settlement !== undefined) {
      const payer = result.settlement.payer !== undefined ? `  (payer ${result.settlement.payer})` : '';
      console.error(`settled:  ${result.settlement.success ? 'ok' : 'FAILED'}${payer}`);
    }
    if (result.status === 402) {
      console.error(
        'warning:  payment sent but the gateway still answered 402 — see the body for the error code',
      );
    }
  } else {
    console.error('paid:     no — the endpoint answered without requiring payment');
  }
  console.error(`status:   ${result.status}`);
  const body = result.body;
  console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
});

withConfigFlags(
  program
    .command('status')
    .description('Show one service: record, score, trust tier and recent attestations')
    .argument('<id>', 'service id'),
).action(async (idRaw: string, opts: CliConfigFlags) => {
    // Service ids are 1-based (matches pause/resume); serviceStatus also enforces id >= 1.
    if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
      throw new AgentGateError(
        'INVALID_SERVICE_ID',
        `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
        400,
      );
    }
    const config = cliConfig(opts);
    const chain = createChainClient(config);
    const { service, score, tier, attestations } = await serviceStatus({
      chain,
      id: Number(idRaw.trim()),
    });
    console.log(
      `service:        #${service.id} ${service.name}${service.active ? '' : '  [INACTIVE]'}`,
    );
    if (service.description !== '') console.log(`description:    ${service.description}`);
    console.log(`endpoint:       ${service.endpointUrl}`);
    console.log(`price:          ${formatNear(service.priceYocto)}`);
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
      console.log(
        `  [${a.success ? 'ok  ' : 'FAIL'}] ${when}  nonce ${a.nonce}  payment ${a.paymentTxHash}`,
      );
    }
  });

/** Shared action for `pause` / `resume`: toggle the on-chain active flag and report. */
async function toggleActive(idRaw: string, active: boolean, opts: CliConfigFlags): Promise<void> {
  if (!/^\d+$/.test(idRaw.trim())) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${JSON.stringify(idRaw)}`,
      400,
    );
  }
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const signer = sellerSigner(config);
  const { txHash, service } = await setServiceActive({
    chain,
    signer,
    id: Number(idRaw.trim()),
    active,
  });
  console.log(`service:       #${service.id} ${service.name}`);
  console.log(`active:        ${service.active ? 'yes' : 'no (paused)'}`);
  console.log(`set_active tx: ${txHash}`);
}

withConfigFlags(
  program
    .command('pause')
    .description('Pause a service you own: set_active(false) on-chain, the paywall answers 403')
    .argument('<id>', 'service id')
    .option('--key-file <path>', 'seller key file, near-cli credentials JSON (live writes)'),
).action(async (idRaw: string, opts: CliConfigFlags) => toggleActive(idRaw, false, opts));

withConfigFlags(
  program
    .command('resume')
    .description('Resume a paused service you own: set_active(true) on-chain, calls flow again')
    .argument('<id>', 'service id')
    .option('--key-file <path>', 'seller key file, near-cli credentials JSON (live writes)'),
).action(async (idRaw: string, opts: CliConfigFlags) => toggleActive(idRaw, true, opts));

withConfigFlags(
  program
    .command('demo-accounts')
    .description('Create faucet-funded buyer/seller demo accounts on the mock devnet (mock mode only)'),
).action(async (opts: CliConfigFlags) => {
    const config = cliConfig(opts);
    if (config.mode !== 'mock') {
      throw new AgentGateError(
        'MOCK_ONLY',
        'demo-accounts only works in mock mode (set AGENTGATE_MODE=mock)',
        400,
      );
    }
    const result = await createDemoAccounts({
      devnetUrl: config.devnetUrl,
      timeoutMs: config.upstreamTimeoutMs,
    });
    console.log(`buyer:  ${result.buyer.accountId}  (${formatNear(result.buyer.balanceYocto)})`);
    console.log(`seller: ${result.seller.accountId}  (${formatNear(result.seller.balanceYocto)})`);
    console.log('');
    console.log('# paste into your shell (used by the buyer agent and `agentgate wrap`):');
    for (const line of [...result.exportLines, ...result.publicKeyLines]) {
      console.log(line);
    }
  });

withConfigFlags(
  program
    .command('mcp')
    .description(
      'Serve AgentGate as an MCP (Model Context Protocol) stdio server — any MCP-capable agent gets AgentGate discover/inspect/buy tools (run via `npx @neargate/cli mcp`)',
    )
    .option(
      '--key-file <path>',
      'buyer key file for the agentgate_buy tool (live mode; or set BUYER_KEY_PATH)',
    ),
).action(async (opts: CliConfigFlags) => {
  // stdio is the MCP JSON-RPC channel — never write to stdout here. The server
  // stays alive until the client closes stdin.
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  await startAgentGateMcpServer({
    chain,
    signerProvider: () => buyerSigner(config, opts.keyFile),
  });
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = isAgentGateError(err)
    ? `${err.code}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
