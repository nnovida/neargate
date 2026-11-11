import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { nativeNearOption, PAYMENT_STORAGE_FEE_YOCTO } from '@agentgate/shared';
import { buildAgentGateMcpServer, type McpServerDeps } from '../src/mcp';

/** A base58 string of NEAR tx-hash length. */
const TX = (c: string): string => c.repeat(44);
const BUYER: AnySigner = { kind: 'mock', accountId: 'buyer.mock' };
const SELLER = 'seller.mock';
const PRICE = '2500000000000000000000000'; // 2.5 NEAR
const TOTAL = '2502000000000000000000000'; // price + 0.002 NEAR storage
const NONCE = '31337';

function makeService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id,
    name: `svc-${id}`,
    description: 'a service',
    endpointUrl: `http://gw.example:4021/svc/${id}`,
    priceYocto: PRICE,
    paymentTarget: SELLER,
    owner: 'owner.mock',
    attestor: 'owner.mock',
    active: true,
    createdAt: 1_700_000_000_000,
    accepts: [nativeNearOption(PRICE)],
    ...over,
  };
}

/** Two services: #1 active with a 5/5 score, #2 paused (plus any `extra` services). */
function makeChain(
  extra: ServiceRecord[] = [],
): ChainClient & { paid: unknown[]; escrowPaid: unknown[]; delegates: unknown[]; escrows: Map<string, string> } {
  const paid: unknown[] = [];
  const delegates: unknown[] = [];
  const escrowPaid: unknown[] = [];
  const escrows = new Map<string, string>([['buyer.mock', '498000000000000000000000']]);
  const services = new Map<number, ServiceRecord>([
    [1, makeService(1)],
    [2, makeService(2, { active: false, name: 'svc-2-paused' })],
    ...extra.map((s): [number, ServiceRecord] => [s.id, s]),
  ]);
  const scores = new Map<number, ServiceScore>([
    [1, { totalCalls: 5, successCalls: 5 }],
    [2, { totalCalls: 0, successCalls: 0 }],
  ]);
  return {
    network: 'near-mock',
    registryId: 'registry.mock',
    paid,
    escrowPaid,
    delegates,
    escrows,
    async blockHeight() {
      return 1_000;
    },
    async accessKey() {
      return { nonce: 41n, permission: 'FullAccess' as const };
    },
    async signPayDelegate(input: unknown) {
      delegates.push(input);
      return Buffer.from('a signed NEP-366 delegate').toString('base64');
    },
    async relayPay() {
      throw new Error('the MCP server never relays');
    },
    async escrowOf(accountId: string) {
      return escrows.get(accountId) ?? '0';
    },
    async depositEscrow() {
      throw new Error('the MCP server never deposits');
    },
    async withdrawEscrow() {
      throw new Error('the MCP server never withdraws');
    },
    async payFromEscrow(input: unknown) {
      escrowPaid.push(input);
      return { txHash: TX('E') };
    },
    async getService(id: number) {
      return services.get(id) ?? null;
    },
    async listServices() {
      return [...services.values()];
    },
    async getScore(id: number) {
      return scores.get(id) ?? { totalCalls: 0, successCalls: 0 };
    },
    async listAttestations(): Promise<AttestationRecord[]> {
      return [];
    },
    async listRecentActivity() {
      return [];
    },
    async getBalance() {
      return '0';
    },
    async getPayment() {
      return null;
    },
    async verifyPayment() {
      return { ok: false, reason: 'not_found' } as const;
    },
    async isFullAccessKey() {
      return false;
    },
    async accountExists() {
      return true;
    },
    async registerService() {
      throw new Error('not used');
    },
    async pay(input: unknown) {
      paid.push(input);
      return { txHash: TX('D') };
    },
    async recordAttestation() {
      return { txHash: TX('B') };
    },
    async setActive() {
      return { txHash: TX('C') };
    },
  } as ChainClient & { paid: unknown[]; escrowPaid: unknown[]; delegates: unknown[]; escrows: Map<string, string> };
}

