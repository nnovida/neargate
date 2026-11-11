import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Copy guard: the dashboard is NearGate on NEAR. No source, doc page or config file under
 * dashboard/ may still carry the Casper-era vocabulary (the chain, its token, its unit, its
 * account and deploy terms, or the PEM key files the old CLI took).
 */
const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THIS_FILE = fileURLToPath(import.meta.url);

const BANNED = /casper|cspr|motes|account-hash|deploy hash|\bpem\b/i;
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.mdx', '.json']);
const SKIPPED_DIRS = new Set(['node_modules', '.next']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) yield* walk(full);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry))) {
      yield full;
    }
  }
}

describe('dashboard copy guard', () => {
  it('scans a non-trivial number of files (the guard cannot pass by finding nothing)', () => {
    const files = [...walk(DASHBOARD_DIR)];
    expect(files.length).toBeGreaterThan(30);
  });

  it('no .ts/.tsx/.md/.mdx/.json file under dashboard/ mentions Casper, CSPR, motes, account-hash, deploy hash or PEM', () => {
    const offenders: string[] = [];
    for (const file of walk(DASHBOARD_DIR)) {
      if (file === THIS_FILE) continue; // it spells the banned words out
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (BANNED.test(line)) {
          offenders.push(`${path.relative(DASHBOARD_DIR, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
