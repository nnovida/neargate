import { describe, expect, it } from 'vitest';
import { parseServiceBytes } from '../src/live';

// ---- bytesrepr encoders (mirror casper-types) --------------------------------

const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

const str = (s: string): number[] => {
  const utf8 = Array.from(new TextEncoder().encode(s));
  return [...u32(utf8.length), ...utf8];
};

const u512 = (value: bigint): number[] => {
  const bytes: number[] = [];
  let v = value;
  while (v > 0n) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return [bytes.length, ...bytes];
};

const u64 = (value: bigint): number[] => {
  const bytes: number[] = [];
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return bytes;
};

const ACCT = 'ab'.repeat(32);
const accountKey = (): number[] => [0, ...Array.from({ length: 32 }, () => 0xab)];

interface OptFields {
  asset: string;
  amount: bigint;
  decimals: number;
  symbol: string;
  name: string;
  version: string;
}

const paymentOption = (o: OptFields): number[] => [
  ...str(o.asset),
  ...u512(o.amount),
  o.decimals,
  ...str(o.symbol),
  ...str(o.name),
  ...str(o.version),
];

const WCSPR_PKG = 'hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e';

const NATIVE_OPT: OptFields = {
  asset: 'native', amount: 2_500_000_000n, decimals: 9, symbol: 'CSPR', name: 'CSPR', version: '',
};
const WCSPR_OPT: OptFields = {
  asset: WCSPR_PKG, amount: 100_000_000n, decimals: 9, symbol: 'WCSPR', name: 'Wrapped CSPR', version: '1',
};

/** v2 `Service` layout: name, description, gateway_base_url, accepts[], keys, active, created_at. */
const v2Record = (accepts: OptFields[]): Uint8Array =>
  Uint8Array.from([
    ...str('Global Currency Feed (v2)'),
    ...str('Live USD FX; pay in CSPR or WCSPR - on-chain accepts[]'),
    ...str('https://gateway.example.org'),
    ...u32(accepts.length),
    ...accepts.flatMap(paymentOption),
    ...accountKey(), // payment_target
    ...accountKey(), // owner
    ...accountKey(), // attestor
    1, // active
    ...u64(1_784_737_492_597n),
  ]);

/** v1 (legacy locked registry) layout: single U512 `price` instead of accepts[]. */
const v1Record = (): Uint8Array =>
  Uint8Array.from([
    ...str('RWA FX & Gold Oracle'),
    ...str('USD/IDR rate + gold spot with confidence'),
    ...str('https://gateway.example.org'),
    ...u512(2_500_000_000n),
    ...accountKey(),
    ...accountKey(),
    ...accountKey(),
    1,
    ...u64(1_782_744_580_582n),
  ]);

describe('parseServiceBytes — registry v2 accepts[] layout', () => {
  it('decodes a 2-option service (native + WCSPR) and surfaces accepts[]', () => {
    const svc = parseServiceBytes(v2Record([NATIVE_OPT, WCSPR_OPT]), 1);
    expect(svc.name).toBe('Global Currency Feed (v2)');
    expect(svc.endpointUrl).toBe('https://gateway.example.org/svc/1');
    expect(svc.accepts).toEqual([
      { asset: 'native', amount: '2500000000', decimals: 9, symbol: 'CSPR', name: 'CSPR', version: '' },
      { asset: WCSPR_PKG, amount: '100000000', decimals: 9, symbol: 'WCSPR', name: 'Wrapped CSPR', version: '1' },
    ]);
    expect(svc.paymentTarget).toBe(`account-hash-${ACCT}`);
    expect(svc.active).toBe(true);
    expect(svc.createdAt).toBe(1_784_737_492_597);
  });

  it('priceMotes = the native option amount (back-compat for the native rail)', () => {
    const svc = parseServiceBytes(v2Record([WCSPR_OPT, NATIVE_OPT]), 1);
    expect(svc.priceMotes).toBe('2500000000');
  });

  it('token-only service: priceMotes falls back to the first option amount', () => {
    const svc = parseServiceBytes(v2Record([WCSPR_OPT]), 7);
    expect(svc.priceMotes).toBe('100000000');
    expect(svc.accepts).toHaveLength(1);
  });

  it('still decodes the legacy v1 single-price layout (rollback reads)', () => {
    const svc = parseServiceBytes(v1Record(), 5);
    expect(svc.name).toBe('RWA FX & Gold Oracle');
    expect(svc.priceMotes).toBe('2500000000');
    expect(svc.accepts).toBeUndefined();
    expect(svc.createdAt).toBe(1_782_744_580_582);
  });

  it('rejects records with trailing bytes (no silent mis-decode)', () => {
    const bad = Uint8Array.from([...v2Record([NATIVE_OPT]), 0xde, 0xad]);
    expect(() => parseServiceBytes(bad, 1)).toThrow(/cannot parse Service 1/);
  });

  it('rejects garbage', () => {
    expect(() => parseServiceBytes(Uint8Array.from([1, 2, 3]), 9)).toThrow(/cannot parse Service 9/);
  });
});
