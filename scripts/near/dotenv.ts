import { readFileSync } from 'node:fs';

/**
 * Minimal `.env` loader (the repo has no dotenv dependency): `KEY=VALUE` lines, `#` comment
 * lines, optional surrounding quotes. A variable already in the environment wins, so a value
 * exported in the shell overrides the file. Put a comment on its own line, never after a value.
 * A missing file is fine: the ambient environment is used as is.
 */
export function loadDotenv(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    const key = match?.[1];
    if (key === undefined || process.env[key] !== undefined) continue;
    const value = (match?.[2] ?? '').trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    process.env[key] = quoted?.[2] ?? value;
  }
}
