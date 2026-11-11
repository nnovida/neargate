import { describe, expect, it, vi } from 'vitest';
import {
  AgentGateError,
  ESCROW_STORAGE_FEE_YOCTO,
  nearToYocto,
  type AnySigner,
  type ChainClient,
  type Yocto,
} from '@agentgate/shared';
import {
  depositToEscrow,
  escrowBalance,
  formatEscrowBalance,
  formatEscrowChange,
  balanceAccountArg,
  withdrawFromEscrow,
} from '../src/escrow';

const BUYER: AnySigner = { kind: 'mock', accountId: 'buyer.mock' };
const TX = 'Akiy3SNDadKPsZw3dFkzzYAYyudnMqyhTkL5rUwCYZ6F';
const FEE = BigInt(ESCROW_STORAGE_FEE_YOCTO);

/**
 * A chain with a stateful escrow ledger shaped like the registry's (first deposit keeps the fee,
 * withdrawals debit), recording every call. Only the escrow surface exists; anything else throws.
 */
function ledgerChain(initial?: bigint): Pick<ChainClient, 'escrowOf' | 'depositEscrow' | 'withdrawEscrow'> & {
  calls: string[];
  balances: Map<string, bigint>;
} {
  const balances = new Map<string, bigint>();
  if (initial !== undefined) balances.set('buyer.mock', initial);
  const calls: string[] = [];
  return {
    calls,
    balances,
    escrowOf: vi.fn(async (accountId: string): Promise<Yocto> => {
      calls.push(`escrowOf ${accountId}`);
      return (balances.get(accountId) ?? 0n).toString();
    }),
    depositEscrow: vi.fn(async (amount: Yocto, signer: AnySigner) => {
      calls.push(`depositEscrow ${amount}`);
      const existing = balances.get(signer.accountId);
      balances.set(signer.accountId, (existing ?? 0n) + BigInt(amount) - (existing === undefined ? FEE : 0n));
      return { txHash: TX };
    }),
    withdrawEscrow: vi.fn(async (amount: Yocto, signer: AnySigner) => {
      calls.push(`withdrawEscrow ${amount}`);
      balances.set(signer.accountId, (balances.get(signer.accountId) ?? 0n) - BigInt(amount));
      return { txHash: TX };
    }),
  };
}

async function rejection(promise: Promise<unknown>): Promise<AgentGateError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentGateError);
    return error as AgentGateError;
  }
  throw new Error('expected a rejection');
}

describe('depositToEscrow', () => {
  it('deposits the NEAR amount as yocto and reports the escrow before and after (the first deposit keeps the fee)', async () => {
    const chain = ledgerChain();
    const result = await depositToEscrow({ chain, signer: BUYER, amountNear: '1' });
    expect(chain.depositEscrow).toHaveBeenCalledWith(nearToYocto('1'), BUYER);
    expect(result).toEqual({
      accountId: 'buyer.mock',
      amountYocto: nearToYocto('1'),
      escrowBeforeYocto: '0',
      escrowYocto: nearToYocto('0.998'),
      txHash: TX,
    });
  });

  it('refuses a zero, negative, malformed or over-precise amount (INVALID_AMOUNT) before any chain call', async () => {
    const chain = ledgerChain();
    for (const bad of ['0', '0.0', '-1', '1e3', 'abc', '', '0.0000000000000000000000001']) {
      expect((await rejection(depositToEscrow({ chain, signer: BUYER, amountNear: bad }))).code, bad).toBe('INVALID_AMOUNT');
    }
    expect(chain.calls).toEqual([]);
  });

  it('passes the registry\'s own refusal through (ERR_DEPOSIT_TOO_LOW)', async () => {
    const chain = ledgerChain();
    chain.depositEscrow = vi.fn(async () => {
      throw new AgentGateError('ERR_DEPOSIT_TOO_LOW', 'ERR_DEPOSIT_TOO_LOW: the first deposit must be more than …', 400);
    });
    expect((await rejection(depositToEscrow({ chain, signer: BUYER, amountNear: '0.002' }))).code).toBe('ERR_DEPOSIT_TOO_LOW');
  });
});

