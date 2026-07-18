import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parsePaymentRequired } from '@agentgate/client';
import {
  AgentGateError,
  formatCspr,
  formatToken,
  isAgentGateError,
  trustTier,
  type AnySigner,
  type ChainClient,
} from '@agentgate/shared';
import { buyService } from './buy';
import { listServices } from './list';

/**
 * AgentGate as Model Context Protocol tools. Exposes the same discover → inspect
 * → pay loop the CLI drives, so any MCP-capable agent (Claude Desktop, a custom
 * client, an MCP-aware framework) gets AgentGate natively — the agentic rail is
 * the product, and this is its native binding.
 *
 * Read tools (`list`, `get_service`, `get_invoice`) need no key. Only
 * `agentgate_buy` spends CSPR, and it resolves the buyer signer lazily so the
 * read tools work with zero configuration.
 */
export interface McpServerDeps {
  chain: ChainClient;
  /**
   * Resolve the buyer signer. Called only by `agentgate_buy`, so the read tools
   * work even when no buyer key is configured (the provider may throw a friendly
   * "no buyer key" error, surfaced as a tool error rather than a crash).
   */
  signerProvider: () => AnySigner;
  /** Injectable fetch (tests / get_invoice). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Buyer key algorithm for the facilitator (x402 v2) rail used by agentgate_buy. */
  buyerKeyAlgo?: 'ed25519' | 'secp256k1';
}

const MCP_NAME = 'agentgate';
const MCP_VERSION = '0.1.0';

interface ToolTextResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Run a tool body; serialize its value to JSON text, or map any error to a clean tool error. */
async function toolResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await fn();
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const ok: ToolTextResult = { content: [{ type: 'text', text }] };
    return ok;
  } catch (err) {
    const message = isAgentGateError(err) || err instanceof Error ? err.message : String(err);
    const bad: ToolTextResult = { content: [{ type: 'text', text: message }], isError: true };
    return bad;
  }
}

