import { DEFAULT_REGISTRY_PACKAGE_HASH } from '@agentgate/shared';

/** Config-bearing CLI flags shared across commands (all optional). */
export interface CliConfigFlags {
  mode?: string;
  nodeUrl?: string;
  registry?: string;
  pem?: string;
  apiKey?: string;
  adminToken?: string;
  keyAlgo?: string;
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
 * CLI targets live Testnet + the deployed registry by default; keys with no CLI
 * default are left to `loadConfig`'s own defaults (node URL, cloud URL, …).
 */
export function resolveCliEnv(flags: CliConfigFlags, env: Env = process.env): Env {
  const overlay: Env = { ...env };
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) overlay[key] = value;
  };
  set('AGENTGATE_MODE', pick(flags.mode, env.AGENTGATE_MODE, 'live'));
  set(
    'REGISTRY_CONTRACT_PACKAGE_HASH',
    pick(flags.registry, env.REGISTRY_CONTRACT_PACKAGE_HASH, DEFAULT_REGISTRY_PACKAGE_HASH),
  );
  set('CASPER_NODE_URL', pick(flags.nodeUrl, env.CASPER_NODE_URL));
  set('SELLER_SIGNER_PEM_PATH', pick(flags.pem, env.SELLER_SIGNER_PEM_PATH));
  set('CSPR_CLOUD_API_KEY', pick(flags.apiKey, env.CSPR_CLOUD_API_KEY));
  set('AGENTGATE_ADMIN_TOKEN', pick(flags.adminToken, env.AGENTGATE_ADMIN_TOKEN));
  set('BUYER_KEY_ALGO', pick(flags.keyAlgo, env.BUYER_KEY_ALGO));
  return overlay;
}
