/** SWR fetcher + typed API errors for the dashboard's own /api/* routes. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`API ${status}: ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Client-side request cap so a hung server route can't leave the UI spinning. */
const FETCH_TIMEOUT_MS = 20_000;

export async function fetcher<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    // Dashboard server itself unreachable or timed out — treat like the chain
    // banner case so the "chain unreachable" UI shows promptly.
    throw new ApiError(0, 'network_error');
  }
  if (!res.ok) {
    let code = 'request_failed';
    try {
      const body: unknown = await res.json();
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { error?: unknown }).error === 'string'
      ) {
        code = (body as { error: string }).error;
      }
    } catch {
      // non-JSON error body — keep generic code
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

/** True when the API reported the chain/devnet as unreachable. */
export function isChainDown(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'chain_unreachable' || err.status === 0);
}

/** True when the API reported a missing resource (e.g. unknown service id). */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}
