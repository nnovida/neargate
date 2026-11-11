import { DEFAULT_REGISTRY_CONTRACT_ID } from '@agentgate/shared';

/** Config-bearing CLI flags shared across commands (all optional). */
export interface CliConfigFlags {
  mode?: string;
  /** NEAR RPC URL (`--rpc`). */
  rpc?: string;
  /** Registry contract id (`--registry`). */
  registry?: string;
  /** Seller key file (`--key-file`, near-cli credentials JSON). */
  keyFile?: string;
  adminToken?: string;
}

type Env = Record<string, string | undefined>;

/** First non-empty (trimmed) of flag, then env; else the fallback (may be undefined). */
function pick(
  flag: string | undefined,
  envVal: string | undefined,
  fallback?: string,
): string | undefined {
  if (flag !== undefined && flag.trim() !== '') return flag;
  if (envVal !== undefined && envVal.trim() !== '') return envVal;
  return fallback;
}

/**
 * Builds the env overlay the CLI hands to `loadConfig`. Precedence per key:
 * explicit flag > process.env (non-empty) > CLI built-in default. The published
 * CLI targets live testnet + the deployed registry by default; keys with no CLI
 * default are left to `loadConfig`'s own defaults (RPC URL, explorer URL, …).
 */
export function resolveCliEnv(flags: CliConfigFlags, env: Env = process.env): Env {
  const overlay: Env = { ...env };
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) overlay[key] = value;
  };
  set('AGENTGATE_MODE', pick(flags.mode, env.AGENTGATE_MODE, 'live'));
  set(
    'REGISTRY_CONTRACT_ID',
    pick(flags.registry, env.REGISTRY_CONTRACT_ID, DEFAULT_REGISTRY_CONTRACT_ID),
  );
  set('NEAR_RPC_URL', pick(flags.rpc, env.NEAR_RPC_URL));
  set('SELLER_KEY_PATH', pick(flags.keyFile, env.SELLER_KEY_PATH));
  set('AGENTGATE_ADMIN_TOKEN', pick(flags.adminToken, env.AGENTGATE_ADMIN_TOKEN));
  return overlay;
}
