import { provisionAgentKey, type ProvisionAgentKeyOpts, type ProvisionedAgentKey } from '@agentgate/chain';
import {
  AgentGateError,
  formatNear,
  nearToYocto,
  stripTrailingSlashes,
  type AgentGateMode,
  type AnySigner,
  type NearNetwork,
  type Yocto,
} from '@agentgate/shared';

export interface AddedAgentKey extends ProvisionedAgentKey {
  allowanceYocto: Yocto;
}

/**
 * `agent-key` is live only: an agent key is a NEAR access key, which the offline devnet does not
 * model (its mock signers carry no key at all).
 */
export function assertAgentKeysAvailable(mode: AgentGateMode): void {
  if (mode !== 'live') {
    throw new AgentGateError(
      'LIVE_ONLY',
      'agent keys need live mode: they are NEAR access keys, which the offline devnet does not model (use --mode live)',
      400,
    );
  }
}

/**
 * Programmatic `neargate agent-key add --allowance <near>`: generates an ed25519 key, stores its
 * secret in `~/.near-credentials/<network>/<account>.neargate-agent.json` (mode 0600, never
 * overwritten) and adds it to the account as a function-call key that may call only
 * `pay_from_escrow` on the registry, with `allowanceNear` for gas. `signer` is the account's
 * full-access key.
 */
export async function addAgentKey(opts: {
  client: ProvisionAgentKeyOpts['client'];
  signer: AnySigner;
  allowanceNear: string;
  network: NearNetwork;
}): Promise<AddedAgentKey> {
  const allowanceYocto = nearToYocto(opts.allowanceNear); // INVALID_AMOUNT; provisionAgentKey refuses zero
  const key = await provisionAgentKey({
    client: opts.client,
    signer: opts.signer,
    allowanceYocto,
    network: opts.network,
  });
  return { ...key, allowanceYocto };
}

/**
 * The lines `agent-key add` prints: the public key, the key file's path and the next command, never
 * the secret (this function does not even receive it). `explorerUrl` (live mode) adds the tx link.
 */
export function formatAgentKeyAdded(added: AddedAgentKey, opts: { explorerUrl?: string } = {}): string[] {
  const lines = [
    `account:     ${added.accountId}`,
    `public key:  ${added.publicKey}`,
    `key file:    ${added.keyPath}`,
    `allowance:   ${formatNear(added.allowanceYocto)} (the key's gas; it can call pay_from_escrow on the registry and nothing else)`,
    `add_key tx:  ${added.txHash}`,
  ];
  if (opts.explorerUrl !== undefined) lines.push(`explorer:    ${stripTrailingSlashes(opts.explorerUrl)}/txns/${added.txHash}`);
  lines.push(
    '',
    'the agent spends the escrow with:',
    `  neargate buy <id> --from-escrow --account ${added.accountId} --key-file ${added.keyPath}`,
  );
  return lines;
}
