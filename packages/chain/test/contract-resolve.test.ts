import { describe, expect, it } from 'vitest';
import { pickLatestVersion } from '../src/live';

const V = (contractVersion: number, contractHash: string) => ({ contractVersion, contractHash });

describe('pickLatestVersion', () => {
  it('picks the highest contractVersion when none are disabled', () => {
    const picked = pickLatestVersion([V(1, 'a'), V(3, 'c'), V(2, 'b')], []);
    expect(picked?.contractHash).toBe('c');
  });

  it('skips disabled versions (matched on the first element of each pair)', () => {
    const picked = pickLatestVersion([V(1, 'a'), V(2, 'b'), V(3, 'c')], [[3, 2]]);
    expect(picked?.contractHash).toBe('b');
  });

  it('returns null when there are no enabled versions', () => {
    expect(pickLatestVersion([], [])).toBeNull();
    expect(pickLatestVersion([V(1, 'a')], [[1, 2]])).toBeNull();
  });
});
