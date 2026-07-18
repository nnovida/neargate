import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { encodeXPayment, type AgentGateConfig, type Logger, type PaymentRequiredResponse } from '@agentgate/shared';
import { startServer, type MiddlewareStartOpts, type RunningServer } from '../src/index';
import { FakeChainClient } from './fake-chain';
import type { FacilitatorClient } from '@x402/core/http';

/** Silent logger so test output stays readable. */
export const silentLogger: Logger = {
  name: 'test',
  level: 'error',
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** Full AgentGateConfig literal for tests — no env reads, no loadConfig coupling. */
export function testConfig(overrides: Partial<AgentGateConfig> = {}): AgentGateConfig {
  return {
    mode: 'mock',
    devnetPort: 0,
    oraclePort: 0,
    middlewarePort: 0,
    dashboardPort: 0,
    devnetUrl: 'http://localhost:4030',
    mockBuyerAccount: '',
    mockSellerAccount: '',
    adminToken: 'test-admin-token',
    invoiceTtlMs: 300_000,
    upstreamTimeoutMs: 5_000,
    trustProxy: 0,
    casperNodeUrl: 'https://node.testnet.casper.network/rpc',
    csprCloudApiUrl: 'https://api.testnet.cspr.cloud',
    csprCloudApiKey: '',
    csprCloudStreamingUrl: 'wss://streaming.testnet.cspr.cloud',
    casperNetwork: 'casper-test',
    registryContractPackageHash: '',
    gateSignerPemPath: '',
    buyerSignerPemPath: '',
    sellerSignerPemPath: '',
    anthropicApiKey: '',
    llmModel: 'claude-sonnet-4-6',
    oracleStatic: false,
    buyerBudgetCspr: '5',
    facilitatorUrl: 'https://x402-facilitator.cspr.cloud',
    buyerKeyAlgo: 'secp256k1',
    facilitatorServices: {},
    ...overrides,
  };
}

export interface TestGateway {
  baseUrl: string;
  fake: FakeChainClient;
  config: AgentGateConfig;
  upstreamsFile: string;
  close(): Promise<void>;
}

/** Boots the middleware on an ephemeral port with a FakeChainClient. */
export async function bootGateway(
  opts: {
    config?: AgentGateConfig;
    fake?: FakeChainClient;
    upstreamsFile?: string;
    attestationRetryDelayMs?: number;
    attestationMaxAttempts?: number;
    attestationQueuePath?: string;
    facilitatorClient?: FacilitatorClient;
  } = {},
): Promise<TestGateway> {
  const config = opts.config ?? testConfig();
  const fake = opts.fake ?? new FakeChainClient();
  const upstreamsFile =
    opts.upstreamsFile ??
    path.join(await mkdtemp(path.join(os.tmpdir(), 'agentgate-mw-')), 'upstreams.json');
  const startOpts: MiddlewareStartOpts = {
    port: 0,
    config,
    chain: fake,
    logger: silentLogger,
    upstreamsFile,
  };
  if (opts.attestationRetryDelayMs !== undefined) {
    startOpts.attestationRetryDelayMs = opts.attestationRetryDelayMs;
  }
  if (opts.attestationMaxAttempts !== undefined) {
    startOpts.attestationMaxAttempts = opts.attestationMaxAttempts;
  }
  if (opts.attestationQueuePath !== undefined) {
    startOpts.attestationQueuePath = opts.attestationQueuePath;
  }
  if (opts.facilitatorClient !== undefined) {
    startOpts.facilitatorClient = opts.facilitatorClient;
  }
  const server: RunningServer = await startServer(startOpts);
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    fake,
    config,
    upstreamsFile,
    close: () => server.close(),
  };
}

export interface TestUpstream {
  url: string;
  /** Requests the upstream actually received (method, path, headers). */
  seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

/**
 * Local upstream used as the proxy target. Routes:
 * - GET  /data  → 200 JSON { hello, query }
 * - POST /echo  → 200 JSON { echo: <request body> }
 * - any  /fail  → 500 JSON { error: 'boom' }
 * - any  /slow  → responds after 400 ms
 * - any  /big   → 200 with a 2 MiB body
 */
export async function startUpstream(): Promise<TestUpstream> {
  const seen: TestUpstream['seen'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const pathname = new URL(req.url ?? '/', 'http://upstream.test').pathname;
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };
      switch (pathname) {
        case '/data': {
          const query = Object.fromEntries(
            new URL(req.url ?? '/', 'http://upstream.test').searchParams,
          );
          json(200, { hello: 'world', query });
          break;
        }
        case '/echo':
          json(200, { echo: body === '' ? null : (JSON.parse(body) as unknown) });
          break;
        case '/fail':
          json(500, { error: 'boom' });
          break;
        case '/slow':
          setTimeout(() => json(200, { slow: true }), 400);
          break;
        case '/big': {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.alloc(2 * 1024 * 1024, 0x61));
          break;
        }
        default:
          json(404, { error: 'no_such_route' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** Registers an upstream mapping through the admin API. */
export async function adminMap(
  gw: TestGateway,
  serviceId: number,
  upstreamUrl: string,
): Promise<globalThis.Response> {
  return fetch(`${gw.baseUrl}/admin/services`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${gw.config.adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ serviceId, upstreamUrl }),
  });
}

/** GET the service and complete a full pay cycle, returning the x402 proof payload. */
export async function payInvoice(
  gw: TestGateway,
  serviceId: number,
  opts: { amountMotes?: string; pendingReads?: number } = {},
): Promise<{ deployHash: string; nonce: string; network: string }> {
  const challenge = await fetch(`${gw.baseUrl}/svc/${serviceId}`);
  if (challenge.status !== 402) throw new Error(`expected 402 challenge, got ${challenge.status}`);
  const body = (await challenge.json()) as PaymentRequiredResponse;
  const req = body.accepts[0]!;
  const { deployHash } = await gw.fake.transfer(
    { to: req.payTo, amountMotes: opts.amountMotes ?? req.maxAmountRequired, transferId: req.extra.nonce },
    { kind: 'mock', publicKey: '01buyer' },
  );
  if (opts.pendingReads !== undefined) gw.fake.setPending(deployHash, opts.pendingReads);
  return { deployHash, nonce: req.extra.nonce, network: req.network };
}

export function proofHeaders(proof: { deployHash: string; nonce: string; network: string }): Record<string, string> {
  return {
    'x-payment': encodeXPayment({
      x402Version: 1, scheme: 'exact', network: proof.network,
      payload: { transaction: proof.deployHash, transferId: proof.nonce },
    }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `predicate()` is true (default timeout 5 s). */
export async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until(): condition not met in time');
    await sleep(20);
  }
}
