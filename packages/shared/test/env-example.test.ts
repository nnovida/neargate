import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/index';

const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');

/** KEY=VALUE lines of .env.example, comments and blank lines skipped. */
function parseExample(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of example.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? '';
  }
  return env;
}

describe('.env.example', () => {
  it('names every variable loadConfig reads, and loadConfig accepts the file as shipped', () => {
    const env = parseExample();
    const read = new Set<string>();
    const spy = new Proxy(env, {
      get(target, key) {
        if (typeof key === 'string') read.add(key);
        return target[key as string];
      },
    });
    expect(() => loadConfig(spy)).not.toThrow();
    expect([...read].filter((key) => !(key in env))).toEqual([]);
  });

  it('holds placeholders only: no key material, no account ids, nothing to run live with', () => {
    const env = parseExample();
    for (const key of Object.keys(env).filter((k) => /PRIVATE_KEY|KEY_PATH|ACCOUNT_ID|API_KEY|REGISTRY_CONTRACT_ID/.test(k))) {
      expect(env[key], key).toBe('');
    }
    expect(example).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/);
  });

  it('keeps comments on their own lines (the .env loader does not strip text after a value)', () => {
    for (const line of example.split('\n')) {
      if (/^[A-Z0-9_]+=/.test(line)) expect(line, line).not.toMatch(/\s#/);
    }
  });
});
