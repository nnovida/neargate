import { describe, it, expect } from 'vitest';
import {
  X402_VERSION, X402_SCHEME, X402_ASSET_NEAR,
  encodeXPayment, decodeXPayment, encodeXPaymentResponse, decodeXPaymentResponse,
  isNearAccountId, caip2For,
  type PaymentPayload, type PaymentRequirements, type SettlementResponse,
} from '../src/x402';
import { AgentGateError } from '../src/index';

const TX_44 = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';
const TX_43 = 'WmErKxQ1tQRUZcGT9Cdi4TfXreqYR78BWrKR7e7gvJc';
const SIGNED_DELEGATE = Buffer.from('borsh-encoded SignedDelegate bytes', 'utf8').toString('base64');

const txPayment: PaymentPayload = {
  x402Version: 1, scheme: 'exact', network: 'near-testnet',
  payload: { kind: 'tx', transaction: TX_44, nonce: '42', payer: 'buyer.testnet' },
};

const delegatePayment: PaymentPayload = {
  x402Version: 1, scheme: 'exact', network: 'near-testnet',
  payload: { kind: 'delegate', signedDelegate: SIGNED_DELEGATE, nonce: '7', payer: 'buyer.testnet' },
};

/** Encodes an arbitrary (possibly malformed) X-PAYMENT body. */
function rawHeader(body: unknown): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

function withPayload(payload: Record<string, unknown>): string {
  return rawHeader({ x402Version: 1, scheme: 'exact', network: 'near-testnet', payload });
}

describe('x402 constants', () => {
  it('pins version 1, scheme exact, asset NEAR', () => {
    expect(X402_VERSION).toBe(1);
    expect(X402_SCHEME).toBe('exact');
    expect(X402_ASSET_NEAR).toBe('NEAR');
  });

  it('PaymentRequirements carries the NEAR registry extra (type-level shape)', () => {
    const req: PaymentRequirements = {
      scheme: X402_SCHEME,
      network: 'near-testnet',
      maxAmountRequired: '502000000000000000000000',
      asset: X402_ASSET_NEAR,
      payTo: 'registry.testnet',
      resource: 'http://localhost:4021/svc/1',
      description: 'demo',
      maxTimeoutSeconds: 300,
      extra: {
        nonce: '42',
        serviceId: 1,
        expiresAtMs: 1,
        settlement: 'neargate-registry-pay',
        contractId: 'registry.testnet',
        method: 'pay',
        priceYocto: '500000000000000000000000',
        storageFeeYocto: '2000000000000000000000',
        seller: 'seller.testnet',
        caip2: caip2For('near-testnet'),
      },
    };
    expect(req.extra.relayer).toBeUndefined();
  });
});

