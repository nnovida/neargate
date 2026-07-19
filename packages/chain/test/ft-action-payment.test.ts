import { describe, expect, it } from 'vitest';
import { FACILITATOR_ASSETS, ftActionToPaymentEvent } from '../src/live';

/**
 * Facilitator-rail (CEP-18) payments settle as `transfer_with_authorization`,
 * which the native /transfers endpoint never returns — so listRecentActivity
 * reads ft-token actions and maps them through this pure helper. These lock the
 * mapping: a WCSPR transfer into a registered seller target becomes a `payment`
 * event denominated in the token (e.g. "0.1 WCSPR"), and everything else is
 * dropped rather than shown as a bogus native-CSPR row.
 */
const WCSPR = FACILITATOR_ASSETS[0];
if (!WCSPR) throw new Error('expected at least one facilitator asset (WCSPR)');
const TARGET = '19ffec2c950f361d7e4d66bb1b088d953278b21dfebcb3123f7cd401fb81b5f0';
const services = [{ id: 5, paymentTarget: `account-hash-${TARGET}` }];

describe('ftActionToPaymentEvent', () => {
  it('maps a WCSPR transfer into a service target to a token-denominated payment', () => {
    const ev = ftActionToPaymentEvent(
      {
        amount: '100000000', // 0.1 WCSPR (9 decimals)
        to_hash: TARGET,
        from_hash: 'ab'.repeat(32),
        deploy_hash: 'cd'.repeat(32),
        ft_action_type_id: 2,
        timestamp: '2026-07-19T11:40:03Z',
      },
      WCSPR,
      services,
    );
    expect(ev).not.toBeNull();
    expect(ev).toMatchObject({
      kind: 'payment',
      serviceId: 5,
      amountMotes: '100000000',
      assetSymbol: 'WCSPR',
      assetDecimals: 9,
      txHash: 'cd'.repeat(32),
      detail: 'payment of 0.1 WCSPR to 19ffec2c…b5f0',
    });
  });

  it('matches a prefixed to_hash against the prefixed service target', () => {
    const ev = ftActionToPaymentEvent(
      { amount: '2500000000', to_hash: `account-hash-${TARGET}`, ft_action_type_id: 2 },
      WCSPR,
      services,
    );
    expect(ev?.detail).toBe('payment of 2.5 WCSPR to 19ffec2c…b5f0');
  });

  it('ignores non-transfer actions (mint/approve/burn)', () => {
    expect(
      ftActionToPaymentEvent({ amount: '100000000', to_hash: TARGET, ft_action_type_id: 1 }, WCSPR, services),
    ).toBeNull();
  });

  it('ignores transfers into an address that is not a registered service target', () => {
    expect(
      ftActionToPaymentEvent({ amount: '100000000', to_hash: 'ff'.repeat(32), ft_action_type_id: 2 }, WCSPR, services),
    ).toBeNull();
  });

  it('returns null (not a throw) on an unparseable amount so one odd row never blanks the feed', () => {
    expect(
      ftActionToPaymentEvent(
        { amount: 12345 as unknown as string, to_hash: TARGET, ft_action_type_id: 2 },
        WCSPR,
        services,
      ),
    ).toBeNull();
  });
});
