import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  X402_VERSION, X402_SCHEME, X402_ASSET_NEAR,
  encodeXPayment, decodeXPayment, encodeXPaymentResponse, decodeXPaymentResponse,
  isNearAccountId, isNearTxHash, isEd25519PublicKey, isBase64, caip2For, SIGNED_DELEGATE_MAX,
  type NearPaymentExtra, type PaymentPayload, type PaymentRequiredResponse, type PaymentRequirements,
  type SettlementResponse,
} from '../src/x402';
import { AgentGateError, base58Encode, type Yocto } from '../src/index';

const TX_44 = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';
const TX_43 = 'WmErKxQ1tQRUZcGT9Cdi4TfXreqYR78BWrKR7e7gvJc';
/** A real 42-char NEAR tx hash: its first byte is zero, so it is shorter but still 32 bytes. */
const TX_42 = '1tJ93RwaVfE1PEMxd5rpZZuPtLCwbEaDCrNBhAy8Cw';
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

function withPayload(payload: unknown): string {
  return rawHeader({ x402Version: 1, scheme: 'exact', network: 'near-testnet', payload });
}

/** Returns the AgentGateError `decodeXPayment` throws for `header` (fails the test otherwise). */
function decodeError(header: string): AgentGateError {
  try {
    decodeXPayment(header);
  } catch (err) {
    expect(err).toBeInstanceOf(AgentGateError);
    return err as AgentGateError;
  }
  return expect.unreachable('expected decodeXPayment to throw');
}

describe('x402 constants', () => {
  it('pins version 1, scheme exact, asset NEAR', () => {
    expect(X402_VERSION).toBe(1);
    expect(X402_SCHEME).toBe('exact');
    expect(X402_ASSET_NEAR).toBe('NEAR');
  });

  it('PaymentRequirements carries the NEAR registry extra (type-level shape)', () => {
    // Type-level assertions: `npm run typecheck` covers test files, so a renamed,
    // retyped, dropped or added field fails the build.
    expectTypeOf<PaymentRequirements['extra']>().toEqualTypeOf<NearPaymentExtra>();
    expectTypeOf<NearPaymentExtra>().toEqualTypeOf<{
      nonce: string;
      serviceId: number;
      expiresAtMs: number;
      settlement: 'neargate-registry-pay';
      contractId: string;
      method: 'pay';
      priceYocto: Yocto;
      storageFeeYocto: Yocto;
      seller: string;
      caip2: string;
      relayer?: string;
      relayMethod?: 'pay_from_escrow';
    }>();
    // The gasless rail's 402 answers name the relay tx (settlement_pending after a timeout) or the
    // chain's code (relay_failed); every other 402 carries neither.
    expectTypeOf<PaymentRequiredResponse>().toEqualTypeOf<{
      x402Version: number;
      error: string;
      accepts: PaymentRequirements[];
      transaction?: string;
      code?: string;
    }>();
    expectTypeOf<PaymentRequirements['maxAmountRequired']>().toEqualTypeOf<Yocto>();
    const req = {
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
    } satisfies PaymentRequirements;
    expect(req.extra.settlement).toBe('neargate-registry-pay');
    expect('relayer' in req.extra).toBe(false);
  });
});

