import { describe, expect, it } from 'vitest';
import { formatNear } from '@agentgate/shared';
import { shortAccount } from '@/lib/format';

describe('shortAccount', () => {
  it('leaves a named or sub-account id alone', () => {
    expect(shortAccount('alice.testnet')).toBe('alice.testnet');
    expect(shortAccount('registry.neargate.testnet')).toBe('registry.neargate.testnet');
  });

  it('shortens a 64-hex implicit account in the middle, keeping both ends', () => {
    const implicit = `ab12${'0'.repeat(56)}ef34`;
    const out = shortAccount(implicit);
    expect(out.startsWith('ab12')).toBe(true);
    expect(out.endsWith('ef34')).toBe(true);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(implicit.length);
  });

  it('is the identity for an empty id', () => {
    expect(shortAccount('')).toBe('');
  });
});

describe('NEAR amounts shown by the dashboard (shared formatNear)', () => {
  it('prints yocto as NEAR with trailing zeros trimmed', () => {
    expect(formatNear('500000000000000000000000')).toBe('0.5 NEAR');
    expect(formatNear('2000000000000000000000')).toBe('0.002 NEAR');
    expect(formatNear('0')).toBe('0 NEAR');
  });
});
