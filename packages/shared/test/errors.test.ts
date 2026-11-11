import { describe, expect, it } from 'vitest';
import { AgentGateError, chainErrorCode, formatError } from '../src/index';

describe('chainErrorCode', () => {
  it("returns an AgentGateError's code when it is a contract ERR_* code", () => {
    const err = new AgentGateError('ERR_ALREADY_ATTESTED', 'ERR_ALREADY_ATTESTED: this payment is already attested', 400);
    expect(chainErrorCode(err)).toBe('ERR_ALREADY_ATTESTED');
  });

  it('prefers the code over the message', () => {
    expect(chainErrorCode(new AgentGateError('ERR_NONCE_USED', 'ERR_ALREADY_ATTESTED: other text'))).toBe('ERR_NONCE_USED');
  });

  it('falls back to the leading ERR_* token of the message', () => {
    expect(chainErrorCode(new Error('ERR_ALREADY_ATTESTED: this payment is already attested'))).toBe('ERR_ALREADY_ATTESTED');
    // an AgentGateError whose code is not an ERR_* code (transport failure) but whose message starts with one
    expect(chainErrorCode(new AgentGateError('devnet_error', 'ERR_SERVICE_INACTIVE: the service is switched off', 400))).toBe(
      'ERR_SERVICE_INACTIVE',
    );
  });

  it('accepts a bare code as the whole message', () => {
    expect(chainErrorCode(new Error('ERR_NOT_AUTHORIZED'))).toBe('ERR_NOT_AUTHORIZED');
  });

  it('returns null for anything that is not a contract error', () => {
    expect(chainErrorCode(new Error('injected attestation failure'))).toBeNull();
    expect(chainErrorCode(new AgentGateError('devnet_unreachable', 'devnet request failed', 502))).toBeNull();
    // the code must lead the message: a mention in the middle is not a contract panic
    expect(chainErrorCode(new Error('call failed: ERR_ALREADY_ATTESTED'))).toBeNull();
    // lowercase / malformed codes do not match
    expect(chainErrorCode(new Error('err_already_attested: x'))).toBeNull();
    expect(chainErrorCode(new Error('ERR_ALREADY_ATTESTEDx: glued on'))).toBeNull();
    expect(chainErrorCode(new AgentGateError('ERR_lower', 'nope'))).toBeNull();
    expect(chainErrorCode(null)).toBeNull();
    expect(chainErrorCode(undefined)).toBeNull();
    expect(chainErrorCode('ERR_ALREADY_ATTESTED')).toBeNull();
    expect(chainErrorCode({ code: 42, message: 7 })).toBeNull();
  });

  it('ignores the ERR_* code of any error that is not an AgentGateError (Node core uses them too)', () => {
    const nodeStyle = Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' });
    expect(chainErrorCode(nodeStyle)).toBeNull();
    expect(chainErrorCode(Object.assign(new Error('socket hang up'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))).toBeNull();
    // a plain object is not an error at all, whatever it carries
    expect(chainErrorCode({ code: 'ERR_ALREADY_ATTESTED' })).toBeNull();
    expect(chainErrorCode({ code: 'ERR_ALREADY_ATTESTED', message: 'ERR_ALREADY_ATTESTED: x' })).toBeNull();
    // ...but a message that starts with a contract code still counts (the live client's shape)
    expect(chainErrorCode(Object.assign(new Error('ERR_ALREADY_ATTESTED: x'), { code: 'ERR_INVALID_URL' }))).toBe('ERR_ALREADY_ATTESTED');
  });
});

describe('formatError', () => {
  it('leads with the code: "CODE: message"', () => {
    expect(formatError(new AgentGateError('BUDGET_EXCEEDED', 'invoice asks too much', 402))).toBe(
      'BUDGET_EXCEEDED: invoice asks too much',
    );
  });

  it('does not repeat a code the message already leads with', () => {
    expect(formatError(new AgentGateError('ERR_NOT_AUTHORIZED', 'ERR_NOT_AUTHORIZED: owner only', 403))).toBe(
      'ERR_NOT_AUTHORIZED: owner only',
    );
    expect(formatError(new AgentGateError('ERR_NOT_AUTHORIZED', 'ERR_NOT_AUTHORIZED'))).toBe('ERR_NOT_AUTHORIZED');
    // a longer code that merely starts with this one is not "the code"
    expect(formatError(new AgentGateError('ERR_X', 'ERR_XY: other'))).toBe('ERR_X: ERR_XY: other');
  });

  it('gives the message of any other Error and String() of anything else', () => {
    expect(formatError(new TypeError('fetch failed'))).toBe('fetch failed');
    expect(formatError('plain')).toBe('plain');
    expect(formatError(42)).toBe('42');
  });
});
