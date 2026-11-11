/**
 * Structured error used across all AgentGate packages.
 * `code` is a stable machine-readable identifier (e.g. 'CONFIG_INVALID', 'NOT_DEPLOYED'),
 * `httpStatus` is the HTTP status servers should respond with when this error escapes.
 */
export class AgentGateError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 500) {
    super(message);
    this.name = 'AgentGateError';
    this.code = code;
    this.httpStatus = httpStatus;
    // Preserve prototype chain when targeting ES2022 (defensive; harmless when not needed).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard for AgentGateError. */
export function isAgentGateError(err: unknown): err is AgentGateError {
  return err instanceof AgentGateError;
}

const CHAIN_ERROR_CODE_RE = /^ERR_[A-Z_]+$/;
const CHAIN_ERROR_MESSAGE_RE = /^ERR_[A-Z_]+(?![A-Za-z0-9_])/;

/**
 * The `neargate-registry` contract's `ERR_*` code carried by a chain failure, or null when the
 * failure is not a contract rejection (transport error, timeout, plain bug). Chain-rule failures
 * are AgentGateErrors whose `code` IS the contract's code and whose message starts with it
 * ("ERR_ALREADY_ATTESTED: this payment is already attested"), in mock and live mode alike, so
 * callers branch on this instead of matching message text.
 */
export function chainErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && CHAIN_ERROR_CODE_RE.test(code)) return code;
  if (typeof message === 'string') {
    const match = CHAIN_ERROR_MESSAGE_RE.exec(message);
    if (match) return match[0];
  }
  return null;
}
