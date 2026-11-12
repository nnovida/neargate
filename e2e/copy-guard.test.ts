/**
 * e2e/copy-guard.test.ts — the repo-wide copy guard (ruling R5).
 *
 * NearGate runs on NEAR. An AI screener reads the code as well as the README, so no tracked file
 * may carry the vocabulary of the chain the project ran on before the port, or tell a reader to
 * fetch the CLI from npm. The patterns and the exemptions live in copy-rules.ts:
 *   - the README section starting `## Built on AgentGate` (the origin disclosure the event asks
 *     for) is the only place the retired words may appear; an npm fetch of the CLI appears nowhere;
 *   - the port's plan and review ledger (docs/superpowers/, .superpowers/), package-lock.json,
 *     build output and binary files are not scanned;
 *   - guard tests that spell a retired word to refuse it are skipped by the word check, each with
 *     its reason.
 *
 * The scan covers `git ls-files`, so a new file is covered the moment it is tracked.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NPM_CLI_FETCH,
  RETIRED_WORDS,
  UNSCANNED_FILES,
  UNSCANNED_PREFIXES,
  WORD_GUARD_FILES,
  linesOutsideDisclosure,
  type NumberedLine,
} from './copy-rules';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0').filter((f) => f !== '');
}

/** Tracked text files the guard reads: scanned paths only, binary files (a NUL byte) skipped. */
function scannedTextFiles(): Array<{ file: string; text: string }> {
  const files: Array<{ file: string; text: string }> = [];
  for (const file of trackedFiles()) {
    if (UNSCANNED_FILES.includes(file) || UNSCANNED_PREFIXES.some((p) => file.startsWith(p))) continue;
    const full = path.join(REPO_ROOT, file);
    if (!existsSync(full)) continue; // deleted in the working tree, not yet staged
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue;
    files.push({ file, text: bytes.toString('utf8') });
  }
  return files;
}

function numbered(text: string): NumberedLine[] {
  return text.split('\n').map((line, i) => ({ n: i + 1, line }));
}

function offenders(pattern: RegExp, skip: Readonly<Record<string, string>>, readmeSectionExempt: boolean): string[] {
  const found: string[] = [];
  for (const { file, text } of scannedTextFiles()) {
    if (Object.hasOwn(skip, file)) continue;
    const lines = file === 'README.md' && readmeSectionExempt ? linesOutsideDisclosure(text) : numbered(text);
    for (const { n, line } of lines) {
      if (pattern.test(line)) found.push(`${file}:${n}: ${line.trim().slice(0, 120)}`);
    }
  }
  return found;
}

describe('repo-wide copy guard', () => {
  it('scans every tracked text file outside the exclusions (the guard cannot pass by scanning nothing)', () => {
    const scanned = scannedTextFiles().map((f) => f.file);
    expect(scanned.length).toBeGreaterThan(250);
    expect(scanned).toEqual(
      expect.arrayContaining([
        'README.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        '.github/workflows/ci.yml',
        'contracts/README.md',
        'contracts/registry/src/lib.rs',
        'packages/middleware/src/app.ts',
        'dashboard/app/page.tsx',
        'docs/X-POST.md',
        'docs/DEMO-VIDEO.md',
      ]),
    );
  });

  it('no tracked file uses the retired chain vocabulary, except the README disclosure section', () => {
    expect(offenders(RETIRED_WORDS, WORD_GUARD_FILES, true)).toEqual([]);
  });

  it('no tracked file tells a reader to fetch the CLI from npm, the README included', () => {
    expect(offenders(NPM_CLI_FETCH, {}, false)).toEqual([]);
  });

  it('the npm-fetch pattern catches every way to fetch the CLI from npm, and not the workspace name alone', () => {
    // Built from parts, so this file never spells a form the fetch check refuses.
    const cli = ['@neargate', 'cli'].join('/');
    for (const fetch of [
      `npx ${cli} list`,
      `npx -y ${cli}@latest list`,
      `npx --yes ${cli} list`,
      `npm i -g ${cli}`,
      `npm install ${cli}@latest`,
      `npm install --global ${cli}`,
      `npm exec ${cli} -- list`,
    ]) {
      expect(NPM_CLI_FETCH.test(fetch), fetch).toBe(true);
    }
    for (const ok of [
      `"name": "${cli}",`,
      `import { buy } from '${cli}';`,
      `npm run build -w ${cli}`,
      `the CLI workspace is \`${cli}\`; run it with \`npm run neargate -- list\``,
      'npm run neargate -- list',
    ]) {
      expect(NPM_CLI_FETCH.test(ok), ok).toBe(false);
    }
  });

  it('every file the word check skips exists and still needs its exemption', () => {
    for (const file of Object.keys(WORD_GUARD_FILES)) {
      const full = path.join(REPO_ROOT, file);
      expect(existsSync(full), `${file} is exempt but missing`).toBe(true);
      expect(RETIRED_WORDS.test(readFileSync(full, 'utf8')), `${file} is exempt but no longer needs it`).toBe(true);
    }
  });
});