/** The gateway: a D3 invoice for service 1 without proof, the data once X-PAYMENT is present. */
function gatewayFetch(extraOver: Record<string, unknown> = {}): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    if (new Headers(init?.headers).has('X-PAYMENT')) return Response.json({ gold: 3310.25 });
    return Response.json(
      {
        x402Version: 1,
        error: 'X-PAYMENT header is required',
        accepts: [
          {
            scheme: 'exact',
            network: 'near-mock',
            maxAmountRequired: TOTAL,
            asset: 'NEAR',
            payTo: 'registry.mock',
            resource: 'http://gw.example:4021/svc/1',
            description: 'svc-1',
            maxTimeoutSeconds: 300,
            extra: {
              nonce: NONCE,
              serviceId: 1,
              expiresAtMs: Date.now() + 300_000,
              settlement: 'neargate-registry-pay',
              contractId: 'registry.mock',
              method: 'pay',
              priceYocto: PRICE,
              storageFeeYocto: PAYMENT_STORAGE_FEE_YOCTO,
              seller: SELLER,
              caip2: 'near:mock',
              ...extraOver,
            },
          },
        ],
      },
      { status: 402 },
    );
  }) as typeof fetch;
  return { impl, urls };
}

async function connectClient(deps: McpServerDeps): Promise<Client> {
  const server = buildAgentGateMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('NearGate MCP server', () => {
  it('the tool list equals the five neargate_* tools', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'neargate_buy',
      'neargate_escrow_balance',
      'neargate_get_invoice',
      'neargate_get_service',
      'neargate_list_services',
    ]);
    expect(client.getServerVersion()?.name).toBe('neargate');
    const buy = tools.find((t) => t.name === 'neargate_buy')!;
    expect(Object.keys((buy.inputSchema as { properties?: object }).properties ?? {})).toEqual(
      expect.arrayContaining(['maxNear', 'fromEscrow', 'gasless']),
    );
    const balance = tools.find((t) => t.name === 'neargate_escrow_balance')!;
    expect(Object.keys((balance.inputSchema as { properties?: object }).properties ?? {})).toEqual(['account']);
    expect((balance.inputSchema as { required?: string[] }).required ?? []).toEqual([]); // account is optional
    await client.close();
  });

  it('neargate_list_services returns the on-chain catalog joined with scores + tiers', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_list_services', arguments: {} });
    const parsed = JSON.parse(textOf(res)) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    const svc1 = parsed.find((s) => s.id === 1)!;
    expect(svc1).toMatchObject({ id: 1, name: 'svc-1', score: '5/5' });
    await client.close();
  });

  it('neargate_get_service returns detail + trust score for one id', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_get_service', arguments: { id: 1 } });
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ id: 1, name: 'svc-1', totalCalls: 5, successCalls: 5 });
    await client.close();
  });

  it('neargate_get_service on an unknown id returns a tool error, not a crash', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_get_service', arguments: { id: 999 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    await client.close();
  });

  it('neargate_buy refuses a paused service without spending (fail-fast)', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 2 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/paused|inactive/i);
    await client.close();
  });

  it('neargate_get_invoice reports the price and the storage fee separately, without paying', async () => {
    const chain = makeChain();
    const { impl } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_get_invoice', arguments: { id: 1 } });
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: 1,
      price: '2.5 NEAR + 0.002 NEAR storage',
      priceYocto: PRICE,
      storageFeeYocto: PAYMENT_STORAGE_FEE_YOCTO,
      maxAmountYocto: TOTAL,
      payTo: 'registry.mock',
      network: 'near-mock',
      nonce: NONCE,
    });
    expect(chain.paid).toHaveLength(0);
    await client.close();
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ftp://gw.example/svc/3'])(
    'neargate_get_invoice refuses a registry endpoint %j that is not http(s), before fetching',
    async (endpointUrl) => {
      const { impl, urls } = gatewayFetch();
      const client = await connectClient({
        chain: makeChain([makeService(3, { endpointUrl })]),
        signerProvider: () => BUYER,
        fetchImpl: impl,
      });
      const res = await client.callTool({ name: 'neargate_get_invoice', arguments: { id: 3 } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(urls).toHaveLength(0);
      await client.close();
    },
  );

  it('neargate_buy pays price + storage and reports both', async () => {
    const chain = makeChain();
    const { impl } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: async () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1, maxNear: '2.502' } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: 1,
      paid: true,
      status: 200,
      price: '2.5 NEAR + 0.002 NEAR storage',
      priceYocto: PRICE,
      depositYocto: TOTAL,
      txHash: TX('D'),
      body: { gold: 3310.25 },
    });
    expect(chain.paid).toEqual([{ serviceId: 1, nonce: NONCE, depositYocto: TOTAL }]);
    await client.close();
  });

  it('neargate_buy fromEscrow pays out of the escrow: payFromEscrow once, `pay` never', async () => {
    const chain = makeChain();
    chain.escrows.set('buyer.mock', '5000000000000000000000000'); // 5 NEAR
    const { impl } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: async () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1, fromEscrow: true, maxNear: '2.502' } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toMatchObject({
      id: 1,
      paid: true,
      payFrom: 'escrow',
      price: '2.5 NEAR + 0.002 NEAR storage',
      depositYocto: TOTAL,
      txHash: TX('E'),
      body: { gold: 3310.25 },
    });
    expect(chain.escrowPaid).toEqual([{ serviceId: 1, nonce: NONCE }]);
    expect(chain.paid).toEqual([]);
    await client.close();
  });

  it('neargate_buy gasless signs a pay_from_escrow delegate the gateway relays: neither pay nor payFromEscrow is sent', async () => {
    const chain = makeChain();
    chain.escrows.set('buyer.mock', '5000000000000000000000000'); // 5 NEAR
    const { impl } = gatewayFetch({ relayer: 'gateway.mock', relayMethod: 'pay_from_escrow' });
    const client = await connectClient({ chain, signerProvider: async () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1, gasless: true } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toMatchObject({
      id: 1,
      paid: true,
      payFrom: 'escrow',
      gasless: true,
      relayer: 'gateway.mock',
      depositYocto: TOTAL,
      body: { gold: 3310.25 },
    });
    expect(chain.delegates).toEqual([{ serviceId: 1, nonce: NONCE }]);
    expect(chain.paid).toEqual([]);
    expect(chain.escrowPaid).toEqual([]);
    await client.close();
  });

  it('neargate_buy gasless against a gateway that relays nothing is a tool error (RELAYER_UNAVAILABLE); nothing is signed', async () => {
    const chain = makeChain();
    chain.escrows.set('buyer.mock', '5000000000000000000000000');
    const { impl } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1, gasless: true } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/^RELAYER_UNAVAILABLE/);
    expect(chain.delegates).toEqual([]);
    await client.close();
  });

  it('neargate_buy without fromEscrow keeps paying with a deposit (payFrom "deposit")', async () => {
    const chain = makeChain();
    const { impl } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: async () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1 } });
    expect(JSON.parse(textOf(res))).toMatchObject({ paid: true, payFrom: 'deposit' });
    expect(chain.paid).toHaveLength(1);
    expect(chain.escrowPaid).toEqual([]);
    await client.close();
  });

  it('neargate_buy fromEscrow with too little escrow is a tool error (ERR_ESCROW_INSUFFICIENT) and sends nothing', async () => {
    const chain = makeChain(); // buyer.mock holds 0.498 NEAR, the call needs 2.502
    const { impl } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1, fromEscrow: true } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/^ERR_ESCROW_INSUFFICIENT: the escrow holds 498000000000000000000000 yocto/);
    expect(chain.escrowPaid).toEqual([]);
    expect(chain.paid).toEqual([]);
    await client.close();
  });

  it('neargate_escrow_balance reads the buyer\'s own escrow by default, read-only', async () => {
    const chain = makeChain();
    const client = await connectClient({ chain, signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_escrow_balance', arguments: {} });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({
      account: 'buyer.mock',
      escrowYocto: '498000000000000000000000',
      escrow: '0.498 NEAR',
    });
    expect(chain.paid).toEqual([]);
    expect(chain.escrowPaid).toEqual([]);
    await client.close();
  });

  it('neargate_escrow_balance {account} reads that account and needs no key; an unknown account holds 0', async () => {
    const chain = makeChain();
    const client = await connectClient({
      chain,
      signerProvider: async () => {
        throw new Error('SIGNER_MISSING: no key');
      },
    });
    const known = await client.callTool({ name: 'neargate_escrow_balance', arguments: { account: 'buyer.mock' } });
    expect(JSON.parse(textOf(known))).toMatchObject({ account: 'buyer.mock', escrow: '0.498 NEAR' });
    const unknown = await client.callTool({ name: 'neargate_escrow_balance', arguments: { account: 'ghost.mock' } });
    expect(JSON.parse(textOf(unknown))).toEqual({ account: 'ghost.mock', escrowYocto: '0', escrow: '0 NEAR' });
    await client.close();
  });

  it('neargate_escrow_balance without an account needs the signer; a missing one and a bad id are tool errors', async () => {
    const client = await connectClient({
      chain: makeChain(),
      signerProvider: async () => {
        throw new Error('SIGNER_MISSING: no key');
      },
    });
    const noKey = await client.callTool({ name: 'neargate_escrow_balance', arguments: {} });
    expect((noKey as { isError?: boolean }).isError).toBe(true);
    expect(textOf(noKey)).toContain('SIGNER_MISSING');
    const bad = await client.callTool({ name: 'neargate_escrow_balance', arguments: { account: 'Not An Account' } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    expect(textOf(bad)).toContain('INVALID_ACCOUNT_ID');
    await client.close();
  });

  it('neargate_buy maxNear caps the total: a cap equal to the bare price refuses (BUDGET_EXCEEDED)', async () => {
    const chain = makeChain();
    const { impl, urls } = gatewayFetch();
    const client = await connectClient({ chain, signerProvider: () => BUYER, fetchImpl: impl });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1, maxNear: '2.5' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain('BUDGET_EXCEEDED');
    expect(chain.paid).toHaveLength(0);
    expect(urls).toHaveLength(0);
    await client.close();
  });

  it('neargate_buy surfaces a signer that cannot be resolved as a tool error', async () => {
    const client = await connectClient({
      chain: makeChain(),
      signerProvider: async () => {
        throw new Error('SIGNER_MISSING: no key');
      },
    });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 1 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain('SIGNER_MISSING');
    await client.close();
  });

  it('neargate_buy refuses an unknown service without spending', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 999 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    await client.close();
  });
});

