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
    const line = safeStringify({
      ts: new Date().toISOString(),
      level: lvl,
      name,
      msg,
      ...(fields ?? {}),
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
