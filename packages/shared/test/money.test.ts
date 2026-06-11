import { describe, expect, it } from 'vitest';
import {
  addMotes,
  compareMotes,
  csprToMotes,
  formatCspr,
  motesToCspr,
  parseMotes,
  AgentGateError,
} from '../src/index';

describe('csprToMotes', () => {
  it('converts whole CSPR', () => {
    expect(csprToMotes('1')).toBe('1000000000');
    expect(csprToMotes('0')).toBe('0');
    expect(csprToMotes('123')).toBe('123000000000');
  });

  it('converts fractional CSPR', () => {
    expect(csprToMotes('0.5')).toBe('500000000');
    expect(csprToMotes('2.25')).toBe('2250000000');
    expect(csprToMotes('0.000000001')).toBe('1');
    expect(csprToMotes('1.000000000')).toBe('1000000000');
  });

  it('handles 9 decimal places exactly', () => {
    expect(csprToMotes('123.456789012')).toBe('123456789012');
  });

  it('handles values beyond Number.MAX_SAFE_INTEGER', () => {
    // 10^10 CSPR = 10^19 motes > 2^53
    expect(csprToMotes('10000000000')).toBe('10000000000000000000');
  });

  it('rejects more than 9 decimal places', () => {
    expect(() => csprToMotes('1.0000000001')).toThrow(AgentGateError);
    expect(() => csprToMotes('0.1234567891')).toThrow(/decimal places/);
  });

  it('rejects negative, signed, exponent, and malformed input', () => {
    for (const bad of ['-1', '-0.5', '+5', '1e9', '1.2.3', 'abc', '', '.', '.5', '5.', '1,5', 'NaN', 'Infinity']) {
      expect(() => csprToMotes(bad), `should reject ${JSON.stringify(bad)}`).toThrow(AgentGateError);
    }
  });
});

describe('motesToCspr', () => {
  it('round-trips with csprToMotes', () => {
    for (const v of ['0', '1', '0.5', '2.25', '0.000000001', '123.456789012', '9999.9']) {
      expect(motesToCspr(csprToMotes(v))).toBe(v);
    }
  });

  it('trims trailing zeros', () => {
    expect(motesToCspr('1500000000')).toBe('1.5');
    expect(motesToCspr('1000000000')).toBe('1');
    expect(motesToCspr('500000000')).toBe('0.5');
    expect(motesToCspr('0')).toBe('0');
  });

  it('rejects non-integer or negative motes', () => {
    for (const bad of ['1.5', '-3', '', 'abc', '1e9', '+1']) {
      expect(() => motesToCspr(bad), `should reject ${JSON.stringify(bad)}`).toThrow(AgentGateError);
    }
  });
});

describe('parseMotes', () => {
  it('parses valid motes strings', () => {
    expect(parseMotes('0')).toBe(0n);
    expect(parseMotes('1000000000')).toBe(1_000_000_000n);
  });

  it('rejects invalid input', () => {
    expect(() => parseMotes('-1')).toThrow(AgentGateError);
    expect(() => parseMotes('0x10')).toThrow(AgentGateError);
  });
});

describe('addMotes', () => {
  it('adds small values', () => {
    expect(addMotes('1', '2')).toBe('3');
    expect(addMotes('0', '0')).toBe('0');
  });

  it('adds without float precision loss past 2^53', () => {
    expect(addMotes('9007199254740993', '1')).toBe('9007199254740994');
    expect(addMotes('18446744073709551615', '1')).toBe('18446744073709551616');
  });

  it('rejects invalid operands', () => {
    expect(() => addMotes('1.5', '1')).toThrow(AgentGateError);
    expect(() => addMotes('1', '-1')).toThrow(AgentGateError);
  });
});

describe('compareMotes', () => {
  it('orders correctly', () => {
    expect(compareMotes('1', '2')).toBe(-1);
    expect(compareMotes('2', '1')).toBe(1);
    expect(compareMotes('500000000', '500000000')).toBe(0);
  });

  it('compares numerically, not lexicographically', () => {
    expect(compareMotes('9', '10')).toBe(-1);
    expect(compareMotes('100', '99')).toBe(1);
  });
});

describe('formatCspr', () => {
  it('formats with CSPR suffix', () => {
    expect(formatCspr('500000000')).toBe('0.5 CSPR');
    expect(formatCspr('1000000000')).toBe('1 CSPR');
    expect(formatCspr('0')).toBe('0 CSPR');
  });
});
