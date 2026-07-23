import { describe, expect, it } from 'vitest';
import { buildRegisterServiceArgs } from '../src/live';
import type { RegisterServiceInput } from '@agentgate/shared';

const GATE_HASH = '19ffec2c950f361d7e4d66bb1b088d953278b21dfebcb3123f7cd401fb81b5f0';
// secp256k1 gate public key — its account hash is GATE_HASH.
const GATE_PUB = '0203df32380ac693d292a9a14cbda623e94eb93d743b5fcb6592b25fc74cd17c0018';

const input = (over: Partial<RegisterServiceInput> = {}): RegisterServiceInput => ({
  name: 'Global Currency Feed (v2)',
  description: 'Live USD FX - on-chain accepts[]',
  endpointUrl: 'https://gateway.example.org',
  priceMotes: '2500000000',
  paymentTarget: `account-hash-${GATE_HASH}`,
  attestor: GATE_PUB,
  ...over,
});

const hex = (v: { bytes(): Uint8Array }): string => Buffer.from(v.bytes()).toString('hex');

describe('buildRegisterServiceArgs — registry v2 ABI', () => {
  it('encodes accepts[] as one native option, byte-identical to the on-chain-proven encoding', () => {
    const args = buildRegisterServiceArgs(input());
    // Verified against the deployed contract: register_service tx 38836425…
    // (Success) carried exactly these bytes for a native 2.5 CSPR option.
    expect(hex(args.getByName('accepts')!)).toBe(
      '01000000060000006e61746976650400f90295090400000043535052040000004353505200000000',
    );
  });

  it('sends payment_target and attestor as account Keys', () => {
    const args = buildRegisterServiceArgs(input());
    expect(hex(args.getByName('payment_target')!)).toBe(`00${GATE_HASH}`);
    expect(hex(args.getByName('attestor')!)).toBe(`00${GATE_HASH}`);
    expect(args.getByName('price')).toBeUndefined(); // v1 arg must be gone
  });

  it('rejects non-ASCII strings (casper-js-sdk 5.0.12 CLString length-prefix bug)', () => {
    expect(() => buildRegisterServiceArgs(input({ description: 'pay in CSPR — on-chain' }))).toThrow(
      /printable ASCII/,
    );
  });
});
