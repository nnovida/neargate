export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function isLogLevel(v: string): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

export interface Logger {
  readonly name: string;
  readonly level: LogLevel;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Derived logger whose name is `<parent>.<name>` (same level). */
  child(name: string): Logger;
}

// Field keys whose values must never be logged in cleartext. Matched
// case-insensitively as a substring so e.g. `adminToken`, `csprCloudApiKey`,
// `Authorization`, `gateSignerPem`, `privateKey` all redact.
const SENSITIVE_KEY_RE =
  /(token|secret|api[-_]?key|password|passwd|authorization|private[-_]?key|privatekey|pem|mnemonic|seed|credential|signature|bearer)/i;

/** Masks a secret value while keeping a hint that it was present and its length. */
function maskSecret(value: unknown): string {
  if (typeof value === 'string' && value.length > 8) {
    return `${value.slice(0, 2)}…[redacted:${value.length}]`;
  }
  return '[redacted]';
}

/**
 * Recursively redacts values whose key looks sensitive. Defense-in-depth so a
 * stray `logger.info('x', { adminToken })` cannot leak a secret to stdout.
 * Depth- and cycle-guarded so it cannot loop on circular structures.
 */
function redactFields(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactFields(v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? maskSecret(v) : redactFields(v, seen, depth + 1);
  }
  return out;
}

function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch {
    // Circular or otherwise unserializable fields — degrade gracefully.
    const fallback: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      try {
        JSON.stringify(v);
        fallback[k] = v;
      } catch {
        fallback[k] = String(v);
      }
    }
    return JSON.stringify(fallback);
  }
}

/**
 * Tiny leveled JSON-lines logger writing to stdout:
 * `{"ts":"...","level":"info","name":"middleware","msg":"...", ...fields}`.
 * Level comes from `LOG_LEVEL` (default "info").
 */
export function createLogger(
  name: string,
  env: Record<string, string | undefined> = process.env,
): Logger {
  const raw = (env['LOG_LEVEL'] ?? 'info').toLowerCase();
  const level: LogLevel = isLogLevel(raw) ? raw : 'info';
  const threshold = LEVEL_WEIGHT[level];

  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[lvl] < threshold) return;
    const safeFields = redactFields(fields ?? {}) as Record<string, unknown>;
    const line = safeStringify({
      ts: new Date().toISOString(),
      level: lvl,
      name,
      msg,
      ...safeFields,
    });
    process.stdout.write(`${line}\n`);
  };

  return {
    name,
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (childName: string) => createLogger(`${name}.${childName}`, env),
  };
}
