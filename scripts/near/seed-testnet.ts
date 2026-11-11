/**
 * scripts/near/seed-testnet.ts — `npm run near:seed`: one real register → pay → attest triple
 * on NEAR testnet, through the same library calls `neargate wrap` and `neargate buy` use.
 *
 *   1. the seller wraps a PUBLIC upstream at 0.01 NEAR: `register_service` on the registry,
 *      then the signed self-map at the running gateway (the live SSRF guard refuses localhost
 *      upstreams, so the default is https://open.er-api.com/v6/latest/USD)
 *   2. the buyer buys one call: 402 invoice → registry `pay` (price + 0.002 NEAR storage) → proof
 *   3. the gateway attests the served call; this script polls `GET <gateway>/receipts/<nonce>`
 *      until the attestation is recorded (a live activity feed cannot name its own tx)
 *   4. prints `registered service #<id>`, `paid: tx …`, `attested: tx …`, `score <s>/<t>` and
 *      an explorer link under each tx
 *
 * It needs a RUNNING live gateway (`npm run dev:live`, or the hosted one) reachable at
 * GATEWAY_PUBLIC_URL. That URL is stored on chain as the service's `gateway_base_url` and the
 * registry has no method to change it, so there is no localhost default (ruling R42).
 *
 * Environment (root `.env`, see .env.example): AGENTGATE_MODE=live, REGISTRY_CONTRACT_ID,
 * GATEWAY_ACCOUNT_ID (registered as the service's attestor), SELLER_ACCOUNT_ID, BUYER_ACCOUNT_ID
 * (keys in ~/.near-credentials or *_KEY_PATH / *_PRIVATE_KEY), GATEWAY_PUBLIC_URL; optional
 * SEED_UPSTREAM_URL and SEED_ALLOW_LOCAL_GATEWAY=1 (dev-only, see resolveGatewayGuard).
 *
 * Never retries a transaction. A change call whose outcome is unknown (TX_TIMEOUT) or a paid
 * call that was not served stops the run with the tx's explorer link.
 */
import { pathToFileURL } from 'node:url';
import { createChainClient, TxTimeoutError } from '@agentgate/chain';
import { PaidNotServedError, assertFetchableUrl, waitForReceipt } from '@agentgate/client';
import { buyService, cliSigner, mapService, wrapService } from '@neargate/cli';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  formatError,
  isMockNetwork,
  loadConfig,
  nearToYocto,
  stripTrailingSlashes,
  yoctoToNear,
  type AgentGateMode,
  type AnySigner,
  type ChainClient,
  type NearNetwork,
  type ServiceScore,
} from '@agentgate/shared';
import { validateHttpUrl } from '@agentgate/shared/net-guard';
import { loadDotenv } from './dotenv';

/** The public API the seed wraps unless SEED_UPSTREAM_URL says otherwise. */
export const DEFAULT_SEED_UPSTREAM_URL = 'https://open.er-api.com/v6/latest/USD';
export const SEED_PRICE_NEAR = '0.01';
const SERVICE_NAME = 'USD exchange rates';
const SERVICE_DESCRIPTION =
  'Latest USD exchange rates from open.er-api.com, wrapped by the NearGate testnet seed script';

/** Wait for the gateway to record the attestation (ms): it retries with backoff 5 s, 10 s, 20 s. */
const DEFAULT_ATTESTATION_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Wait for the score view to show the attestation (ms). */
const SCORE_TIMEOUT_MS = 30_000;
/** A mapping that failed right after registration is retried (it sends no transaction). */
const MAPPING_RETRIES = 3;
const MAPPING_RETRY_DELAY_MS = 5_000;