/** Start an HTTP server on an ephemeral loopback port. */
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('NearGate MCP server · a gateway redirect is never followed (R35)', () => {
  let target: Server;
  let gateway: Server;
  let targetHits: number;
  let redirectingService: ServiceRecord;

  beforeEach(async () => {
    targetHits = 0;
    const t = await listen((_req, res) => {
      targetHits += 1;
      res.end('{"instanceRole":"secret"}');
    });
    target = t.server;
    // A public-looking gateway that answers every request with a redirect to a private URL.
    const g = await listen((_req, res) => {
      res.writeHead(302, { location: `${t.base}/latest/meta-data/` });
      res.end();
    });
    gateway = g.server;
    redirectingService = makeService(3, { endpointUrl: `${g.base}/svc/3` });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('neargate_get_invoice refuses the redirect (REDIRECT_REFUSED) and never contacts the target', async () => {
    const client = await connectClient({ chain: makeChain([redirectingService]), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_get_invoice', arguments: { id: 3 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/^REDIRECT_REFUSED: .*302/);
    expect(targetHits).toBe(0);
    await client.close();
  });

  it('neargate_buy refuses the redirect before paying anything', async () => {
    const chain = makeChain([redirectingService]);
    const client = await connectClient({ chain, signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'neargate_buy', arguments: { id: 3 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain('REDIRECT_REFUSED');
    expect(chain.paid).toHaveLength(0);
    expect(targetHits).toBe(0);
    await client.close();
  });
});
