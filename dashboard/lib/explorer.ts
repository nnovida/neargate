/**
 * NEAR explorer links (R39). The explorer base comes from the server's config
 * (`NEAR_EXPLORER_URL`, default testnet nearblocks) and travels to client components inside the API
 * responses, so no explorer host is hard-coded here beyond the testnet default.
 *
 * Nothing links on the offline devnet (`near-mock`), which no explorer indexes. Every id that goes
 * into a path is validated first: attestation tx fields are free text written by the attestor.
 */
import { isMockNetwork, isNearAccountId, isNearTxHash } from '@agentgate/shared';
import { httpUrl } from './links';

/** Default explorer: the NEAR testnet nearblocks site. */
export const DEFAULT_EXPLORER_URL = 'https://testnet.nearblocks.io';

type Env = Record<string, string | undefined>;

function trimmedEnv(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The explorer base for server-rendered pages (the docs): `NEXT_PUBLIC_NEAR_EXPLORER_URL`, else
 * `NEAR_EXPLORER_URL` (the variable the gateway and the CLI read), else the testnet default.
 */
export function explorerBaseFromEnv(env: Env = process.env): string {
  return trimmedEnv(env, 'NEXT_PUBLIC_NEAR_EXPLORER_URL') ?? trimmedEnv(env, 'NEAR_EXPLORER_URL') ?? DEFAULT_EXPLORER_URL;
}

/** The usable explorer base (http(s), no trailing slash) for a network, or null: mock, unset, or not http(s). */
function explorerBase(network: string, explorerUrl: string | undefined): string | null {
  if (isMockNetwork(network) || explorerUrl === undefined) return null;
  const base = httpUrl(explorerUrl);
  return base === null ? null : base.replace(/\/+$/, '');
}

export interface TxLink {
  kind: 'tx' | 'block';
  href: string;
}

/**
 * Where to send a reader for one chain event: its transaction when the hash is known and real,
 * else (a contract view cannot know its own tx, so live activity has none) its block.
 */
export function txHref(args: {
  network: string;
  explorerUrl: string | undefined;
  hash: string | null;
  blockHeight?: number;
}): TxLink | null {
  const base = explorerBase(args.network, args.explorerUrl);
  if (base === null) return null;
  if (args.hash !== null) {
    // A hash that is no NEAR tx hash is shown as text; it never reaches a URL.
    return isNearTxHash(args.hash) ? { kind: 'tx', href: `${base}/txns/${args.hash}` } : null;
  }
  const height = args.blockHeight;
  if (height !== undefined && Number.isSafeInteger(height) && height > 0) {
    return { kind: 'block', href: `${base}/blocks/${height}` };
  }
  return null;
}

/** `<explorer>/address/<id>` for a NEAR account on a live network, else null. */
export function accountHref(args: {
  network: string;
  explorerUrl: string | undefined;
  accountId: string;
}): string | null {
  const base = explorerBase(args.network, args.explorerUrl);
  if (base === null || !isNearAccountId(args.accountId)) return null;
  return `${base}/address/${args.accountId}`;
}
