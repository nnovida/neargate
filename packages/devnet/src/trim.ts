/**
 * `str::trim` as Rust's registry contract applies it to a service name: strips Unicode
 * White_Space from both ends. That is U+0009-U+000D, U+0020, U+0085, U+00A0, U+1680,
 * U+2000-U+200A, U+2028, U+2029, U+202F, U+205F and U+3000. JS `String.prototype.trim` differs
 * (it strips U+FEFF, which Rust keeps, and keeps U+0085, which Rust strips).
 *
 * Scans from both ends instead of using an anchored `+` regex, which backtracks quadratically on
 * a long whitespace run followed by a non-space.
 */
function isWhiteSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

export function rustTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isWhiteSpace(value.charCodeAt(start))) start += 1;
  while (end > start && isWhiteSpace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}
