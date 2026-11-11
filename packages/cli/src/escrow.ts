import {
  AgentGateError,
  ESCROW_STORAGE_FEE_YOCTO,
  compareYocto,
  formatNear,
  nearToYocto,
  stripTrailingSlashes,
  type AnySigner,
  type ChainClient,
  type Yocto,
} from '@agentgate/shared';
import { requireAccountId } from './validate';

/** The escrow surface of a chain client: all `neargate escrow` needs. */
type EscrowChain = Pick<ChainClient, 'escrowOf' | 'depositEscrow' | 'withdrawEscrow'>;

export interface EscrowChangeResult {
  accountId: string;
  /** What the command moved: the attached deposit, or the amount withdrawn. */
  amountYocto: Yocto;
  /** The escrow just before the call. */
  escrowBeforeYocto: Yocto;
  /** The escrow just after it. */
  escrowYocto: Yocto;
  txHash: string;
}

/** A NEAR amount flag as yocto, above zero: moving nothing is never what was meant. */
function positiveAmount(amountNear: string): Yocto {
  const yocto = nearToYocto(amountNear); // INVALID_AMOUNT for anything but a plain decimal of at most 24 places
  if (yocto === '0') {
    throw new AgentGateError('INVALID_AMOUNT', `the amount must be greater than zero, got ${JSON.stringify(amountNear)}`, 400);
  }
  return yocto;
}

/**
 * Programmatic `neargate escrow deposit <near>`: attaches the amount to `deposit_escrow`. The
 * first deposit of an account keeps 0.002 NEAR for the escrow's storage (and must be more than
 * that); the result reports the escrow before and after so the caller can say what was credited.
 */
export async function depositToEscrow(opts: {
  chain: EscrowChain;
  signer: AnySigner;
  amountNear: string;
}): Promise<EscrowChangeResult> {
  const { chain, signer } = opts;
  const amountYocto = positiveAmount(opts.amountNear);
  const escrowBeforeYocto = await chain.escrowOf(signer.accountId);
  const { txHash } = await chain.depositEscrow(amountYocto, signer);
  const escrowYocto = await chain.escrowOf(signer.accountId);
  return { accountId: signer.accountId, amountYocto, escrowBeforeYocto, escrowYocto, txHash };
}

/**
 * Programmatic `neargate escrow withdraw <near>`: `withdraw_escrow` attaches exactly 1 yocto, so
 * only the account's full-access key can sign it. Refuses an amount above the escrow before
 * sending, so no gas is burned on a call the registry would reject.
 */
export async function withdrawFromEscrow(opts: {
  chain: EscrowChain;
  signer: AnySigner;
  amountNear: string;
}): Promise<EscrowChangeResult> {
  const { chain, signer } = opts;
  const amountYocto = positiveAmount(opts.amountNear);
  const escrowBeforeYocto = await chain.escrowOf(signer.accountId);
  if (compareYocto(amountYocto, escrowBeforeYocto) > 0) {
    throw new AgentGateError(
      'ERR_ESCROW_INSUFFICIENT',
      `ERR_ESCROW_INSUFFICIENT: the amount must be between 1 and the escrow balance, ${escrowBeforeYocto} yocto; nothing was sent`,
      402, // like the client's own pre-send refusals (BUDGET_EXCEEDED, ERR_ESCROW_INSUFFICIENT)
    );
  }
  const { txHash } = await chain.withdrawEscrow(amountYocto, signer);
  const escrowYocto = await chain.escrowOf(signer.accountId);
  return { accountId: signer.accountId, amountYocto, escrowBeforeYocto, escrowYocto, txHash };
}

/**
 * The account `escrow balance` reads when one is named: the `[account]` argument or `--account`
 * (undefined when neither: the buyer account). Naming two different accounts is ambiguous, so it
 * is refused rather than silently picking one.
 */
export function balanceAccountArg(positional: string | undefined, flag: string | undefined): string | undefined {
  const named = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';
  if (named(positional) && named(flag) && positional.trim() !== flag.trim()) {
    throw new AgentGateError(
      'INVALID_INPUT',
      `escrow balance got two different accounts, ${JSON.stringify(positional.slice(0, 64))} and --account ${JSON.stringify(flag.slice(0, 64))}: name one`,
      400,
    );
  }
  return named(positional) ? positional : named(flag) ? flag : undefined;
}

/** Programmatic `neargate escrow balance [account]`: the account's escrow, `"0"` if it never deposited. */
export async function escrowBalance(opts: {
  chain: Pick<ChainClient, 'escrowOf'>;
  account: string;
}): Promise<{ accountId: string; escrowYocto: Yocto }> {
  const accountId = requireAccountId(opts.account, 'account');
  return { accountId, escrowYocto: await opts.chain.escrowOf(accountId) };
}

/** The lines `neargate escrow deposit|withdraw` prints; `explorerUrl` (live mode) adds the tx link. */
export function formatEscrowChange(
  kind: 'deposit' | 'withdraw',
  result: EscrowChangeResult,
  opts: { explorerUrl?: string } = {},
): string[] {
  const lines = [
    `account:    ${result.accountId}`,
    `${kind === 'deposit' ? 'deposited: ' : 'withdrawn: '} ${formatNear(result.amountYocto)}`,
    `escrow:     ${formatNear(result.escrowYocto)}`,
    `tx:         ${result.txHash}`,
  ];
  if (opts.explorerUrl !== undefined) lines.push(`explorer:   ${stripTrailingSlashes(opts.explorerUrl)}/txns/${result.txHash}`);
  if (kind === 'deposit' && keptStorageFee(result)) {
    lines.push(`note:       the first deposit keeps ${formatNear(ESCROW_STORAGE_FEE_YOCTO)} as the escrow's storage fee`);
  }
  return lines;
}

/** True when the escrow grew by exactly the deposit minus the storage fee: an account's first deposit. */
function keptStorageFee(result: EscrowChangeResult): boolean {
  const credited = BigInt(result.escrowYocto) - BigInt(result.escrowBeforeYocto);
  return credited === BigInt(result.amountYocto) - BigInt(ESCROW_STORAGE_FEE_YOCTO);
}

/** The lines `neargate escrow balance` prints. */
export function formatEscrowBalance(result: { accountId: string; escrowYocto: Yocto }): string[] {
  return [`account:  ${result.accountId}`, `escrow:   ${formatNear(result.escrowYocto)}`];
}