describe('withdrawFromEscrow', () => {
  it('withdraws up to the whole balance and reports what is left', async () => {
    const chain = ledgerChain(BigInt(nearToYocto('1')));
    const result = await withdrawFromEscrow({ chain, signer: BUYER, amountNear: '0.25' });
    expect(chain.withdrawEscrow).toHaveBeenCalledWith(nearToYocto('0.25'), BUYER);
    expect(result).toEqual({
      accountId: 'buyer.mock',
      amountYocto: nearToYocto('0.25'),
      escrowBeforeYocto: nearToYocto('1'),
      escrowYocto: nearToYocto('0.75'),
      txHash: TX,
    });
    expect((await withdrawFromEscrow({ chain, signer: BUYER, amountNear: '0.75' })).escrowYocto).toBe('0');
  });

  it('refuses more than the escrow holds with ERR_ESCROW_INSUFFICIENT, before sending (no gas burned)', async () => {
    const chain = ledgerChain(BigInt(nearToYocto('1')));
    const err = await rejection(withdrawFromEscrow({ chain, signer: BUYER, amountNear: '1.000000000000000000000001' }));
    // 402, the status the client gives its own refusals before sending (BUDGET_EXCEEDED, ERR_ESCROW_INSUFFICIENT)
    expect(err).toMatchObject({ code: 'ERR_ESCROW_INSUFFICIENT', httpStatus: 402 });
    expect(err.message).toBe(
      `ERR_ESCROW_INSUFFICIENT: the amount must be between 1 and the escrow balance, ${nearToYocto('1')} yocto; nothing was sent`,
    );
    expect(chain.withdrawEscrow).not.toHaveBeenCalled();
    // an account without an escrow has nothing to withdraw either
    const empty = ledgerChain();
    expect((await rejection(withdrawFromEscrow({ chain: empty, signer: BUYER, amountNear: '0.1' }))).code).toBe('ERR_ESCROW_INSUFFICIENT');
    expect(empty.withdrawEscrow).not.toHaveBeenCalled();
  });

  it('refuses a zero or malformed amount (INVALID_AMOUNT) before any chain call', async () => {
    const chain = ledgerChain(BigInt(nearToYocto('1')));
    for (const bad of ['0', '-0.5', 'x']) {
      expect((await rejection(withdrawFromEscrow({ chain, signer: BUYER, amountNear: bad }))).code, bad).toBe('INVALID_AMOUNT');
    }
    expect(chain.calls).toEqual([]);
  });
});

describe('escrowBalance', () => {
  it('reads the named account\'s escrow; "0" for one that never deposited', async () => {
    const chain = ledgerChain(BigInt(nearToYocto('0.498')));
    expect(await escrowBalance({ chain, account: 'buyer.mock' })).toEqual({ accountId: 'buyer.mock', escrowYocto: nearToYocto('0.498') });
    expect(await escrowBalance({ chain, account: 'ghost.mock' })).toEqual({ accountId: 'ghost.mock', escrowYocto: '0' });
  });

  it('validates the account id (INVALID_ACCOUNT_ID) before any chain call', async () => {
    const chain = ledgerChain();
    for (const bad of ['Not An Account', 'a', '../x']) {
      expect((await rejection(escrowBalance({ chain, account: bad }))).code, bad).toBe('INVALID_ACCOUNT_ID');
    }
    expect((await rejection(escrowBalance({ chain, account: '  ' }))).code).toBe('INVALID_INPUT'); // blank, like every account flag
    expect(chain.calls).toEqual([]);
  });
});

describe('balanceAccountArg · [account] and --account', () => {
  it('takes whichever one is named, or neither (the caller then uses the buyer account)', () => {
    expect(balanceAccountArg('a.testnet', undefined)).toBe('a.testnet');
    expect(balanceAccountArg(undefined, 'b.testnet')).toBe('b.testnet');
    expect(balanceAccountArg(undefined, undefined)).toBeUndefined();
    expect(balanceAccountArg('  ', '')).toBeUndefined();
  });

  it('accepts both when they are the same account', () => {
    expect(balanceAccountArg('a.testnet', 'a.testnet')).toBe('a.testnet');
  });

  it('refuses two different accounts instead of silently picking one', () => {
    expect(() => balanceAccountArg('a.testnet', 'b.testnet')).toThrow(
      expect.objectContaining({
        code: 'INVALID_INPUT',
        httpStatus: 400,
        message: expect.stringMatching(/two different accounts, "a\.testnet" and --account "b\.testnet": name one/),
      }),
    );
  });
});

describe('the printed lines', () => {
  const result = {
    accountId: 'buyer.mock',
    amountYocto: nearToYocto('1'),
    escrowBeforeYocto: '0',
    escrowYocto: nearToYocto('0.998'),
    txHash: TX,
  };

  it('a first deposit says what was kept for storage', () => {
    expect(formatEscrowChange('deposit', result)).toEqual([
      'account:    buyer.mock',
      'deposited:  1 NEAR',
      'escrow:     0.998 NEAR',
      `tx:         ${TX}`,
      'note:       the first deposit keeps 0.002 NEAR as the escrow\'s storage fee',
    ]);
  });

  it('a top-up has no storage note, and live mode adds the explorer link', () => {
    const lines = formatEscrowChange(
      'deposit',
      { ...result, escrowBeforeYocto: nearToYocto('0.998'), escrowYocto: nearToYocto('1.998') },
      { explorerUrl: 'https://testnet.nearblocks.io/' },
    );
    expect(lines).toEqual([
      'account:    buyer.mock',
      'deposited:  1 NEAR',
      'escrow:     1.998 NEAR',
      `tx:         ${TX}`,
      `explorer:   https://testnet.nearblocks.io/txns/${TX}`,
    ]);
  });

  it('a withdrawal and a balance read', () => {
    expect(formatEscrowChange('withdraw', { ...result, amountYocto: nearToYocto('0.25'), escrowYocto: nearToYocto('0.748') })).toEqual([
      'account:    buyer.mock',
      'withdrawn:  0.25 NEAR',
      'escrow:     0.748 NEAR',
      `tx:         ${TX}`,
    ]);
    expect(formatEscrowBalance({ accountId: 'buyer.mock', escrowYocto: nearToYocto('0.498') })).toEqual([
      'account:  buyer.mock',
      'escrow:   0.498 NEAR',
    ]);
    expect(formatEscrowBalance({ accountId: 'ghost.mock', escrowYocto: '0' })).toEqual(['account:  ghost.mock', 'escrow:   0 NEAR']);
  });
});
