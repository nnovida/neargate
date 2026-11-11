/**
 * scripts/near/smoke-live.ts — `npm run smoke:live`: a read-only check of the live deployment.
 *
 *   1. list      the registry's services (a view)
 *   2. status    one service: record, score, trust tier, recent attestations (views)
 *   3. invoice   one unpaid GET on the gateway the registry points at: it must answer 402 with
 *                a valid NEAR invoice for that service. Nothing is paid, nothing is signed.
 *
 * Exits 0 when every check passes. On an empty registry (no service yet, none asked for by id)
 * only the list check can run: that still proves the contract is deployed and readable, and it
 * says so. A failure prints `smoke failed: …` to stderr and exits 1.
 *
 * Reads the root `.env` (see .env.example): AGENTGATE_MODE=live and REGISTRY_CONTRACT_ID, plus
 * optionally SMOKE_SERVICE_ID (default 1; naming one makes a missing service an error),
 * GATEWAY_PUBLIC_URL (request the invoice there instead of at the gateway the registry
 * records) and SMOKE_ALLOW_LOCAL_GATEWAY=1 (dev-only: allow a loopback gateway).
 */
import { pathToFileURL } from 'node:url';
import { createChainClient } from '@agentgate/chain';
import { assertFetchableUrl, parsePaymentRequired, refuseRedirect } from '@agentgate/client';
import { formatServiceTable, listServices, serviceStatus } from '@neargate/cli';
import {
  AgentGateError,
  formatError,
  formatPriceWithStorage,
  loadConfig,
  stripTrailingSlashes,
  type ChainClient,
} from '@agentgate/shared';
import { loadDotenv } from './dotenv';

export interface SmokeOptions {
  chain: ChainClient;
  /** The service to check (1-based). */
  serviceId: number;
  /** An empty registry passes as a list-only check (true), or fails SERVICE_NOT_FOUND (false). */
  allowEmptyRegistry: boolean;
  /** Request the invoice at `<gatewayUrl>/svc/<id>` instead of the service's registered endpoint. */
  gatewayUrl?: string;
  /** Refuse a private/loopback gateway host (the live default). */
  rejectPrivateHosts: boolean;
  fetchImpl?: typeof fetch;
  /** Timeout of the invoice request (ms). Default 15000. */
  requestTimeoutMs?: number;
  log: (line: string) => void;
}

export interface SmokeResult {
  /** How many services the registry lists. */
  services: number;
  /** false when only the list check could run (empty registry). */
  checked: boolean;
}

function smokeFailed(message: string): AgentGateError {
  return new AgentGateError('SMOKE_FAILED', message, 502);
}

/** Requests an unpaid invoice and returns the parsed NEAR requirements; throws on anything but a valid 402. */
async function requestInvoice(
  url: string,
  chain: ChainClient,
  serviceId: number,
  opts: Pick<SmokeOptions, 'fetchImpl' | 'rejectPrivateHosts' | 'requestTimeoutMs'>,
) {
  await assertFetchableUrl(url, { rejectPrivateHosts: opts.rejectPrivateHosts });
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 15_000),
    });
  } catch (err) {
    throw smokeFailed(`the gateway did not answer ${url}: ${formatError(err)}`);
  }
  await refuseRedirect(url, res);
  const text = await res.text();
  if (res.status !== 402) {
    throw smokeFailed(
      `the gateway answered HTTP ${res.status} for ${url}, expected a 402 invoice: ${text.slice(0, 200)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw smokeFailed(`the 402 from ${url} is not JSON`);
  }
  const invoice = parsePaymentRequired(body, chain.network);
  if (invoice.payTo !== chain.registryId) {
    throw smokeFailed(`the invoice pays ${invoice.payTo}, not the registry ${chain.registryId}`);
  }
  if (invoice.extra.serviceId !== serviceId) {
    throw smokeFailed(`the invoice is for service ${invoice.extra.serviceId}, not ${serviceId}`);
  }
  return invoice;
}

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  const { chain, serviceId, log } = opts;
  log(`network ${chain.network}  registry ${chain.registryId}`);

  // 1. list
  const listings = await listServices({ chain });
  log(`list: ${listings.length} service(s)`);
  if (listings.length > 0) log(formatServiceTable(listings));
  if (listings.length === 0 && opts.allowEmptyRegistry) {
    log('no service registered yet: the status and invoice checks are skipped (run `npm run near:seed` first)');
    log('smoke ok (list only)');
    return { services: 0, checked: false };
  }

  // 2. status
  const { service, score, tier, attestations } = await serviceStatus({ chain, id: serviceId });
  log(
    `status #${service.id}: ${service.name}  ${service.active ? 'active' : 'paused'}  ` +
      `score ${score.successCalls}/${score.totalCalls} (${tier})  ${attestations.length} recent attestation(s)`,
  );

  // 3. one 402 invoice from the gateway
  const url =
    opts.gatewayUrl !== undefined
      ? `${stripTrailingSlashes(opts.gatewayUrl)}/svc/${serviceId}`
      : service.endpointUrl;
  const invoice = await requestInvoice(url, chain, serviceId, opts);
  log(`402 invoice: ${formatPriceWithStorage(invoice.extra.priceYocto, invoice.extra.storageFeeYocto)} from ${url}`);
  log('smoke ok');
  return { services: listings.length, checked: true };
}

function envServiceId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const id = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(id) || id < 1) {
    throw new AgentGateError('CONFIG_INVALID', `SMOKE_SERVICE_ID must be a positive integer, got ${JSON.stringify(raw)}`, 500);
  }
  return id;
}

async function main(): Promise<void> {
  loadDotenv();
  // The smoke test never calls the admin API, so the admin token is not required.
  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  if (config.mode !== 'live') {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'AGENTGATE_MODE is not "live": set it (and REGISTRY_CONTRACT_ID) in .env. `npm run demo` is the offline loop.',
      500,
    );
  }
  const chain = createChainClient(config);
  const serviceId = envServiceId(process.env['SMOKE_SERVICE_ID']);
  const gatewayUrl = process.env['GATEWAY_PUBLIC_URL']?.trim();
  await runSmoke({
    chain,
    serviceId: serviceId ?? 1,
    allowEmptyRegistry: serviceId === undefined,
    ...(gatewayUrl !== undefined && gatewayUrl !== '' ? { gatewayUrl } : {}),
    rejectPrivateHosts: process.env['SMOKE_ALLOW_LOCAL_GATEWAY'] !== '1',
    log: (line) => console.log(line),
  });
}

// Run only as a script (`tsx scripts/near/smoke-live.ts`), never when a test imports runSmoke.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`smoke failed: ${formatError(err)}`);
    process.exit(1);
  });
}
