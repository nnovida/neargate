import { randomBytes } from 'node:crypto';
import type { Motes } from '@agentgate/shared';
import { AgentGateError, csprToMotes } from '@agentgate/shared';
import type { FetchLike } from './types';
import { normalizeBaseUrl } from './validate';

/** Each demo account is faucet-funded with this many CSPR. */
export const DEMO_FAUCET_CSPR = '1000';

export interface CreateDemoAccountsOpts {
  /** Mock devnet base URL, e.g. http://localhost:4030. */
  devnetUrl: string;
  fetchImpl?: FetchLike;
}

export interface DemoAccount {
  role: 'buyer' | 'seller';
  /** Mock ed25519-style public key: "01" + 64 random hex chars. */
  publicKey: string;
  balanceMotes: Motes;
}

export interface DemoAccountsResult {
  buyer: DemoAccount;
  seller: DemoAccount;
  /** Ready-to-paste shell lines: export MOCK_BUYER_ACCOUNT=… / export MOCK_SELLER_ACCOUNT=… */
  exportLines: [string, string];
}

/** "01" + 64 random hex chars (32 CSPRNG bytes) — a valid mock devnet account key. */
export function generateMockPublicKey(): string {
  return `01${randomBytes(32).toString('hex')}`;
}

/**
 * Programmatic `agentgate demo-accounts` (mock mode only): generates a buyer and
 * a seller mock public key and faucets 1000 CSPR to each via `POST <devnet>/faucet`.
 */
export async function createDemoAccounts(
  opts: CreateDemoAccountsOpts,
): Promise<DemoAccountsResult> {
  const base = normalizeBaseUrl(opts.devnetUrl, 'devnetUrl');
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const amountMotes = csprToMotes(DEMO_FAUCET_CSPR);

  const fund = async (role: DemoAccount['role']): Promise<DemoAccount> => {
    const publicKey = generateMockPublicKey();
    let res: Response;
    try {
      res = await fetchImpl(`${base}/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: publicKey, amountMotes }),
      });
    } catch (err) {
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
        `faucet for ${role} returned non-JSON body (expected {"balanceMotes": "<motes>"})`,
        502,
      );
    }
    const balanceMotes = (parsed as { balanceMotes?: unknown }).balanceMotes;
    if (typeof balanceMotes !== 'string' || !/^\d+$/.test(balanceMotes)) {
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} returned a malformed balanceMotes (expected a motes decimal string)`,
        502,
      );
    }
    return { role, publicKey, balanceMotes };
  };

  const buyer = await fund('buyer');
  const seller = await fund('seller');

  return {
    buyer,
    seller,
    exportLines: [
      `export MOCK_BUYER_ACCOUNT=${buyer.publicKey}`,
      `export MOCK_SELLER_ACCOUNT=${seller.publicKey}`,
    ],
  };
}
