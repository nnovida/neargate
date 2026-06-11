#!/usr/bin/env -S npx tsx
import { Command } from 'commander';
import { createChainClient } from '@agentgate/chain';
import {
  AgentGateError,
  formatCspr,
  isAgentGateError,
  loadConfig,
  type AgentGateConfig,
  type AnySigner,
} from '@agentgate/shared';
import { createDemoAccounts } from './demo-accounts';
import { listServices } from './list';
import { serviceStatus, STATUS_ATTESTATION_LIMIT } from './status';
import { wrapService } from './wrap';

interface WrapCmdOpts {
  price: string;
  name: string;
  description?: string;
  gateway?: string;
  paymentTarget?: string;
  attestor?: string;
}

/** Seller signer per mode: mock → MOCK_SELLER_ACCOUNT, live → SELLER_SIGNER_PEM_PATH. */
function sellerSigner(config: AgentGateConfig): AnySigner {
  if (config.mode === 'mock') {
    if (config.mockSellerAccount === '') {
      throw new AgentGateError(
        'SIGNER_MISSING',
        'mock mode needs MOCK_SELLER_ACCOUNT — run `agentgate demo-accounts` and paste the printed export lines first',
        400,
      );
    }
    return { kind: 'mock', publicKey: config.mockSellerAccount };
  }
  if (config.sellerSignerPemPath === '') {
    throw new AgentGateError(
      'SIGNER_MISSING',
      'live mode needs SELLER_SIGNER_PEM_PATH pointing at the seller key PEM',
      400,
    );
  }
  return { kind: 'pem', pemPath: config.sellerSignerPemPath };
}

/** Plain monospace table: pads every column to its widest cell. */
function renderTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
    .join('\n');
}

const program = new Command();

program
  .name('agentgate')
  .description('AgentGate — wrap any API into a 402-paywalled, on-chain-registered service');

program
  .command('wrap')
  .description('Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain')
  .argument('<upstreamUrl>', 'upstream API URL to wrap (kept private, only sent to the gateway)')
  .requiredOption('--price <cspr>', 'price per call in CSPR (e.g. 0.5)')
  .requiredOption('--name <name>', 'service name')
  .option('--description <d>', 'service description', '')
  .option('--gateway <url>', 'gateway base URL (default: http://localhost:<MIDDLEWARE_PORT|4021>)')
  .option(
    '--payment-target <accountHash>',
    'payment target account-hash (default: derived from the seller signer)',
  )
  .option(
    '--attestor <publicKeyHex>',
    'public key allowed to record attestations (default: the seller signer public key)',
  )
  .action(async (upstreamUrl: string, opts: WrapCmdOpts) => {
    const config = loadConfig();
    const chain = createChainClient(config);
    const signer = sellerSigner(config);
    const gateway = opts.gateway ?? `http://localhost:${config.middlewarePort}`;
    const result = await wrapService({
      upstreamUrl,
      priceCspr: opts.price,
      name: opts.name,
      description: opts.description,
      gateway,
      paymentTarget: opts.paymentTarget,
      attestor: opts.attestor,
      dashboardBaseUrl: `http://localhost:${config.dashboardPort}`,
      chain,
      signer,
      adminToken: config.adminToken,
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

program
  .command('list')
  .description('List the on-chain service catalog with scores and trust tiers')
  .action(async () => {
    const config = loadConfig();
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
      formatCspr(service.priceMotes),
      tier,
      `${score.successCalls}/${score.totalCalls}`,
      service.active ? 'yes' : 'no',
      service.endpointUrl,
    ]);
    console.log(renderTable(['ID', 'NAME', 'PRICE', 'TIER', 'SCORE', 'ACTIVE', 'ENDPOINT'], rows));
  });

program
  .command('status')
  .description('Show one service: record, score, trust tier and recent attestations')
  .argument('<id>', 'service id')
  .action(async (idRaw: string) => {
    if (!/^\d+$/.test(idRaw.trim())) {
      throw new AgentGateError(
        'INVALID_SERVICE_ID',
        `service id must be a non-negative integer, got ${JSON.stringify(idRaw)}`,
        400,
      );
    }
    const config = loadConfig();
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
    console.log(`price:          ${formatCspr(service.priceMotes)}`);
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
        `  [${a.success ? 'ok  ' : 'FAIL'}] ${when}  payment ${a.paymentDeployHash}  tx ${a.recordTxHash}`,
      );
    }
  });

program
  .command('demo-accounts')
  .description('Create faucet-funded buyer/seller demo accounts on the mock devnet (mock mode only)')
  .action(async () => {
    const config = loadConfig();
    if (config.mode !== 'mock') {
      throw new AgentGateError(
        'MOCK_ONLY',
        'demo-accounts only works in mock mode (set AGENTGATE_MODE=mock)',
        400,
      );
    }
    const result = await createDemoAccounts({ devnetUrl: config.devnetUrl });
    console.log(`buyer:  ${result.buyer.publicKey}  (${formatCspr(result.buyer.balanceMotes)})`);
    console.log(`seller: ${result.seller.publicKey}  (${formatCspr(result.seller.balanceMotes)})`);
    console.log('');
    console.log('# paste into your shell (used by the buyer agent and `agentgate wrap`):');
    for (const line of result.exportLines) {
      console.log(line);
    }
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