export interface SeedOptions {
  chain: ChainClient;
  /** Owns and registers the service; also its payment target. */
  seller: AnySigner;
  /** Buys the call. Must not be the seller: a self-paid call is served but never attested. */
  buyer: AnySigner;
  /** The account the gateway attests as (GATEWAY_ACCOUNT_ID); registered as the service's attestor. */
  attestor: string;
  /** The gateway's public base URL: recorded on chain as `gateway_base_url`, permanently. */
  gatewayUrl: string;
  /** The upstream API to wrap. */
  upstreamUrl: string;
  priceNear: string;
  mode: AgentGateMode;
  nearNetwork: NearNetwork;
  /** Explorer base URL; each tx is linked as `<explorerUrl>/txns/<hash>`. */
  explorerUrl: string;
  /** Admin Bearer token for the mapping: mock mode only (live maps with the seller's key). */
  adminToken?: string;
  /** SEED_ALLOW_LOCAL_GATEWAY=1: let a loopback gateway through (dev-only). */
  allowLocalGateway: boolean;
  attestationTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Wait after the payment before presenting the proof (ms); the client's live default when unset. */
  settleDelayMs?: number;
  /** Pause between mapping retries (ms). Default 5000. */
  mappingRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Filled in as the run goes (service registered, payment made). A caller that catches a failure
   * hands it to `describeSeedFailure`, which then says what already happened and not to redo it.
   */
  progress?: SeedProgress;
  log: (line: string) => void;
}

/** What a seed run has already done on chain. */
export interface SeedProgress {
  /** Set once `register_service` succeeded. */
  serviceId?: number;
  registerTxHash?: string;
  /** Set once the buy's `pay` succeeded. */
  paymentTxHash?: string;
}

export interface SeedResult {
  serviceId: number;
  registerTxHash: string;
  paymentTxHash: string;
  /** null when the registry already had the attestation from another party (no tx of ours to name). */
  attestationTxHash: string | null;
  score: ServiceScore;
}

/**
 * The buyer's private-host guard for the gateway (ruling R42). Off the mock network the buyer
 * client refuses a loopback/private gateway, and the service registered here keeps its
 * gateway URL for good, so a gateway the client would refuse is refused BEFORE anything is
 * registered (SEED_GATEWAY_LOCAL) unless `allowLocalGateway` is set. Then the guard is lifted
 * for this gateway only, with a warning; a public gateway keeps it on whatever the flag says.
 */
