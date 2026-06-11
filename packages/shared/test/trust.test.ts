import { describe, expect, it } from 'vitest';
import { trustTier } from '../src/index';

describe('trustTier', () => {
  it('is "new" below 5 total calls regardless of ratio', () => {
    expect(trustTier({ totalCalls: 0, successCalls: 0 })).toBe('new');
    expect(trustTier({ totalCalls: 4, successCalls: 4 })).toBe('new');
  });

  it('is "reliable" at exactly 5 calls with ratio >= 0.9', () => {
    expect(trustTier({ totalCalls: 5, successCalls: 5 })).toBe('reliable');
    // 4/5 = 0.8 < 0.9
    expect(trustTier({ totalCalls: 5, successCalls: 4 })).toBe('new');
  });

  it('handles the 0.9 ratio boundary exactly', () => {
    expect(trustTier({ totalCalls: 10, successCalls: 9 })).toBe('reliable'); // exactly 0.9
    expect(trustTier({ totalCalls: 10, successCalls: 8 })).toBe('new'); // 0.8
    expect(trustTier({ totalCalls: 20, successCalls: 18 })).toBe('reliable'); // exactly 0.9
    expect(trustTier({ totalCalls: 20, successCalls: 17 })).toBe('new'); // 0.85
  });

  it('is "trusted" at >= 25 calls with ratio >= 0.95', () => {
    expect(trustTier({ totalCalls: 25, successCalls: 24 })).toBe('trusted'); // 0.96
    expect(trustTier({ totalCalls: 100, successCalls: 95 })).toBe('trusted'); // exactly 0.95
    expect(trustTier({ totalCalls: 1000, successCalls: 950 })).toBe('trusted');
  });

  it('falls back to "reliable" when ratio is in [0.9, 0.95) at >= 25 calls', () => {
    expect(trustTier({ totalCalls: 25, successCalls: 23 })).toBe('reliable'); // 0.92
    expect(trustTier({ totalCalls: 100, successCalls: 94 })).toBe('reliable'); // 0.94
  });

  it('high ratio but fewer than 25 calls caps at "reliable"', () => {
    expect(trustTier({ totalCalls: 24, successCalls: 24 })).toBe('reliable');
  });

  it('treats malformed scores as "new"', () => {
    expect(trustTier({ totalCalls: -1, successCalls: 0 })).toBe('new');
    expect(trustTier({ totalCalls: 10, successCalls: 11 })).toBe('new');
    expect(trustTier({ totalCalls: Number.NaN, successCalls: 0 })).toBe('new');
    expect(trustTier({ totalCalls: 10.5, successCalls: 10 })).toBe('new');
  });
});
