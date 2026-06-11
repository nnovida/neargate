/**
 * Minimal fetch shape used for every network call the CLI makes,
 * injectable in tests (`fetchImpl`). `globalThis.fetch` satisfies it.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
