import { describe, expect, it } from 'vitest';
import {
  addYocto,
  compareYocto,
  formatNear,
  formatToken,
  formatUnits,
  MIN_PRICE_YOCTO,
  nearToYocto,
  parseYocto,
  PAYMENT_STORAGE_FEE_YOCTO,
  REGISTRATION_DEPOSIT_YOCTO,
  yoctoToNear,
  YOCTO_PER_NEAR,
  AgentGateError,
} from '../src/index';

/** Runs `fn` and returns the AgentGateError code it throws (fails the test otherwise). */
function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AgentGateError);
    return (err as AgentGateError).code;
  }
  return expect.unreachable('expected an AgentGateError');
}

describe('constants (mirror the neargate-registry contract)', () => {
  it('1 NEAR = 10^24 yocto', () => {
    expect(YOCTO_PER_NEAR).toBe(10n ** 24n);
  });

  it('storage fee is 0.002 NEAR, registration deposit 0.12 NEAR, min price 10^18 yocto', () => {
    expect(PAYMENT_STORAGE_FEE_YOCTO).toBe('2000000000000000000000');
    expect(PAYMENT_STORAGE_FEE_YOCTO).toBe(nearToYocto('0.002'));
    expect(REGISTRATION_DEPOSIT_YOCTO).toBe('120000000000000000000000');
    expect(REGISTRATION_DEPOSIT_YOCTO).toBe(nearToYocto('0.12'));
    expect(MIN_PRICE_YOCTO).toBe('1000000000000000000');
    expect(MIN_PRICE_YOCTO).toBe(nearToYocto('0.000001'));
  });
});

describe('nearToYocto', () => {
  it('converts whole NEAR', () => {
    expect(nearToYocto('1')).toBe('1000000000000000000000000');
    expect(nearToYocto('0')).toBe('0');
    expect(nearToYocto('123')).toBe('123000000000000000000000000');
  });

  it('converts fractional NEAR', () => {
    expect(nearToYocto('0.01')).toBe('10000000000000000000000');
    expect(nearToYocto('0.5')).toBe('500000000000000000000000');
    expect(nearToYocto('2.25')).toBe('2250000000000000000000000');
    expect(nearToYocto('0.' + '0'.repeat(23) + '1')).toBe('1');
    expect(nearToYocto('1.' + '0'.repeat(24))).toBe('1000000000000000000000000');
  });

  it('handles 24 decimal places exactly', () => {
    expect(nearToYocto('1.123456789012345678901234')).toBe('1123456789012345678901234');
  });

  it('trims surrounding whitespace', () => {
    expect(nearToYocto(' 0.5 ')).toBe('500000000000000000000000');
  });

  it('rejects more than 24 decimal places with INVALID_AMOUNT', () => {
    expect(errorCode(() => nearToYocto('1.' + '0'.repeat(24) + '1'))).toBe('INVALID_AMOUNT');
    expect(() => nearToYocto('0.' + '1'.repeat(25))).toThrow(/decimal places/);
  });

  it('rejects negative, signed, exponent, and malformed input', () => {
    for (const bad of ['-1', '-0.5', '+5', '1e9', '1.2.3', 'abc', '', '.', '.5', '5.', '1,5', 'NaN', 'Infinity']) {
      expect(errorCode(() => nearToYocto(bad)), `should reject ${JSON.stringify(bad)}`).toBe('INVALID_AMOUNT');
    }
  });
});

describe('yoctoToNear', () => {
  it('trims trailing zeros', () => {
    expect(yoctoToNear('1500000000000000000000000')).toBe('1.5');
    expect(yoctoToNear('1000000000000000000000000')).toBe('1');
    expect(yoctoToNear('2000000000000000000000')).toBe('0.002');
    expect(yoctoToNear('1')).toBe('0.' + '0'.repeat(23) + '1');
    expect(yoctoToNear('0')).toBe('0');
  });

  it('round-trips with nearToYocto', () => {
    for (const v of ['0', '1', '0.5', '2.25', '0.002', '0.12', '0.000001', '123.456789012345678901234', '9999.9']) {
      expect(yoctoToNear(nearToYocto(v))).toBe(v);
    }
  });

  it('rejects non-integer or negative yocto', () => {
    for (const bad of ['1.5', '-3', '', 'abc', '1e9', '+1']) {
      expect(errorCode(() => yoctoToNear(bad)), `should reject ${JSON.stringify(bad)}`).toBe('INVALID_AMOUNT');
    }
  });
});

describe('parseYocto', () => {
  it('parses valid yocto strings, including values past u64', () => {
    expect(parseYocto('0')).toBe(0n);
    expect(parseYocto('1000000000000000000000000')).toBe(10n ** 24n);
  });

  it('rejects invalid input', () => {
    expect(() => parseYocto('-1')).toThrow(AgentGateError);
    expect(() => parseYocto('0x10')).toThrow(AgentGateError);
    expect(() => parseYocto('1.0')).toThrow(AgentGateError);
  });
});

describe('addYocto', () => {
  it('adds without float precision loss', () => {
    expect(addYocto('1', '2')).toBe('3');
    expect(addYocto('500000000000000000000000', PAYMENT_STORAGE_FEE_YOCTO)).toBe('502000000000000000000000');
    expect(addYocto('340282366920938463463374607431768211455', '1')).toBe('340282366920938463463374607431768211456');
  });

  it('rejects invalid operands', () => {
    expect(() => addYocto('1.5', '1')).toThrow(AgentGateError);
    expect(() => addYocto('1', '-1')).toThrow(AgentGateError);
  });
});

describe('compareYocto', () => {
  it('orders correctly', () => {
    expect(compareYocto('1', '2')).toBe(-1);
    expect(compareYocto('2', '1')).toBe(1);
    expect(compareYocto(MIN_PRICE_YOCTO, MIN_PRICE_YOCTO)).toBe(0);
  });

  it('compares numerically, not lexicographically', () => {
    expect(compareYocto('9', '10')).toBe(-1);
    expect(compareYocto('100', '99')).toBe(1);
  });
});

describe('formatNear', () => {
  it('formats with a NEAR suffix', () => {
    expect(formatNear('2000000000000000000000')).toBe('0.002 NEAR');
    expect(formatNear('500000000000000000000000')).toBe('0.5 NEAR');
    expect(formatNear('1000000000000000000000000')).toBe('1 NEAR');
    expect(formatNear('0')).toBe('0 NEAR');
  });
});

describe('formatUnits / formatToken (non-native assets)', () => {
  it('formatUnits trims trailing zeros at arbitrary decimals', () => {
    expect(formatUnits('1000000', 6)).toBe('1');
    expect(formatUnits('1500000', 6)).toBe('1.5');
    expect(formatUnits('42', 0)).toBe('42');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('2000000000000000000000', 24)).toBe('0.002');
  });

  it('formatToken appends the symbol', () => {
    expect(formatToken('1500000', 6, 'USDC')).toBe('1.5 USDC');
  });

  it('formatUnits rejects a non-integer atomic string', () => {
    expect(() => formatUnits('0.5', 6)).toThrow(AgentGateError);
  });
});
