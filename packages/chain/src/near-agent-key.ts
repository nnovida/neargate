import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { KeyPair, PublicKey, actions } from 'near-api-js';
import type { Action } from 'near-api-js';
import { AgentGateError, isEd25519PublicKey, isNearAccountId, parseYocto } from '@agentgate/shared';
import type { AnySigner, NearNetwork, Yocto } from '@agentgate/shared';
import { requireNearSigner } from './near-args';
import { TxTimeoutError } from './near-errors';
import { defaultCredentialsPath } from './near-keys';

/**
 * Restricted agent keys (ruling R48). An AI agent gets a NEAR function-call access key that can
 * call one method, `pay_from_escrow`, on the registry. That call attaches nothing, so the key can
 * spend the account's prepaid escrow and nothing else: it cannot withdraw (that needs 1 yocto
 * attached, which only a full-access key can do), deposit, register or move any other balance.
 * The escrow is the agent's spending limit; the allowance only pays its gas.
 */

/** The only registry method an agent key may call. */
export const AGENT_KEY_METHODS: readonly string[] = ['pay_from_escrow'];

function inputError(code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, 400);
}

/** The allowance as a bigint: a NEAR function-call key with allowance 0 cannot pay for any call. */
function checkAllowance(allowanceYocto: Yocto): bigint {
  const allowance = parseYocto(allowanceYocto); // INVALID_AMOUNT for anything but a u128 decimal string
  if (allowance === 0n) {
    throw inputError('INVALID_AMOUNT', 'the agent key allowance must be greater than zero: it pays the key\'s gas');
  }
  return allowance;
}

/**
 * The AddKey action for an agent key: a function-call key on `registryId` for `pay_from_escrow`
 * only, with `allowanceYocto` of gas. Throws INVALID_AMOUNT (allowance) or INVALID_INPUT (key).
 */
export function agentKeyAction(registryId: string, publicKey: string, allowanceYocto: Yocto): Action {
  const allowance = checkAllowance(allowanceYocto);
  if (!isEd25519PublicKey(publicKey)) {
    throw inputError('INVALID_INPUT', 'the agent public key is not an ed25519 NEAR public key (expected "ed25519:<base58>")');
  }
  const key = PublicKey.fromString(publicKey);
  return actions.addFunctionCallAccessKey(key, registryId, [...AGENT_KEY_METHODS], allowance);
}

/**
 * Where `neargate agent-key add` stores the key: next to the account's own key file,
 * `~/.near-credentials/<network>/<account>.neargate-agent.json`, never the file itself.
 */
export function agentKeyPath(network: NearNetwork, accountId: string): string {
  if (!isNearAccountId(accountId)) {
    throw inputError('INVALID_ACCOUNT_ID', `${JSON.stringify(String(accountId).slice(0, 80))} is not a NEAR account id`);
  }
  return join(dirname(defaultCredentialsPath(network, accountId)), `${accountId}.neargate-agent.json`);
}

export interface ProvisionAgentKeyOpts {
  /** The live client; only its `addAgentKey` is used. */
  client: { addAgentKey(input: { publicKey: string; allowanceYocto: Yocto }, signer: AnySigner): Promise<{ txHash: string }> };
  /** The account's full-access key: it signs the AddKey. */
  signer: AnySigner;
  /** The gas the agent key may spend, in yocto; must be above zero. */
  allowanceYocto: Yocto;
  network: NearNetwork;
  /** Overrides `agentKeyPath(network, account)`; for tests and scripts. */
  keyPath?: string;
}

export interface ProvisionedAgentKey {
  accountId: string;
  /** `ed25519:<base58>`, the key now on the account. */
  publicKey: string;
  /** The near-cli credentials file holding the secret; pass it as `--key-file`. */
  keyPath: string;
  /** The AddKey transaction. */
  txHash: string;
}

/**
 * Creates an agent key: a fresh ed25519 pair, the secret written to its key file (mode 0600,
 * created exclusively, so an existing file is never overwritten), then `addAgentKey` puts the
 * public half on the account. The file comes first so the secret has a home before the key
 * exists on chain. If the AddKey fails definitively (NEAR rejected it or it failed) the file is
 * removed again. If its outcome is unknown (TX_TIMEOUT) the tx may still land and the file is then
 * the only copy of the secret, so it is KEPT and the thrown TX_TIMEOUT names its path and the
 * public key and says to delete it if the tx failed. The secret is returned and thrown nowhere:
 * only the file holds it.
 */
export async function provisionAgentKey(opts: ProvisionAgentKeyOpts): Promise<ProvisionedAgentKey> {
  const signer = requireNearSigner(opts.signer);
  checkAllowance(opts.allowanceYocto);
  const keyPath = opts.keyPath ?? agentKeyPath(opts.network, signer.accountId);

  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  const credentials = JSON.stringify(
    { account_id: signer.accountId, public_key: publicKey, private_key: keyPair.toString() },
    null,
    2,
  );
  await writeNewKeyFile(keyPath, `${credentials}\n`);

  try {
    const { txHash } = await opts.client.addAgentKey({ publicKey, allowanceYocto: opts.allowanceYocto }, signer);
    return { accountId: signer.accountId, publicKey, keyPath, txHash };
  } catch (err) {
    if (err instanceof TxTimeoutError) {
      // The AddKey was sent and its outcome is unknown: it may still land, and then this file is
      // the only copy of the key's secret. Keep it (still 0600) and say where it is.
      throw err.withNote(
        `The new agent key was kept: public key ${publicKey}, key file ${keyPath} (mode 0600). ` +
          'If that transaction failed, delete the file before retrying',
      );
    }
    // A definitive failure: the key was never added, so the file would name a dead key.
    await unlink(keyPath).catch(() => undefined);
    throw err;
  }
}

/** Creates `path` (mode 0600) holding `content`; AGENT_KEY_EXISTS if anything is there already. */
async function writeNewKeyFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, 'wx', 0o600); // O_EXCL: neither a file nor a symlink there is followed or replaced
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw inputError(
        'AGENT_KEY_EXISTS',
        `the agent key file ${path} already exists: refusing to overwrite it (delete it first if you mean to replace that key)`,
      );
    }
    throw inputError('AGENT_KEY_UNWRITABLE', `cannot create the agent key file ${path}${code !== undefined ? ` (${code})` : ''}`);
  }
  try {
    await handle.chmod(0o600); // whatever the umask
    await handle.writeFile(content, 'utf8');
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    throw inputError('AGENT_KEY_UNWRITABLE', `cannot write the agent key file ${path}${code !== undefined ? ` (${code})` : ''}`);
  }
  await handle.close();
}
