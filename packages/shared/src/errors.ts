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
