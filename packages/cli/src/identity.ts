import { loadNearSigner } from '@agentgate/chain';
import type { AgentGateConfig, AnySigner } from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';
import { requireAccountId } from './validate';

/** The CLI resolves NEAR keys with the chain package's loader (one signer-from-config path). */
export { loadNearSigner, type LoadNearSignerOpts, type LoadedNearSigner } from '@agentgate/chain';

/** Whose key a command signs with: `wrap`/`pause`/`resume` act as the seller, `buy`/`mcp` as the buyer. */
export type SignerRole = 'seller' | 'buyer';

/** The signer flags every signing command takes. */
export interface SignerFlags {
  /** `--account <id>`: the account to act as (overrides the role's configured account). */
  account?: string;
  /** `--key-file <path>`: that account's near-cli credentials JSON. */
  keyFile?: string;
}

const ROLE_VARS = {
  seller: {
    account: 'SELLER_ACCOUNT_ID',
    keyPath: 'SELLER_KEY_PATH',
    secretKey: 'SELLER_PRIVATE_KEY',
    mockAccount: 'MOCK_SELLER_ACCOUNT',
  },
  buyer: {
    account: 'BUYER_ACCOUNT_ID',
    keyPath: 'BUYER_KEY_PATH',
    secretKey: 'BUYER_PRIVATE_KEY',
    mockAccount: 'MOCK_BUYER_ACCOUNT',
  },
} as const;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Notes this process already printed: one process can resolve many signers (the MCP server, one per buy). */
const printedNotes = new Set<string>();

/** Prints `note: <text>` to stderr once per process. */
function noteOnce(text: string): void {
  if (printedNotes.has(text)) return;
  printedNotes.add(text);
  process.stderr.write(`note: ${text}\n`);
}

/**
 * Account id of a signer. `wrap` uses it as the default payment target and
 * attestor. Mock and NEAR key signers both carry their account id.
 */
export function signerAccountId(signer: AnySigner): string {
  return requireAccountId(signer.accountId, 'signer.accountId');
}

/**
 * The account a command acts as for `role`, without touching any key: `--account`, else the
 * role's configured account (live: SELLER_ACCOUNT_ID / BUYER_ACCOUNT_ID; mock: MOCK_SELLER_ACCOUNT /
 * MOCK_BUYER_ACCOUNT). Read-only commands (`escrow balance`) use it, as `cliSigner` does.
 * Throws INVALID_ACCOUNT_ID for a malformed `--account` and SIGNER_MISSING when there is none.
 */
export function cliAccountId(config: AgentGateConfig, role: SignerRole, flags: SignerFlags = {}): string {
  const vars = ROLE_VARS[role];
  const flagAccount = isSet(flags.account) ? requireAccountId(flags.account, '--account') : undefined;

  if (config.mode === 'mock') {
    const accountId = flagAccount ?? (role === 'seller' ? config.mockSellerAccount : config.mockBuyerAccount);
    if (accountId === '') {
      throw new AgentGateError(
        'SIGNER_MISSING',
        `mock mode needs ${vars.mockAccount} (or --account <id>) — run \`neargate demo-accounts\` and paste the printed export lines first`,
        400,
      );
    }
    return accountId;
  }

  const accountId = flagAccount ?? (role === 'seller' ? config.sellerAccountId : config.buyerAccountId);
  if (accountId === '') {
    throw new AgentGateError(
      'SIGNER_MISSING',
      `live mode needs a ${role} account — pass --account <id> or set ${vars.account} ` +
        `(key: ${vars.secretKey}, --key-file <path> / ${vars.keyPath}, or ~/.near-credentials/${config.nearNetwork}/<account>.json)`,
      400,
    );
  }
  return accountId;
}

/**
 * The signer a command uses for `role`.
 *
 * - mock: `{kind: 'mock'}` for `--account`, else MOCK_SELLER_ACCOUNT / MOCK_BUYER_ACCOUNT.
 *   Mock signers carry no key: a given `--key-file` is ignored, with a note.
 * - live: the account is `--account`, else SELLER_ACCOUNT_ID / BUYER_ACCOUNT_ID; its key is
 *   resolved now (fail fast, before any chain call) by `loadNearSigner`, in its order: the
 *   role's *_PRIVATE_KEY, then `--key-file` (else the role's *_KEY_PATH), then
 *   `~/.near-credentials/<NEAR_NETWORK>/<account>.json`. Returns the resolved key source.
 *   A `--key-file` that the *_PRIVATE_KEY overrides gets a note.
 *
 * Notes go to stderr, once per process.
 */
export async function cliSigner(
  config: AgentGateConfig,
  role: SignerRole,
  flags: SignerFlags = {},
): Promise<AnySigner> {
  const vars = ROLE_VARS[role];
  const accountId = cliAccountId(config, role, flags);

  if (config.mode === 'mock') {
    if (isSet(flags.keyFile)) {
      noteOnce('mock mode ignores --key-file (mock signers carry no key)');
    }
    return { kind: 'mock', accountId };
  }

  const secretKey = role === 'seller' ? config.sellerPrivateKey : config.buyerPrivateKey;
  const keyPath = isSet(flags.keyFile) ? flags.keyFile : role === 'seller' ? config.sellerKeyPath : config.buyerKeyPath;
  if (isSet(secretKey) && isSet(flags.keyFile)) {
    noteOnce(
      `${vars.secretKey} is set and takes precedence over --key-file ` +
        '(key order: secret key, key file, ~/.near-credentials)',
    );
  }
  const { signer } = await loadNearSigner({
    accountId,
    network: config.nearNetwork,
    ...(isSet(secretKey) ? { secretKey } : {}),
    ...(isSet(keyPath) ? { keyPath } : {}),
  });
  return signer;
}