describe('x402 codec', () => {
  it('round-trips a tx payload', () => {
    expect(decodeXPayment(encodeXPayment(txPayment))).toEqual(txPayment);
  });

  it('round-trips a delegate payload', () => {
    expect(decodeXPayment(encodeXPayment(delegatePayment))).toEqual(delegatePayment);
  });

  it('accepts 43- and 42-char base58 tx hashes that decode to 32 bytes', () => {
    for (const transaction of [TX_43, TX_42, base58Encode(new Uint8Array(32))]) {
      const decoded = decodeXPayment(withPayload({ kind: 'tx', transaction, nonce: '1', payer: 'buyer.testnet' }));
      expect(decoded.payload).toEqual({ kind: 'tx', transaction, nonce: '1', payer: 'buyer.testnet' });
    }
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

  it('rejects a tx hash that is not base58 of exactly 32 bytes', () => {
    const rejected = [
      'z'.repeat(44), // 44 chars but 33 bytes
      '1'.repeat(44), // 44 zero bytes
      '0' + TX_43, 'O' + TX_43, 'I' + TX_43, 'l' + TX_43, // chars outside the alphabet
      TX_44.slice(0, 20) + '0' + TX_44.slice(21),
      'a'.repeat(64), '0'.repeat(44), 'O'.repeat(44), 'l'.repeat(43),
      TX_44 + 'A', TX_43.slice(0, 42), '', 42,
    ];
    for (const transaction of rejected) {
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

  it('bounds signedDelegate at the base64 of SIGNED_DELEGATE_MAX (4096) bytes, far inside the 16 KiB header limit (R58 §3)', () => {
    expect(SIGNED_DELEGATE_MAX).toBe(4096);
    const atMax = 'A'.repeat(Math.ceil(SIGNED_DELEGATE_MAX / 3) * 4); // 5464 base64 chars
    expect(atMax).toHaveLength(5464);
    const header = encodeXPayment({
      ...delegatePayment,
      payload: { kind: 'delegate', signedDelegate: atMax, nonce: '7', payer: 'buyer.testnet' },
    });
    expect(decodeXPayment(header).payload).toMatchObject({ kind: 'delegate', signedDelegate: atMax });
    expect(header.length).toBeLessThan(8 * 1024); // the whole X-PAYMENT header, base64 JSON around it
    const err = decodeError(withPayload({ kind: 'delegate', signedDelegate: `${atMax}AAAA`, nonce: '42', payer: 'buyer.testnet' }));
    expect(err.code).toBe('INVALID_PAYMENT');
    expect(err.message).toMatch(/signedDelegate/);
  });

  it('rejects a delegate payload whose signedDelegate is not base64', () => {
    for (const signedDelegate of ['', 'not base64!', 'abc', 7]) {
      expect(
        () => decodeXPayment(withPayload({ kind: 'delegate', signedDelegate, nonce: '42', payer: 'buyer.testnet' })),
        `should reject ${JSON.stringify(signedDelegate)}`,
      ).toThrow(/signedDelegate/);
    }
  });

  it('rejects missing fields and non-object payloads or bodies with INVALID_PAYMENT', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['missing nonce', withPayload({ kind: 'tx', transaction: TX_44, payer: 'buyer.testnet' }), /nonce/],
      ['missing transaction', withPayload({ kind: 'tx', nonce: '42', payer: 'buyer.testnet' }), /transaction/],
      ['missing payer', withPayload({ kind: 'tx', transaction: TX_44, nonce: '42' }), /payer/],
      ['string payload', withPayload('tx'), /payload must be an object/],
      ['array payload', withPayload([txPayment.payload]), /payload must be an object/],
      ['null payload', withPayload(null), /payload must be an object/],
      ['missing payload', rawHeader({ x402Version: 1, scheme: 'exact', network: 'near-testnet' }), /payload must be an object/],
      ['top-level JSON array', rawHeader([txPayment]), /not a JSON object/],
      ['top-level null', rawHeader(null), /not a JSON object/],
      ['top-level number', rawHeader(42), /not a JSON object/],
    ];
    for (const [name, header, why] of cases) {
      const err = decodeError(header);
      expect(err.code, name).toBe('INVALID_PAYMENT');
      expect(err.httpStatus, name).toBe(402);
      expect(err.message, name).toMatch(why);
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

describe('isNearTxHash', () => {
  it('accepts base58 strings that decode to exactly 32 bytes', () => {
    for (const h of [TX_44, TX_43, TX_42, '1'.repeat(32), 'H'.repeat(44)]) {
      expect(isNearTxHash(h), h).toBe(true);
    }
  });

  it('accepts the encoding of any 32-byte value', () => {
    for (let i = 0; i < 64; i++) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      bytes.fill(0, 0, i % 3);
      expect(isNearTxHash(base58Encode(bytes))).toBe(true);
    }
  });

  it('rejects other lengths, chars outside the alphabet and non-strings', () => {
    for (const h of ['z'.repeat(44), 'J'.repeat(44), '1'.repeat(31), '1'.repeat(33), TX_44 + '1', TX_44.replace('k', 'l'), 'I' + TX_43, '', 'a'.repeat(10_000), 42, null, undefined]) {
      expect(isNearTxHash(h), JSON.stringify(h)?.slice(0, 50)).toBe(false);
    }
  });
});

describe('isEd25519PublicKey', () => {
  const key = (bytes: Uint8Array): string => `ed25519:${base58Encode(bytes)}`;

  it('accepts ed25519: plus the base58 of exactly 32 bytes (including leading zero bytes)', () => {
    for (let i = 0; i < 32; i++) {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      bytes.fill(0, 0, i % 3);
      expect(isEd25519PublicKey(key(bytes))).toBe(true);
    }
    expect(isEd25519PublicKey(`ed25519:${'1'.repeat(32)}`)).toBe(true);
  });

  it('rejects a missing or other curve prefix, other lengths, bad alphabet and non-strings', () => {
    const good = key(new Uint8Array(32).fill(9));
    for (const bad of [
      good.slice('ed25519:'.length),
      `secp256k1:${base58Encode(new Uint8Array(32).fill(9))}`,
      `ED25519:${base58Encode(new Uint8Array(32).fill(9))}`,
      key(new Uint8Array(31).fill(9)),
      key(new Uint8Array(33).fill(9)),
      'ed25519:',
      'ed25519:0OIl',
      `${good}${'1'.repeat(10_000)}`,
      '',
      42,
      null,
      undefined,
    ]) {
      expect(isEd25519PublicKey(bad), JSON.stringify(bad)?.slice(0, 60)).toBe(false);
    }
  });
});

describe('isBase64', () => {
  it('accepts strict padded standard base64', () => {
    for (const ok of ['AAAA', 'QQ==', 'QUI=', Buffer.alloc(64, 7).toString('base64')]) expect(isBase64(ok), ok).toBe(true);
  });

  it('rejects empty, unpadded, URL-safe, whitespace and non-strings', () => {
    for (const bad of ['', 'QQ', 'QQ=', 'a-b_', 'AA AA', 'AAAA\n', '!!!!', 7, null, undefined]) {
      expect(isBase64(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('caip2For', () => {
  it('maps the three chain networks to their CAIP-2 ids', () => {
    expect(caip2For('near-testnet')).toBe('near:testnet');
    expect(caip2For('near-mainnet')).toBe('near:mainnet');
    expect(caip2For('near-mock')).toBe('near:mock');
  });

  it('has a typed return, so a payload cannot carry an arbitrary CAIP-2 string', () => {
    expectTypeOf(caip2For).returns.toEqualTypeOf<'near:testnet' | 'near:mainnet' | 'near:mock'>();
  });

  it('throws CONFIG_INVALID for anything else, CAIP-2 input and the retired bare "mock" included', () => {
    for (const network of ['mock', 'testnet', 'near:testnet', 'near-localnet', 'constructor', '__proto__', '']) {
      let thrown: unknown;
      try {
        caip2For(network);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(network)).toBeInstanceOf(AgentGateError);
      expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', httpStatus: 500 });
    }
  });
});
