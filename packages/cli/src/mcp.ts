import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { assertFetchableUrl, parsePaymentRequired, refuseRedirect } from '@agentgate/client';
import {
  AgentGateError,
  formatError,
  formatNear,
  formatPriceWithStorage,
  isMockNetwork,
  trustTier,
  type AnySigner,
  type ChainClient,
} from '@agentgate/shared';
import { buyService } from './buy';
import { escrowBalance } from './escrow';
import { listServices } from './list';

/**
 * NearGate as Model Context Protocol tools. Exposes the same discover → inspect
 * → pay loop the CLI drives, so any MCP-capable agent (Claude Desktop, a custom
 * client, an MCP-aware framework) gets NearGate natively — the agentic rail is
 * the product, and this is its native binding.
 *
 * Read tools (`list`, `get_service`, `get_invoice`, and `escrow_balance` with an explicit
 * account) need no key. Only `neargate_buy` spends NEAR, and it resolves the buyer signer
 * lazily so the read tools work with zero configuration. With `fromEscrow` it spends the
 * prepaid escrow through `pay_from_escrow`, which is what a restricted agent key can sign; with
 * `gasless` the gateway relays that call as a signed NEP-366 delegate and pays its gas.
 */
export interface McpServerDeps {
  chain: ChainClient;
  /**
   * Resolve the buyer signer. Called by `neargate_buy`, and by `neargate_escrow_balance` when
   * it is given no account, so the other read tools work even when no buyer key is configured
   * (the provider may throw a friendly "no buyer key" error, surfaced as a tool error rather
   * than a crash).
   */
  signerProvider: () => AnySigner | Promise<AnySigner>;
  /** Injectable fetch (tests / get_invoice). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

const MCP_NAME = 'neargate';
const MCP_VERSION = '0.1.6';
/** get_invoice gives the gateway this long to answer (ms). */
const INVOICE_FETCH_TIMEOUT_MS = 30_000;

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
    // Lead with the stable code so an agent can branch on it (BUDGET_EXCEEDED, SERVICE_INACTIVE…).
    const bad: ToolTextResult = { content: [{ type: 'text', text: formatError(err) }], isError: true };
    return bad;
  }
}

