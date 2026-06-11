/** Round to `dp` decimal places (half away from zero, epsilon-guarded). */
export function roundTo(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/**
 * Confidence across available source values (SPEC §7):
 * `max(0, 1 - (maxDev/mean) * 10)` rounded to 2dp; a single source → 0.5.
 */
export function confidenceOf(values: readonly number[]): number {
  if (values.length <= 1) return 0.5;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return 0;
  let maxDev = 0;
  for (const v of values) {
    const dev = Math.abs(v - mean);
    if (dev > maxDev) maxDev = dev;
  }
  return roundTo(Math.max(0, 1 - (maxDev / mean) * 10), 2);
}
