import { describe, expect, it } from 'vitest';
import { AgentGateError, RECEIPT_ATTESTATION_STATUSES, parseGatewayReceipt } from '../src/index';

const PAYMENT_TX = 'D'.repeat(44);
const ATTEST_TX = 'E'.repeat(44);

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nonce: '424242',
    serviceId: 1,
    paymentTxHash: PAYMENT_TX,
    attestation: { status: 'recorded', txHash: ATTEST_TX },
    ...over,
  };
}

describe('parseGatewayReceipt', () => {
  it('names the five attestation statuses the gateway reports', () => {
    expect([...RECEIPT_ATTESTATION_STATUSES]).toEqual([
      'pending',
      'recorded',
      'skipped_self_paid',
      'skipped_upstream_failed',
      'failed',
    ]);
  });

  it('accepts a recorded receipt and drops fields it does not know', () => {
    const parsed = parseGatewayReceipt({ ...receipt(), payer: 'someone.testnet' });
    expect(parsed).toEqual({
      nonce: '424242',
      serviceId: 1,
      paymentTxHash: PAYMENT_TX,
      attestation: { status: 'recorded', txHash: ATTEST_TX },
    });
  });

  it('accepts every status, with or without a txHash', () => {
    for (const status of RECEIPT_ATTESTATION_STATUSES) {
      expect(parseGatewayReceipt(receipt({ attestation: { status } })).attestation).toEqual({ status });
    }
  });

  it.each([
    ['a non-object', 'nope'],
    ['an array', []],
    ['a non-decimal nonce', receipt({ nonce: 'abc' })],
    ['a missing nonce', receipt({ nonce: undefined })],
    ['serviceId 0', receipt({ serviceId: 0 })],
    ['a fractional serviceId', receipt({ serviceId: 1.5 })],
    ['a string serviceId', receipt({ serviceId: '1' })],
    ['a malformed paymentTxHash', receipt({ paymentTxHash: 'not-a-hash' })],
    ['a missing attestation', receipt({ attestation: undefined })],
    ['an unknown status', receipt({ attestation: { status: 'done' } })],
    ['a malformed attestation txHash', receipt({ attestation: { status: 'recorded', txHash: 'x' } })],
    ['a non-string attestation txHash', receipt({ attestation: { status: 'recorded', txHash: 7 } })],
  ])('rejects %s with BAD_RECEIPT', (_name, raw) => {
    let caught: unknown;
    try {
      parseGatewayReceipt(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentGateError);
    expect((caught as AgentGateError).code).toBe('BAD_RECEIPT');
  });
});
