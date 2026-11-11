/**
 * e2e/demo.test.ts — `npm run demo` (scripts/demo.ts) as a subprocess: exit 0 and exactly
 * the six-line transcript on stdout, the tx hashes checked by shape.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNearTxHash } from '@agentgate/shared';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEMO = path.join(REPO_ROOT, 'scripts/demo.ts');

describe('scripts/demo.ts (subprocess)', () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'neargate-e2e-demo-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('exits 0 and prints the six-line register → 402 → pay → serve → attest → score transcript', async () => {
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', DEMO],
        // Never inherit the host shell's NearGate settings; the demo needs none.
        { cwd: REPO_ROOT, env: { PATH: process.env['PATH'] ?? '', HOME: home }, timeout: 25_000 },
        (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
        },
      );
    });

    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines.pop()).toBe(''); // newline-terminated, nothing after the sixth line
    expect(lines).toHaveLength(6);

    expect(lines[0]).toBe('registered service #1');
    expect(lines[1]).toBe('402 invoice: 0.5 NEAR + 0.002 NEAR storage');
    const paid = /^paid: tx (\S+)$/.exec(lines[2]!);
    expect(paid, lines[2]).not.toBeNull();
    expect(isNearTxHash(paid![1])).toBe(true);
    expect(lines[3]).toBe('served: 200');
    const attested = /^attested: tx (\S+)$/.exec(lines[4]!);
    expect(attested, lines[4]).not.toBeNull();
    expect(isNearTxHash(attested![1])).toBe(true);
    expect(attested![1]).not.toBe(paid![1]);
    expect(lines[5]).toBe('score: 1/1 (new)');
  });
});