/** Build the NearGate MCP server with its tools registered (no transport attached). */
export function buildAgentGateMcpServer(deps: McpServerDeps): McpServer {
  const { chain } = deps;
  const server = new McpServer({ name: MCP_NAME, version: MCP_VERSION });

  server.registerTool(
    'neargate_list_services',
    {
      title: 'List NearGate services',
      description:
        'Discover the live on-chain NearGate catalog: every registered service with its price in NEAR (each call also attaches a 0.002 NEAR storage fee), trust tier, payment-backed score (successful/total paid calls), active flag, and gateway endpoint. Read-only — no payment.',
      inputSchema: {},
    },
    () =>
      toolResult(async () => {
        const listings = await listServices({ chain });
        return listings.map(({ service, score, tier }) => ({
          id: service.id,
          name: service.name,
          description: service.description,
          price: formatPriceWithStorage(service.priceYocto),
          priceYocto: service.priceYocto,
          tier,
          score: `${score.successCalls}/${score.totalCalls}`,
          active: service.active,
          endpoint: service.endpointUrl,
        }));
      }),
  );

  server.registerTool(
    'neargate_get_service',
    {
      title: 'Get one NearGate service',
      description:
        'Fetch full on-chain detail for one service id: name, description, price in NEAR (plus the 0.002 NEAR storage fee per call), payment target, owner, attestor, active flag, and its payment-backed trust score/tier. Read-only — no payment.',
      inputSchema: {
        id: z.number().int().positive().describe('service id, as shown by neargate_list_services'),
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
          price: formatPriceWithStorage(service.priceYocto),
          priceYocto: service.priceYocto,
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
    'neargate_get_invoice',
    {
      title: 'Get the x402 invoice for a service',
      description:
        'Fetch the machine-readable HTTP 402 payment invoice for a service WITHOUT paying — price and storage fee in NEAR, the total to attach, invoice nonce, registry contract, network — so an agent can decide before it spends. Read-only.',
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
        // The endpoint comes from the registry (seller-controlled bytes): http(s) only, and
        // off the devnet never a private/loopback host.
        await assertFetchableUrl(service.endpointUrl, { rejectPrivateHosts: !isMockNetwork(chain.network) });
        const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
        // Never follow a redirect: it would take the request past the URL check above.
        const res = await fetchImpl(service.endpointUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(INVOICE_FETCH_TIMEOUT_MS),
          redirect: 'manual',
        });
        await refuseRedirect(service.endpointUrl, res);
        const raw: unknown = await res.json().catch(() => null);
        if (res.status !== 402) {
          return { id, status: res.status, note: 'service did not return a 402 invoice', body: raw };
        }
        const req = parsePaymentRequired(raw, chain.network);
        return {
          id,
          price: formatPriceWithStorage(req.extra.priceYocto, req.extra.storageFeeYocto),
          priceYocto: req.extra.priceYocto,
          storageFeeYocto: req.extra.storageFeeYocto,
          maxAmountYocto: req.maxAmountRequired,
          payTo: req.payTo,
          network: req.network,
          nonce: req.extra.nonce,
          resource: req.resource,
          expiresAtMs: req.extra.expiresAtMs,
        };
      }),
  );

  server.registerTool(
    'neargate_buy',
    {
      title: 'Buy one call to a service (pays in NEAR)',
      description:
        'Autonomously pay a service’s 402 invoice in NEAR and return the response body. By default it makes a registry `pay` call (the invoice nonce rides the call; price + 0.002 NEAR storage fee attached) from the configured buyer key. With fromEscrow it calls `pay_from_escrow` instead: nothing is attached and the same total is debited from the buyer\'s prepaid escrow (see neargate_escrow_balance), so a key restricted to that method can pay. With gasless (implies fromEscrow) the buyer only signs that call as a NEP-366 delegate and the gateway relays it, paying the gas: the escrow pays the total and the account pays nothing; the gateway\'s 402 must offer a relayer (else RELAYER_UNAVAILABLE, nothing signed). Spending is capped by maxNear on the total. Fails fast — no spend — on unknown/paused services, when price + storage exceeds the cap (BUDGET_EXCEEDED), or when fromEscrow/gasless and the escrow holds less than the total (ERR_ESCROW_INSUFFICIENT).',
      inputSchema: {
        id: z.number().int().positive().describe('service id to buy'),
        maxNear: z
          .string()
          .optional()
          .describe('budget cap in NEAR on the total attached, price + storage fee (e.g. "3")'),
        fromEscrow: z
          .boolean()
          .optional()
          .describe('pay out of the prepaid escrow (pay_from_escrow) instead of attaching a deposit (default false)'),
        gasless: z
          .boolean()
          .optional()
          .describe('implies fromEscrow: sign pay_from_escrow as a delegate the gateway relays and pays the gas for (default false)'),
        method: z.string().optional().describe('HTTP method for the paid request (default GET)'),
        body: z.string().optional().describe('JSON request body to send with the paid request'),
      },
    },
    ({ id, maxNear, fromEscrow, gasless, method, body }) =>
      toolResult(async () => {
        const signer = await deps.signerProvider();
        const { service, url, result } = await buyService({
          chain,
          signer,
          id,
          ...(maxNear !== undefined ? { maxNear } : {}),
          ...(fromEscrow === true ? { fromEscrow: true } : {}),
          ...(gasless === true ? { gasless: true } : {}),
          ...(method !== undefined ? { method } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        });
        return {
          id: service.id,
          name: service.name,
          url,
          paid: result.paid,
          status: result.status,
          price: formatPriceWithStorage(
            result.priceYocto ?? service.priceYocto,
            result.requirements?.extra.storageFeeYocto,
          ),
          priceYocto: result.priceYocto,
          depositYocto: result.depositYocto,
          payFrom: result.payFrom,
          ...(result.gasless === true ? { gasless: true, relayer: result.relayer } : {}),
          txHash: result.txHash,
          settlement: result.settlement,
          body: result.body,
        };
      }),
  );

  server.registerTool(
    'neargate_escrow_balance',
    {
      title: 'Read an account’s prepaid escrow balance',
      description:
        'The NEAR still prepaid in an account’s registry escrow, which neargate_buy with fromEscrow spends (price + 0.002 NEAR storage fee per call). Defaults to the configured buyer account, so an agent can see its remaining budget before buying. Read-only — no payment.',
      inputSchema: {
        account: z.string().optional().describe('NEAR account id (default: the configured buyer account)'),
      },
    },
    ({ account }) =>
      toolResult(async () => {
        const accountId = account ?? (await deps.signerProvider()).accountId;
        const { escrowYocto } = await escrowBalance({ chain, account: accountId });
        return { account: accountId, escrowYocto, escrow: formatNear(escrowYocto) };
      }),
  );

  return server;
}

/** Build the server and serve it over stdio (the transport MCP clients spawn). */
export async function startAgentGateMcpServer(deps: McpServerDeps): Promise<void> {
  const server = buildAgentGateMcpServer(deps);
  await server.connect(new StdioServerTransport());
  // Human-facing hint on STDERR (never stdout — that is the JSON-RPC channel).
  // Without this, running `neargate mcp` in a terminal looks like it hangs; it
  // is in fact a stdio server waiting for an MCP client to speak on stdin.
  process.stderr.write(
    'NearGate MCP server ready on stdio — tools: neargate_list_services, ' +
      'neargate_get_service, neargate_get_invoice, neargate_buy, neargate_escrow_balance.\n' +
      'It speaks JSON-RPC over stdin/stdout and waits for an MCP client ' +
      '(e.g. Claude Desktop). No further output here is normal — this is not a hang.\n',
  );
}
