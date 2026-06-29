import { describe, it, expect } from 'vitest';
import {
  X402_VERSION, X402_SCHEME,
  encodeXPayment, decodeXPayment, encodeXPaymentResponse, decodeXPaymentResponse,
  type PaymentPayload, type SettlementResponse,
} from '../src/x402';
import { AgentGateError } from '../src/index';

const goodPayload: PaymentPayload = {
  x402Version: 1, scheme: 'exact', network: 'casper-test',
  payload: { transaction: 'a'.repeat(64), transferId: '42', from: 'account-hash-' + 'b'.repeat(64) },
};

describe('x402 codec', () => {
  it('round-trips an X-PAYMENT payload', () => {
    const decoded = decodeXPayment(encodeXPayment(goodPayload));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('casper-test');
    expect(decoded.payload.transaction).toBe('a'.repeat(64));
    expect(decoded.payload.transferId).toBe('42');
    expect(decoded.payload.from).toBe('account-hash-' + 'b'.repeat(64));
  });

  it('round-trips a settlement response', () => {
    const s: SettlementResponse = { success: true, transaction: 'a'.repeat(64), network: 'casper-test', payer: 'account-hash-' + 'b'.repeat(64) };
    expect(decodeXPaymentResponse(encodeXPaymentResponse(s))).toEqual(s);
  });

  it('rejects non-base64 / non-JSON', () => {
    expect(() => decodeXPayment('@@@not-base64@@@')).toThrow(AgentGateError);
    expect(() => decodeXPayment(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('rejects wrong x402Version / scheme', () => {
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, x402Version: 2 }))).toThrow(/x402Version/);
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, scheme: 'upto' }))).toThrow(/scheme/);
  });

  it('rejects a bad transaction hash or non-u64 transferId', () => {
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, payload: { transaction: 'xyz', transferId: '42' } }))).toThrow(/transaction/);
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, payload: { transaction: 'a'.repeat(64), transferId: 'NaN' } }))).toThrow(/transferId/);
  });

  it('omits from when absent', () => {
    const decoded = decodeXPayment(encodeXPayment({ ...goodPayload, payload: { transaction: 'a'.repeat(64), transferId: '7' } }));
    expect(decoded.payload.from).toBeUndefined();
  });

  it('rejects a transferId that exceeds u64 max', () => {
    expect(() => decodeXPayment(encodeXPayment({
      ...goodPayload,
      payload: { transaction: 'a'.repeat(64), transferId: '99999999999999999999' },
    }))).toThrow(/u64|transferId/);
  });

  it('decodeXPaymentResponse rejects non-base64 / non-JSON', () => {
    expect(() => decodeXPaymentResponse('!!!not-valid-base64!!!')).toThrow(AgentGateError);
    expect(() => decodeXPaymentResponse(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('decodeXPaymentResponse rejects when success is not boolean', () => {
    const bad = encodeXPaymentResponse({ success: 'yes' as unknown as boolean, transaction: 'a'.repeat(64), network: 'casper-test' });
    expect(() => decodeXPaymentResponse(bad)).toThrow(AgentGateError);
  });

  it('decodeXPaymentResponse rejects when transaction or network are missing or empty', () => {
    const noTx = Buffer.from(JSON.stringify({ success: true, network: 'casper-test' }), 'utf8').toString('base64');
    expect(() => decodeXPaymentResponse(noTx)).toThrow(AgentGateError);
    const emptyNet = Buffer.from(JSON.stringify({ success: true, transaction: 'a'.repeat(64), network: '' }), 'utf8').toString('base64');
    expect(() => decodeXPaymentResponse(emptyNet)).toThrow(AgentGateError);
  });
});
