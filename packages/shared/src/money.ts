import type { PaymentOption, Yocto } from './types';
import { AgentGateError } from './errors';

/** 1 NEAR = 10^24 yoctoNEAR. */
export const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * The amounts below mirror the `neargate-registry` contract constants exactly.
 * Storage fee the registry keeps per `pay` call (0.002 NEAR): it prepays the
 * payment record, on top of the service price.
 */
export const PAYMENT_STORAGE_FEE_YOCTO: Yocto = '2000000000000000000000';
/** Deposit `register_service` requires (0.12 NEAR); any excess is refunded. */
export const REGISTRATION_DEPOSIT_YOCTO: Yocto = '120000000000000000000000';
/** Minimum price of the native NEAR option (10^18 yocto = 0.000001 NEAR). */
export const MIN_PRICE_YOCTO: Yocto = '1000000000000000000';

/** `PaymentOption.asset` of the native NEAR option. */
export const NEAR_NATIVE_ASSET = 'near';

/** Max decimal places a NEAR amount may carry (yocto precision). */
const MAX_NEAR_DECIMALS = 24;
/** Largest amount the contract can hold: u128::MAX = 2^128 − 1 yocto. */
const U128_MAX = (1n << 128n) - 1n;

const NEAR_RE = /^(\d+)(?:\.(\d+))?$/;
const YOCTO_RE = /^\d+$/;

function invalidAmount(value: unknown, why: string): AgentGateError {
  return new AgentGateError('INVALID_AMOUNT', `invalid amount ${JSON.stringify(String(value))}: ${why}`, 400);
}

function checkU128(v: bigint, input: unknown): bigint {
  if (v > U128_MAX) throw invalidAmount(input, 'exceeds the u128 maximum (2^128 − 1 yocto)');
  return v;
}

/**
 * Parse a yocto decimal string into a bigint.
 * Throws AgentGateError('INVALID_AMOUNT') on anything that is not a plain
 * non-negative integer decimal string (no sign, no decimals, no exponent), and on
 * values above u128::MAX (2^128 − 1).
 */
export function parseYocto(y: Yocto): bigint {
  if (typeof y !== 'string' || !YOCTO_RE.test(y)) {
    throw invalidAmount(y, 'yocto must be a non-negative integer decimal string');
  }
  return checkU128(BigInt(y), y);
}

/**
 * Convert a NEAR decimal string (e.g. "0.01") to yocto ("10000000000000000000000").
 * Bigint-backed — never goes through Number. Throws INVALID_AMOUNT on:
 * negative values, more than 24 decimal places, exponents, non-numeric input,
 * or a result above u128::MAX (2^128 − 1 yocto).
 */
export function nearToYocto(near: string): Yocto {
  if (typeof near !== 'string') throw invalidAmount(near, 'must be a string');
  const match = NEAR_RE.exec(near.trim());
  if (!match) throw invalidAmount(near, 'must be a non-negative decimal string like "0.5"');
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > MAX_NEAR_DECIMALS) {
    throw invalidAmount(near, `at most ${MAX_NEAR_DECIMALS} decimal places (1 yocto = 1e-24 NEAR)`);
  }
  const yocto = BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(MAX_NEAR_DECIMALS, '0') || '0');
  return checkU128(yocto, near).toString();
}

/**
 * Convert yocto ("1500000000000000000000000") to a NEAR decimal string ("1.5"),
 * trimming trailing zeros (and the dot when the fraction is zero).
 */
export function yoctoToNear(y: Yocto): string {
  return formatUnits(y, MAX_NEAR_DECIMALS);
}

/** Add two yocto values; returns a yocto decimal string. A sum above u128::MAX throws INVALID_AMOUNT. */
export function addYocto(a: Yocto, b: Yocto): Yocto {
  return checkU128(parseYocto(a) + parseYocto(b), `${a} + ${b}`).toString();
}

/** Compare two yocto values: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareYocto(a: Yocto, b: Yocto): -1 | 0 | 1 {
  const x = parseYocto(a);
  const y = parseYocto(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/** The native NEAR payment option for a service priced at `priceYocto`. */
export function nativeNearOption(priceYocto: Yocto): PaymentOption {
  return { asset: NEAR_NATIVE_ASSET, amount: priceYocto, decimals: MAX_NEAR_DECIMALS, symbol: 'NEAR' };
}

/** Human-readable NEAR amount, e.g. formatNear("2000000000000000000000") === "0.002 NEAR". */
export function formatNear(y: Yocto): string {
  return `${yoctoToNear(y)} NEAR`;
}

/**
 * Format an atomic token amount for a token with `decimals` places, trimming
 * trailing zeros — e.g. formatUnits("1500000", 6) === "1.5".
 */
export function formatUnits(atomic: string, decimals: number): string {
  const v = parseYocto(atomic); // reuse the non-negative-integer-string and u128 guards
  if (!Number.isInteger(decimals) || decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Human-readable token amount, e.g. formatToken("1500000", 6, "USDC") === "1.5 USDC". */
export function formatToken(atomic: string, decimals: number, symbol: string): string {
  return `${formatUnits(atomic, decimals)} ${symbol}`;
}
