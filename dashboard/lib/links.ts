/**
 * Link safety for URLs that come from the chain. The registry stores `gateway_base_url` as
 * arbitrary bytes, so a seller can register `javascript:…` or `data:…` as an endpoint: such a value
 * must never become an `href`.
 */

/** The URL itself when its scheme is http or https, else null (R35). */
export function httpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // `new URL` lower-cases the scheme and drops the tabs/newlines a browser drops too, so one
  // comparison covers HTTPS:// and JaVaScRiPt: alike.
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
}

/** The text shown in place of a chain URL that cannot be linked or pasted into a command. */
export const ENDPOINT_PLACEHOLDER = '<gateway endpoint>';

/**
 * A chain URL as one safe shell word for a copy-paste snippet: the normalized http(s) URL in single
 * quotes, so a seller who registers `https://x/$(cmd)` or `https://x/';rm …` cannot make the page's
 * "try it" command run anything. Any other value becomes a placeholder.
 */
export function shellUrl(raw: string): string {
  const safe = httpUrl(raw);
  if (safe === null) return ENDPOINT_PLACEHOLDER;
  return `'${new URL(safe).href.replace(/'/g, `'\\''`)}'`;
}
