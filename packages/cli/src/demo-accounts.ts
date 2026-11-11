import { randomBytes } from 'node:crypto';
import type { Yocto } from '@agentgate/shared';
import { AgentGateError, nearToYocto } from '@agentgate/shared';
import type { FetchLike } from './types';
import { normalizeBaseUrl } from './validate';

/** Each demo account is faucet-funded with this many NEAR. */
export const DEMO_FAUCET_NEAR = '1000';

/** Fallback faucet timeout when no timeoutMs is supplied (ms). */
export const DEFAULT_FAUCET_TIMEOUT_MS = 15_000;

export interface CreateDemoAccountsOpts {
  /** Mock devnet base URL, e.g. http://localhost:4030. */
  devnetUrl: string;
  /** Timeout (ms) for each faucet POST. Defaults to DEFAULT_FAUCET_TIMEOUT_MS. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface DemoAccount {
  role: 'buyer' | 'seller';
  /** Mock account id: `<role>-<8 random hex>.mock`. */
  accountId: string;
  balanceYocto: Yocto;
}

export interface DemoAccountsResult {
  buyer: DemoAccount;
  seller: DemoAccount;
  /** Ready-to-paste shell lines: export MOCK_BUYER_ACCOUNT=… / export MOCK_SELLER_ACCOUNT=… */
  exportLines: [string, string];
}

/** `<role>-<8 random hex>.mock` — a fresh, valid NEAR-style account id on the mock devnet. */
export function generateMockAccountId(role: DemoAccount['role']): string {
  return `${role}-${randomBytes(4).toString('hex')}.mock`;
}

/**
 * Programmatic `agentgate demo-accounts` (mock mode only): generates a buyer and
 * a seller mock account id and faucets 1000 NEAR to each via `POST <devnet>/faucet`.
 */
export async function createDemoAccounts(
  opts: CreateDemoAccountsOpts,
): Promise<DemoAccountsResult> {
  const base = normalizeBaseUrl(opts.devnetUrl, 'devnetUrl');
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FAUCET_TIMEOUT_MS;
  const amountYocto = nearToYocto(DEMO_FAUCET_NEAR);

  const fund = async (role: DemoAccount['role']): Promise<DemoAccount> => {
    const accountId = generateMockAccountId(role);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: accountId, amountYocto }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AgentGateError(
          'GATEWAY_TIMEOUT',
          `devnet faucet at ${base}/faucet timed out after ${timeoutMs}ms — is the devnet running? (npm run dev), then re-run \`agentgate demo-accounts\``,
          504,
        );
      }
      throw new AgentGateError(
        'FAUCET_UNREACHABLE',
        `cannot reach the devnet faucet at ${base}/faucet (${err instanceof Error ? err.message : String(err)}) — is the devnet running? (npm run dev)`,
        502,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} failed: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
        502,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} returned non-JSON body (expected {"balanceYocto": "<yocto>"})`,
        502,
      );
    }
    const balanceYocto = (parsed as { balanceYocto?: unknown }).balanceYocto;
    if (typeof balanceYocto !== 'string' || !/^\d+$/.test(balanceYocto)) {
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} returned a malformed balanceYocto (expected a yocto decimal string)`,
        502,
      );
    }
    return { role, accountId, balanceYocto };
  };

  const buyer = await fund('buyer');
  const seller = await fund('seller');

  return {
    buyer,
    seller,
    exportLines: [
      `export MOCK_BUYER_ACCOUNT=${buyer.accountId}`,
      `export MOCK_SELLER_ACCOUNT=${seller.accountId}`,
    ],
  };
}
