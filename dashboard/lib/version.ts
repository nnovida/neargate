import { DEFAULT_REGISTRY_PACKAGE_HASH } from '@agentgate/shared';

/**
 * Versions the docs describe. The registry hash is sourced from the shared
 * package so it can never drift from what the gateway/CLI actually use; bump
 * `cli`/`sdk` when those packages publish a new version.
 */
export const DOCS_VERSION = {
  cli: '0.1.6', // @neargate/cli
  sdk: '0.1.0', // @agentgate/client
  network: 'casper-test',
  registryHash: DEFAULT_REGISTRY_PACKAGE_HASH,
} as const;

/** Compact form of the registry package hash for badges (e.g. `hash-10f92725…`). */
export const REGISTRY_HASH_SHORT = `${DEFAULT_REGISTRY_PACKAGE_HASH.slice(0, 13)}…`;