describe('x402 codec', () => {
  it('round-trips a tx payload', () => {
    expect(decodeXPayment(encodeXPayment(txPayment))).toEqual(txPayment);
  });

  it('round-trips a delegate payload', () => {
    expect(decodeXPayment(encodeXPayment(delegatePayment))).toEqual(delegatePayment);
  });

  it('accepts a 43-char base58 tx hash', () => {
    const decoded = decodeXPayment(withPayload({ kind: 'tx', transaction: TX_43, nonce: '1', payer: 'buyer.testnet' }));
    expect(decoded.payload).toEqual({ kind: 'tx', transaction: TX_43, nonce: '1', payer: 'buyer.testnet' });
  });

  it('drops unknown payload fields', () => {
    const decoded = decodeXPayment(withPayload({ kind: 'tx', transaction: TX_44, nonce: '42', payer: 'buyer.testnet', extra: 'x' }));
    expect(decoded.payload).toEqual(txPayment.payload);
  });

  it('rejects non-base64 / non-JSON', () => {
    expect(() => decodeXPayment('@@@not-base64@@@')).toThrow(AgentGateError);
    expect(() => decodeXPayment(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('rejects wrong x402Version / scheme / empty network', () => {
    expect(() => decodeXPayment(encodeXPayment({ ...txPayment, x402Version: 2 }))).toThrow(/x402Version/);
    expect(() => decodeXPayment(encodeXPayment({ ...txPayment, scheme: 'upto' }))).toThrow(/scheme/);
    expect(() => decodeXPayment(encodeXPayment({ ...txPayment, network: ' ' }))).toThrow(/network/);
  });

  it('rejects a tx hash that is not base58 of 43–44 chars', () => {
    for (const transaction of ['a'.repeat(64), '0'.repeat(44), 'O'.repeat(44), 'l'.repeat(43), TX_44 + 'A', TX_43.slice(0, 42), '', 42]) {
      expect(
        () => decodeXPayment(withPayload({ kind: 'tx', transaction, nonce: '42', payer: 'buyer.testnet' })),
        `should reject ${JSON.stringify(transaction)}`,
      ).toThrow(/transaction/);
    }
  });

  it('rejects a nonce that is not 1–20 digits', () => {
    for (const nonce of ['', '1'.repeat(21), '12a', '-1', ' 1', '1.5', 42]) {
      expect(
        () => decodeXPayment(withPayload({ kind: 'tx', transaction: TX_44, nonce, payer: 'buyer.testnet' })),
        `should reject ${JSON.stringify(nonce)}`,
      ).toThrow(/nonce/);
    }
    // 20 digits is the contract's upper bound and is accepted.
    expect(decodeXPayment(withPayload({ kind: 'tx', transaction: TX_44, nonce: '9'.repeat(20), payer: 'buyer.testnet' })).payload.nonce)
      .toBe('9'.repeat(20));
  });

  it('rejects a payer that is not a NEAR account id', () => {
    for (const payer of ['Buyer.testnet', 'a', 'buyer..testnet', '-buyer.testnet', 'buyer.testnet.', 'x'.repeat(65), '', undefined]) {
      expect(
        () => decodeXPayment(withPayload({ kind: 'tx', transaction: TX_44, nonce: '42', payer })),
        `should reject ${JSON.stringify(payer)}`,
      ).toThrow(/payer/);
      expect(
        () => decodeXPayment(withPayload({ kind: 'delegate', signedDelegate: SIGNED_DELEGATE, nonce: '42', payer })),
        `should reject ${JSON.stringify(payer)} (delegate)`,
      ).toThrow(/payer/);
    }
  });

  it('rejects an unknown or missing kind', () => {
    expect(() => decodeXPayment(withPayload({ kind: 'transfer', transaction: TX_44, nonce: '42', payer: 'buyer.testnet' }))).toThrow(/kind/);
    expect(() => decodeXPayment(withPayload({ transaction: TX_44, nonce: '42', payer: 'buyer.testnet' }))).toThrow(/kind/);
  });

  it('rejects a delegate payload whose signedDelegate is not base64', () => {
    for (const signedDelegate of ['', 'not base64!', 'abc', 7]) {
      expect(
        () => decodeXPayment(withPayload({ kind: 'delegate', signedDelegate, nonce: '42', payer: 'buyer.testnet' })),
        `should reject ${JSON.stringify(signedDelegate)}`,
      ).toThrow(/signedDelegate/);
    }
  });

  it('decode errors carry the INVALID_PAYMENT code and HTTP 402', () => {
    try {
      decodeXPayment(withPayload({ kind: 'nope' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentGateError);
      expect((err as AgentGateError).code).toBe('INVALID_PAYMENT');
      expect((err as AgentGateError).httpStatus).toBe(402);
    }
  });
});

describe('X-PAYMENT-RESPONSE codec', () => {
  it('round-trips a settlement response', () => {
    const s: SettlementResponse = { success: true, transaction: TX_44, network: 'near-testnet', payer: 'buyer.testnet' };
    expect(decodeXPaymentResponse(encodeXPaymentResponse(s))).toEqual(s);
  });

  it('rejects non-base64 / non-JSON', () => {
    expect(() => decodeXPaymentResponse('!!!not-valid-base64!!!')).toThrow(AgentGateError);
    expect(() => decodeXPaymentResponse(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('rejects when success is not boolean', () => {
    const bad = encodeXPaymentResponse({ success: 'yes' as unknown as boolean, transaction: TX_44, network: 'near-testnet' });
    expect(() => decodeXPaymentResponse(bad)).toThrow(AgentGateError);
  });

  it('rejects when transaction or network are missing or empty', () => {
    expect(() => decodeXPaymentResponse(rawHeader({ success: true, network: 'near-testnet' }))).toThrow(AgentGateError);
    expect(() => decodeXPaymentResponse(rawHeader({ success: true, transaction: TX_44, network: '' }))).toThrow(AgentGateError);
  });
});

describe('isNearAccountId', () => {
  it('accepts named, sub- and implicit accounts', () => {
    for (const id of ['buyer.testnet', 'registry.neargate.testnet', 'buyer.mock', 'a1', 'my-app_1.near', 'f'.repeat(64), '0x' + 'a'.repeat(40)]) {
      expect(isNearAccountId(id), id).toBe(true);
    }
  });

  it('rejects malformed ids', () => {
    for (const id of ['a', '', 'Buyer.testnet', 'buyer..testnet', '.buyer', 'buyer.', '-buyer', 'buyer-', 'bu--yer', 'bu_-yer', 'buyer testnet', 'x'.repeat(65), 'büyer.testnet']) {
      expect(isNearAccountId(id), JSON.stringify(id)).toBe(false);
    }
    expect(isNearAccountId(42)).toBe(false);
    expect(isNearAccountId(undefined)).toBe(false);
  });
});

describe('caip2For', () => {
  it('maps the chain network to a CAIP-2 id', () => {
    expect(caip2For('near-testnet')).toBe('near:testnet');
    expect(caip2For('near-mainnet')).toBe('near:mainnet');
    expect(caip2For('near-mock')).toBe('near:mock');
  });

  it('accepts a bare network name and is idempotent for CAIP-2 input', () => {
    expect(caip2For('testnet')).toBe('near:testnet');
    expect(caip2For('near:testnet')).toBe('near:testnet');
  });
});
