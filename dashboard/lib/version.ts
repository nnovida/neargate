import { DEFAULT_REGISTRY_CONTRACT_ID } from '@agentgate/shared';

/**
 * Versions the docs describe. The registry contract id is sourced from the
 * shared package so it can never drift from what the gateway/CLI actually use;
 * bump `cli`/`sdk` when those packages publish a new version.
 * TODO(Task 7): DEFAULT_REGISTRY_CONTRACT_ID is '' until the testnet deploy.
 */
export const DOCS_VERSION = {
  cli: '0.2.1', // @neargate/cli
  sdk: '0.1.0', // @agentgate/client
  network: 'near-testnet',
  registryId: DEFAULT_REGISTRY_CONTRACT_ID,
} as const;

/** Registry contract id for the docs badge (NEAR account ids are already short). */
export const REGISTRY_ID_LABEL =
  DEFAULT_REGISTRY_CONTRACT_ID === '' ? 'not deployed' : DEFAULT_REGISTRY_CONTRACT_ID;
