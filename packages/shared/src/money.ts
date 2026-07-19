import type { Motes } from './types';
import { AgentGateError } from './errors';

/** 1 CSPR = 1_000_000_000 motes. */
export const MOTES_PER_CSPR = 1_000_000_000n;

/** Max decimal places a CSPR amount may carry (motes precision). */
const MAX_CSPR_DECIMALS = 9;

const CSPR_RE = /^(\d+)(?:\.(\d+))?$/;
const MOTES_RE = /^\d+$/;

function invalidAmount(value: unknown, why: string): AgentGateError {
  return new AgentGateError('INVALID_AMOUNT', `invalid amount ${JSON.stringify(String(value))}: ${why}`, 400);
}

/**
 * Parse a motes decimal string into a bigint.
 * Throws AgentGateError('INVALID_AMOUNT') on anything that is not a plain
 * non-negative integer decimal string (no sign, no decimals, no exponent).
 */
export function parseMotes(m: Motes): bigint {
  if (typeof m !== 'string' || !MOTES_RE.test(m)) {
    throw invalidAmount(m, 'motes must be a non-negative integer decimal string');
  }
  return BigInt(m);
}

/**
 * Convert a CSPR decimal string (e.g. "0.5") to motes ("500000000").
 * Bigint-backed — never goes through Number. Throws on:
 * negative values, more than 9 decimal places, exponents, or non-numeric input.
 */
export function csprToMotes(cspr: string): Motes {
  if (typeof cspr !== 'string') throw invalidAmount(cspr, 'must be a string');
  const match = CSPR_RE.exec(cspr.trim());
  if (!match) throw invalidAmount(cspr, 'must be a non-negative decimal string like "0.5"');
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > MAX_CSPR_DECIMALS) {
    throw invalidAmount(cspr, `at most ${MAX_CSPR_DECIMALS} decimal places (1 mote = 1e-9 CSPR)`);
  }
  const motes = BigInt(whole) * MOTES_PER_CSPR + BigInt(frac.padEnd(MAX_CSPR_DECIMALS, '0') || '0');
  return motes.toString();
}

/**
 * Convert motes ("1500000000") to a CSPR decimal string ("1.5"),
 * trimming trailing zeros (and the dot when the fraction is zero).
 */
export function motesToCspr(m: Motes): string {
  const v = parseMotes(m);
  const whole = v / MOTES_PER_CSPR;
  const frac = v % MOTES_PER_CSPR;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(MAX_CSPR_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Add two motes values; returns motes decimal string. */
export function addMotes(a: Motes, b: Motes): Motes {
  return (parseMotes(a) + parseMotes(b)).toString();
}

/** Compare two motes values: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareMotes(a: Motes, b: Motes): -1 | 0 | 1 {
  const x = parseMotes(a);
  const y = parseMotes(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/** Human-readable CSPR amount, e.g. formatCspr("500000000") === "0.5 CSPR". */
export function formatCspr(m: Motes): string {
  return `${motesToCspr(m)} CSPR`;
}

/**
 * Format an atomic token amount for a token with `decimals` places, trimming
 * trailing zeros — e.g. formatUnits("100000000", 9) === "0.1". Generalizes
 * motesToCspr to any decimal precision (used by the CEP-18 facilitator rail).
 */
export function formatUnits(atomic: string, decimals: number): string {
  const v = parseMotes(atomic); // reuse the non-negative-integer-string guard
  if (!Number.isInteger(decimals) || decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Human-readable token amount, e.g. formatToken("100000000", 9, "WCSPR") === "0.1 WCSPR". */
export function formatToken(atomic: string, decimals: number, symbol: string): string {
  return `${formatUnits(atomic, decimals)} ${symbol}`;
}