export async function resolveGatewayGuard(opts: {
  gatewayUrl: string;
  network: string;
  allowLocalGateway: boolean;
}): Promise<{ rejectPrivateHosts: boolean; warning?: string }> {
  if (isMockNetwork(opts.network)) return { rejectPrivateHosts: false };
  try {
    await assertFetchableUrl(opts.gatewayUrl, { rejectPrivateHosts: true });
    return { rejectPrivateHosts: true };
  } catch (err) {
    if (!(err instanceof AgentGateError) || err.code !== 'FORBIDDEN_HOST') throw err;
    if (!opts.allowLocalGateway) {
      throw new AgentGateError(
        'SEED_GATEWAY_LOCAL',
        `GATEWAY_PUBLIC_URL ${JSON.stringify(opts.gatewayUrl)} is a loopback, private or unresolvable address. The registry records it ` +
          'permanently (no method changes a service\'s gateway later) and the buyer client refuses such hosts. ' +
          'Use the public https URL of the hosted gateway; for a local dev run only, set SEED_ALLOW_LOCAL_GATEWAY=1.',
        400,
      );
    }
    return {
      rejectPrivateHosts: false,
      warning:
        `SEED_ALLOW_LOCAL_GATEWAY=1 (dev-only): the private-host guard is OFF for ${opts.gatewayUrl}, ` +
        'and the service stays registered at that URL on chain.',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps a service whose mapping failed right after registration; never registers anything. */
async function retryMapping(
  opts: SeedOptions,
  serviceId: number,
  firstFailure: string | undefined,
): Promise<void> {
  const stop = (why: string): AgentGateError =>
    new AgentGateError(
      'SEED_MAPPING_FAILED',
      `service #${serviceId} is registered but the gateway has not mapped it: ${why}`,
      502,
    );
  if (opts.seller.kind !== 'near') throw stop(firstFailure ?? 'the mapping request failed');
  let failure = firstFailure ?? 'the mapping request failed';
  for (let attempt = 1; attempt <= MAPPING_RETRIES; attempt += 1) {
    opts.log(`mapping failed (${failure.split('\n')[0] ?? ''}); retrying the mapping only (${attempt}/${MAPPING_RETRIES})`);
    await sleep(opts.mappingRetryDelayMs ?? MAPPING_RETRY_DELAY_MS);
    try {
      await mapService({
        serviceId,
        upstreamUrl: opts.upstreamUrl,
        chain: opts.chain,
        signer: opts.seller,
        mode: opts.mode,
        nearNetwork: opts.nearNetwork,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
      return;
    } catch (err) {
      failure = formatError(err);
    }
  }
  throw stop(failure);
}

/** Polls the score view until it shows at least one call (the attestation tx may not be final yet). */
async function waitForScore(chain: ChainClient, serviceId: number, pollMs: number): Promise<ServiceScore> {
  const deadline = Date.now() + SCORE_TIMEOUT_MS;
  for (;;) {
    const score = await chain.getScore(serviceId);
    if (score.totalCalls > 0 || Date.now() >= deadline) return score;
    await sleep(pollMs);
  }
}

export async function runSeed(opts: SeedOptions): Promise<SeedResult> {
  const { chain, log } = opts;
  const explorer = stripTrailingSlashes(opts.explorerUrl);
  const link = (hash: string): string => `  ${explorer}/txns/${hash}`;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const progress: SeedProgress = opts.progress ?? {};

  // -- checks that must pass before anything is sent ---------------------------------------
  if (opts.buyer.accountId === opts.seller.accountId) {
    throw new AgentGateError(
      'SEED_SELF_PAYMENT',
      `the buyer and the seller are both ${opts.seller.accountId}: a call its owner paid for is served but ` +
        'never attested. Set BUYER_ACCOUNT_ID to a different account.',
      400,
    );
  }
  if (!validateHttpUrl(opts.upstreamUrl, { rejectPrivateHosts: opts.mode === 'live' }).ok) {
    throw new AgentGateError(
      'SEED_UPSTREAM_PRIVATE',
      `SEED_UPSTREAM_URL ${JSON.stringify(opts.upstreamUrl)} is not a public http(s) URL: the live gateway refuses ` +
        'private and loopback upstreams (SSRF guard).',
      400,
    );
  }
  const gatewayUrl = stripTrailingSlashes(opts.gatewayUrl);
  const guard = await resolveGatewayGuard({
    gatewayUrl,
    network: chain.network,
    allowLocalGateway: opts.allowLocalGateway,
  });

  log(`network ${chain.network}  registry ${chain.registryId}`);
  log(`seller ${opts.seller.accountId}  buyer ${opts.buyer.accountId}  attestor ${opts.attestor}`);
  log(`gateway ${gatewayUrl}  upstream ${opts.upstreamUrl}`);
  if (guard.warning !== undefined) log(`warning: ${guard.warning}`);

  // -- 1. register + map -------------------------------------------------------------------
  const wrapped = await wrapService({
    upstreamUrl: opts.upstreamUrl,
    priceNear: opts.priceNear,
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    gateway: gatewayUrl,
    chain,
    signer: opts.seller,
    attestor: opts.attestor,
    mode: opts.mode,
    nearNetwork: opts.nearNetwork,
    ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  progress.serviceId = wrapped.serviceId;
  progress.registerTxHash = wrapped.txHash;
  log(`registered service #${wrapped.serviceId}`);
  log(link(wrapped.txHash));
  if (!wrapped.adminOk) await retryMapping(opts, wrapped.serviceId, wrapped.adminWarning);

  // -- 2. buy one call -----------------------------------------------------------------------
  const cap = yoctoToNear(addYocto(nearToYocto(opts.priceNear), PAYMENT_STORAGE_FEE_YOCTO));
  const bought = await buyService({
    chain,
    signer: opts.buyer,
    id: wrapped.serviceId,
    maxNear: cap,
    rejectPrivateHosts: guard.rejectPrivateHosts,
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const { result } = bought;
  if (!result.paid || result.txHash === undefined || result.requirements === undefined) {
    throw new AgentGateError(
      'SEED_NOT_PAID',
      `the gateway answered ${result.status} without asking for payment: ${bought.url} is not the paywalled service`,
      502,
    );
  }
  const paymentTxHash = result.txHash;
  progress.paymentTxHash = paymentTxHash;
  log(`paid: tx ${paymentTxHash}`);
  log(link(paymentTxHash));
  if (result.status < 200 || result.status >= 300) {
    throw new AgentGateError(
      'SEED_NOT_SERVED',
      `paid (tx ${paymentTxHash}), but the upstream answered HTTP ${result.status}. The gateway attests such a ` +
        'call as failed. Check SEED_UPSTREAM_URL.',
      502,
    );
  }
  log(`served: ${result.status}`);

  // -- 3. the attestation, via the gateway's receipt -----------------------------------------
  const receipt = await waitForReceipt(bought.url, result.requirements.extra.nonce, {
    rejectPrivateHosts: guard.rejectPrivateHosts,
    timeoutMs: opts.attestationTimeoutMs ?? DEFAULT_ATTESTATION_TIMEOUT_MS,
    pollIntervalMs: pollMs,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (receipt === null) {
    throw new AgentGateError(
      'SEED_NO_RECEIPT',
      `the gateway has no receipt for nonce ${result.requirements.extra.nonce} (it restarted, or GATEWAY_PUBLIC_URL ` +
        'is not the gateway that served the call).',
      502,
    );
  }
  const status = receipt.attestation.status;
  if (status !== 'recorded') {
    const why: Record<string, string> = {
      pending: 'the attestation is still pending after the wait: check the gateway logs, it keeps retrying',
      failed:
        'the gateway could not record the attestation (is GATEWAY_ACCOUNT_ID the service attestor, with gas?); ' +
        'with ATTESTATION_QUEUE_PATH set it retries on its next boot',
      skipped_self_paid: 'the payment counted as self-paid, so it is never attested',
      skipped_upstream_failed: 'the gateway could not reach the upstream, so it did not attest',
    };
    throw new AgentGateError('SEED_NOT_ATTESTED', `${why[status] ?? status}.`, 502);
  }
  const attestationTxHash = receipt.attestation.txHash ?? null;
  if (attestationTxHash !== null) {
    log(`attested: tx ${attestationTxHash}`);
    log(link(attestationTxHash));
  } else {
    log('attested: recorded on chain by another party (the gateway has no tx of its own to name)');
  }

  // -- 4. the score --------------------------------------------------------------------------
  const score = await waitForScore(chain, wrapped.serviceId, pollMs);
  log(`score ${score.successCalls}/${score.totalCalls}`);
  if (score.totalCalls === 0) {
    log('warning: the score view has not caught up with the attestation yet; `npm run smoke:live` shows it shortly');
  }

  return {
    serviceId: wrapped.serviceId,
    registerTxHash: wrapped.txHash,
    paymentTxHash,
    attestationTxHash,
    score,
  };
}

/**
 * What the CLI prints, and the exit code it ends with, for a failed seed. A change call whose
 * outcome is unknown, or a paid call that was not served, names its tx and says what NOT to do:
 * the seed never retries a `register_service` or a `pay`. Whatever the failure, if the run had
 * already registered the service (or paid) it says so and that the seed must not be rerun: a
 * rerun registers a second service.
 */
export function describeSeedFailure(
  err: unknown,
  explorerUrl: string,
  progress: SeedProgress = {},
): { lines: string[]; exitCode: number } {
  const explorer = stripTrailingSlashes(explorerUrl);
  const tx = (hash: string): string => `${explorer}/txns/${hash}`;
  let lines: string[];
  let exitCode = 1;
  if (err instanceof TxTimeoutError) {
    exitCode = 2;
    lines = [
      `seed stopped: ${err.message}`,
      `tx: ${tx(err.txHash)}`,
      'Its outcome is unknown. Look the tx up before anything else; do not retry register_service or pay ' +
        'until you know whether it landed (a retry can register or pay twice).',
    ];
  } else if (err instanceof PaidNotServedError) {
    lines = [
      `seed stopped: ${err.message}`,
      `payment tx: ${tx(err.txHash)}`,
      `Re-present the proof (tx above, nonce ${err.nonce}) to the gateway once it serves; do not pay again.`,
    ];
  } else {
    lines = [`seed failed: ${formatError(err)}`];
  }
  if (progress.serviceId !== undefined) {
    lines.push(
      `service #${progress.serviceId} is registered` +
        (progress.registerTxHash !== undefined ? ` (register tx: ${tx(progress.registerTxHash)})` : '') +
        ': do not rerun the seed, a rerun registers a second service.',
    );
    if (progress.paymentTxHash !== undefined) {
      lines.push(`The call is paid (tx ${progress.paymentTxHash}): do not pay for it again. ${tx(progress.paymentTxHash)}`);
    } else if (!(err instanceof TxTimeoutError)) {
      lines.push(
        `To finish by hand, once the cause is fixed: npm run neargate -- buy ${progress.serviceId} as the buyer ` +
          'account, then npm run smoke:live.',
      );
    }
  }
  return { lines, exitCode };
}

function requiredEnv(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new AgentGateError('CONFIG_INVALID', `${name} is required: ${why}`, 500);
  }
  return value;
}

async function main(): Promise<void> {
  loadDotenv();
  // The seed never calls the gateway admin API (it maps with the seller's key): no admin token needed.
  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  if (config.mode !== 'live') {
    throw new AgentGateError(
      'CONFIG_INVALID',
      'AGENTGATE_MODE is not "live": set it in .env. `npm run demo` is the offline loop.',
      500,
    );
  }
  const gatewayUrl = requiredEnv(
    'GATEWAY_PUBLIC_URL',
    'the public URL of the running gateway. It is recorded on chain permanently as the service gateway_base_url, ' +
      'so there is no localhost default.',
  );
  const attestor = requiredEnv(
    'GATEWAY_ACCOUNT_ID',
    'the account the gateway attests as; it is registered as the service attestor.',
  );
  const chain = createChainClient(config);
  const seller = await cliSigner(config, 'seller');
  const buyer = await cliSigner(config, 'buyer');
  const upstreamUrl = process.env['SEED_UPSTREAM_URL']?.trim() || DEFAULT_SEED_UPSTREAM_URL;
  const progress: SeedProgress = {};
  try {
    await runSeed({
      chain,
      seller,
      buyer,
      attestor,
      gatewayUrl,
      upstreamUrl,
      priceNear: SEED_PRICE_NEAR,
      mode: config.mode,
      nearNetwork: config.nearNetwork,
      explorerUrl: config.nearExplorerUrl,
      allowLocalGateway: process.env['SEED_ALLOW_LOCAL_GATEWAY'] === '1',
      progress,
      log: (line) => console.log(line),
    });
  } catch (err) {
    const report = describeSeedFailure(err, config.nearExplorerUrl, progress);
    for (const line of report.lines) console.error(line);
    process.exit(report.exitCode);
  }
}

// Run only as a script (`tsx scripts/near/seed-testnet.ts`), never when a test imports runSeed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`seed failed: ${formatError(err)}`);
    process.exit(1);
  });
}