/** Build the AgentGate MCP server with its tools registered (no transport attached). */
export function buildAgentGateMcpServer(deps: McpServerDeps): McpServer {
  const { chain } = deps;
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });

  server.registerTool(
    'agentgate_list_services',
    {
      title: 'List AgentGate services',
      description:
        'Discover the live on-chain AgentGate catalog: every registered service with its price, trust tier, payment-backed score (successful/total paid calls), active flag, and gateway endpoint. Read-only — no payment.',
      inputSchema: {},
    },
    () =>
      toolResult(async () => {
        const listings = await listServices({ chain });
        return listings.map(({ service, score, tier }) => ({
          id: service.id,
          name: service.name,
          description: service.description,
          price: formatCspr(service.priceMotes),
          tier,
          score: `${score.successCalls}/${score.totalCalls}`,
          active: service.active,
          endpoint: service.endpointUrl,
        }));
      }),
  );

  server.registerTool(
    'agentgate_get_service',
    {
      title: 'Get one AgentGate service',
      description:
        'Fetch full on-chain detail for one service id: name, description, price, payment target, owner, attestor, active flag, and its payment-backed trust score/tier. Read-only — no payment.',
      inputSchema: {
        id: z.number().int().positive().describe('service id, as shown by agentgate_list_services'),
      },
    },
    ({ id }) =>
      toolResult(async () => {
        const service = await chain.getService(id);
        if (service === null) {
          throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found`, 404);
        }
        const score = await chain.getScore(id);
        return {
          id: service.id,
          name: service.name,
          description: service.description,
          price: formatCspr(service.priceMotes),
          endpoint: service.endpointUrl,
          paymentTarget: service.paymentTarget,
          owner: service.owner,
          attestor: service.attestor,
          active: service.active,
          tier: trustTier(score),
          score: `${score.successCalls}/${score.totalCalls}`,
          totalCalls: score.totalCalls,
          successCalls: score.successCalls,
        };
      }),
  );

  server.registerTool(
    'agentgate_get_invoice',
    {
      title: 'Get the x402 invoice for a service',
      description:
        'Fetch the machine-readable HTTP 402 payment invoice for a service WITHOUT paying — price, invoice nonce, payment target, network — so an agent can decide before it spends. Read-only.',
      inputSchema: { id: z.number().int().positive().describe('service id') },
    },
    ({ id }) =>
      toolResult(async () => {
        const service = await chain.getService(id);
        if (service === null) {
          throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found`, 404);
        }
        if (!service.active) {
          throw new AgentGateError(
            'SERVICE_INACTIVE',
            `service ${id} (${service.name}) is paused by its owner`,
            403,
          );
        }
        const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
        const res = await fetchImpl(service.endpointUrl, { method: 'GET' });
        const raw: unknown = await res.json().catch(() => null);
        if (res.status !== 402) {
          return { id, status: res.status, note: 'service did not return a 402 invoice', body: raw };
        }
        const req = parsePaymentRequired(raw, chain.network);
        return {
          id,
          price: formatCspr(req.maxAmountRequired),
          priceMotes: req.maxAmountRequired,
          payTo: req.payTo,
          network: req.network,
          nonce: req.extra.nonce,
          resource: req.resource,
          expiresAtMs: req.extra.expiresAtMs,
        };
      }),
  );

  server.registerTool(
    'agentgate_buy',
    {
      title: 'Buy one call to a service (pays native CSPR)',
      description:
        'Autonomously pay a service’s 402 invoice with a native CSPR transfer (the invoice nonce rides transfer_id) and return the response body. Spends real CSPR from the configured buyer key, capped by maxCspr. Fails fast — no spend — on unknown/paused services or when the price exceeds the cap.',
      inputSchema: {
        id: z.number().int().positive().describe('service id to buy'),
        maxCspr: z
          .string()
          .optional()
          .describe('refuse invoices priced above this many CSPR (e.g. "3")'),
        method: z.string().optional().describe('HTTP method for the paid request (default GET)'),
        body: z.string().optional().describe('JSON request body to send with the paid request'),
      },
    },
    ({ id, maxCspr, method, body }) =>
      toolResult(async () => {
        const signer = deps.signerProvider();
        const { service, url, result } = await buyService({
          chain,
          signer,
          id,
          ...(maxCspr !== undefined ? { maxCspr } : {}),
          ...(method !== undefined ? { method } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.buyerKeyAlgo !== undefined ? { buyerKeyAlgo: deps.buyerKeyAlgo } : {}),
        });
        return {
          id: service.id,
          name: service.name,
          url,
          paid: result.paid,
          status: result.status,
          price: result.facilitator
            ? formatToken(result.facilitator.amount, result.facilitator.decimals, result.facilitator.symbol)
            : formatCspr(result.priceMotes ?? service.priceMotes),
          deployHash: result.deployHash,
          settlement: result.settlement,
          body: result.body,
        };
      }),
  );

  return server;
}

/** Build the server and serve it over stdio (the transport MCP clients spawn). */
export async function startAgentGateMcpServer(deps: McpServerDeps): Promise<void> {
  const server = buildAgentGateMcpServer(deps);
  await server.connect(new StdioServerTransport());
  // Human-facing hint on STDERR (never stdout — that is the JSON-RPC channel).
  // Without this, running `agentgate mcp` in a terminal looks like it hangs; it
  // is in fact a stdio server waiting for an MCP client to speak on stdin.
  process.stderr.write(
    'AgentGate MCP server ready on stdio — tools: agentgate_list_services, ' +
      'agentgate_get_service, agentgate_get_invoice, agentgate_buy.\n' +
      'It speaks JSON-RPC over stdin/stdout and waits for an MCP client ' +
      '(e.g. Claude Desktop). No further output here is normal — this is not a hang.\n',
  );
}
