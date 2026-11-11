import { describe, expect, it } from 'vitest';
import { isRecord } from '../src/index';

describe('isRecord', () => {
  it('is true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('is false for null, arrays, primitives and functions', () => {
    for (const value of [null, undefined, [], [1], 'x', 1, true, () => 1]) {
      expect(isRecord(value), String(value)).toBe(false);
    }
  });
});
