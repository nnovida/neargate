/**
 * Strips trailing `/` characters from a URL or path segment.
 * Deliberately a loop instead of `.replace(/\/+$/, '')` — that regex
 * backtracks quadratically on adversarial input (CodeQL js/polynomial-redos).
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f /* '/' */) end--;
  return value.slice(0, end);
}
