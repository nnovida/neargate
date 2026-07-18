import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { buildAgentGateMcpServer, type McpServerDeps } from '../src/mcp';

const HEX64 = (c: string): string => c.repeat(64);
const BUYER: AnySigner = { kind: 'mock', publicKey: `01${HEX64('b')}` };
const PAY_TO = `account-hash-${HEX64('1')}`;

function makeService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id,
    name: `svc-${id}`,
    description: 'a service',
    endpointUrl: `http://gw.example:4021/svc/${id}`,
    priceMotes: '2500000000',
    paymentTarget: PAY_TO,
    owner: `01${HEX64('a')}`,
    attestor: `01${HEX64('a')}`,
    active: true,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

/** Two services: #1 active with a 5/5 score, #2 paused. */
function makeChain(): ChainClient {
  const services = new Map<number, ServiceRecord>([
    [1, makeService(1)],
    [2, makeService(2, { active: false, name: 'svc-2-paused' })],
  ]);
  const scores = new Map<number, ServiceScore>([
    [1, { totalCalls: 5, successCalls: 5 }],
    [2, { totalCalls: 0, successCalls: 0 }],
  ]);
  return {
    network: 'mock',
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
    async verifyTransfer() {
      return { ok: false, reason: 'not_found' } as const;
    },
    async registerService() {
      throw new Error('not used');
    },
    async recordAttestation() {
      return { txHash: HEX64('b') };
    },
    async setActive() {
      return { txHash: HEX64('c') };
    },
    async transfer() {
      return { deployHash: HEX64('d') };
    },
  } as ChainClient;
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

describe('AgentGate MCP server', () => {
  it('exposes the discover + inspect + pay tools', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('agentgate_list_services');
    expect(names).toContain('agentgate_get_service');
    expect(names).toContain('agentgate_get_invoice');
    expect(names).toContain('agentgate_buy');
    await client.close();
  });

  it('agentgate_list_services returns the on-chain catalog joined with scores + tiers', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'agentgate_list_services', arguments: {} });
    const parsed = JSON.parse(textOf(res)) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    const svc1 = parsed.find((s) => s.id === 1)!;
    expect(svc1).toMatchObject({ id: 1, name: 'svc-1', score: '5/5' });
    await client.close();
  });

  it('agentgate_get_service returns detail + trust score for one id', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'agentgate_get_service', arguments: { id: 1 } });
    const parsed = JSON.parse(textOf(res)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ id: 1, name: 'svc-1', totalCalls: 5, successCalls: 5 });
    await client.close();
  });

  it('agentgate_get_service on an unknown id returns a tool error, not a crash', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'agentgate_get_service', arguments: { id: 999 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    await client.close();
  });

  it('agentgate_buy refuses a paused service without spending (fail-fast)', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'agentgate_buy', arguments: { id: 2 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/paused|inactive/i);
    await client.close();
  });

  it('agentgate_buy refuses an unknown service without spending', async () => {
    const client = await connectClient({ chain: makeChain(), signerProvider: () => BUYER });
    const res = await client.callTool({ name: 'agentgate_buy', arguments: { id: 999 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
    await client.close();
  });
});
