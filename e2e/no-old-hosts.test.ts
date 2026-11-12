/**
 * e2e/no-old-hosts.test.ts — the hostnames and repository of the original AgentGate deployment are
 * retired. Until the team hosts NearGate, DEFAULT_GATEWAY_URL and DEFAULT_DASHBOARD_URL are empty and
 * no page links a repository, so none of those strings may be left in the shipped code, scripts,
 * deploy files or the env template. e2e/copy-guard.test.ts applies the same host check to every
 * tracked file, README.md and docs/ included.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DASHBOARD_URL, DEFAULT_GATEWAY_URL } from '@agentgate/shared';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

const SCANNED = ['packages', 'dashboard', 'scripts', 'deploy', 'e2e', '.env.example', 'docker-compose.hosting.yml'];
const OLD = /gateway\.example\.org|agentgate\.example\.org|example\.invalid\/AgentGate/i;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCANNED], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0').filter((f) => f !== '');
}

describe('the retired AgentGate hosts and repository', () => {
  it('the shared defaults are empty until NearGate is hosted', () => {
    expect(DEFAULT_GATEWAY_URL).toBe('');
    expect(DEFAULT_DASHBOARD_URL).toBe('');
  });

  it('no tracked file under packages/, dashboard/, scripts/, deploy/, e2e/, .env.example or the compose file names them', () => {
    const files = trackedFiles().filter((f) => path.join(REPO_ROOT, f) !== THIS_FILE);
    expect(files.length).toBeGreaterThan(100); // the guard cannot pass by scanning nothing

    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(path.join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (OLD.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
