import { describe, expect, it } from 'vitest';
import { parseServiceIdArg } from '../src/validate';

describe('parseServiceIdArg (the <id> argument of buy / status / pause / resume / map)', () => {
  it.each([
    ['7', 7],
    [' 7 ', 7],
    ['1', 1],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('accepts %j as %d', (raw, id) => {
    expect(parseServiceIdArg(raw)).toBe(id);
  });

  it.each(['0', '-1', '1.5', '1e3', 'abc', '', '  ', '9007199254740993', '99999999999999999999'])(
    'rejects %j with INVALID_SERVICE_ID',
    (raw) => {
      expect(() => parseServiceIdArg(raw)).toThrow(expect.objectContaining({ code: 'INVALID_SERVICE_ID' }));
    },
  );
});
