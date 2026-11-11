/**
 * e2e/deploy-config.test.ts — the hosting files, read as data: the pm2 ecosystem file is required
 * (never started) and the compose and vercel files are read as text. Nothing here starts a
 * process, runs docker or reaches a network.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ECOSYSTEM = path.join(REPO_ROOT, 'deploy', 'neargate.ecosystem.config.cjs');
const nodeRequire = createRequire(import.meta.url);

interface Pm2App {
  name: string;
  cwd: string;
  script: string;
  args: string;
  instances?: number;
  exec_mode?: string;
  env: Record<string, string>;
}

function loadApps(file: string): Pm2App[] {
  const { apps } = nodeRequire(file) as { apps: Pm2App[] };
  return apps;
}

function appNamed(apps: Pm2App[], name: string): Pm2App {
  const app = apps.find((a) => a.name === name);
  if (app === undefined) throw new Error(`no pm2 app named ${name}`);
  return app;
}

describe('deploy/neargate.ecosystem.config.cjs', () => {
  it('defines the gateway and the dashboard, named for NearGate', () => {
    expect(loadApps(ECOSYSTEM).map((a) => a.name)).toEqual(['neargate-gateway', 'neargate-dashboard']);
  });

  it('runs the gateway on :3012 as exactly one forked process behind one proxy hop', () => {
    const gateway = appNamed(loadApps(ECOSYSTEM), 'neargate-gateway');

    expect(gateway.env['MIDDLEWARE_PORT']).toBe('3012');
    // Receipts and rate limits live in this process's memory: a second instance would split them.
    expect(gateway.instances).toBe(1);
    expect(gateway.exec_mode).toBe('fork');
    expect(gateway.env['TRUST_PROXY']).toBe('1');
    expect(gateway.env['NODE_ENV']).toBe('production');
    expect(`${gateway.script} ${gateway.args}`).toBe('npm run dev:live');
    expect(gateway.cwd).toBe(REPO_ROOT.replace(/\/$/, ''));
  });

  it('runs the built dashboard on :3011 in production mode', () => {
    const dashboard = appNamed(loadApps(ECOSYSTEM), 'neargate-dashboard');

    expect(dashboard.env['PORT']).toBe('3011');
    expect(dashboard.env['NODE_ENV']).toBe('production');
    expect(`${dashboard.script} ${dashboard.args}`).toBe('npm run start');
    expect(dashboard.cwd).toBe(path.join(REPO_ROOT, 'dashboard'));
  });

  describe('the dashboard environment (pm2 does not read .env by itself)', () => {
    const NAMES = ['NEAR_NETWORK', 'NEAR_RPC_URL', 'NEAR_EXPLORER_URL', 'REGISTRY_CONTRACT_ID', 'AGENTGATE_MODE'];
    const saved: Record<string, string | undefined> = {};
    let fakeRepo: string;

    beforeEach(() => {
      for (const key of NAMES) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
      // The file resolves the repo root from its own location, so a copy in a scratch tree reads
      // the scratch tree's .env: a fake one holding secrets the dashboard must never receive.
      fakeRepo = mkdtempSync(path.join(os.tmpdir(), 'neargate-deploy-'));
      mkdirSync(path.join(fakeRepo, 'deploy'));
      copyFileSync(ECOSYSTEM, path.join(fakeRepo, 'deploy', 'neargate.ecosystem.config.cjs'));
      writeFileSync(
        path.join(fakeRepo, '.env'),
        [
          '# a comment',
          'NEAR_NETWORK=testnet',
          'NEAR_RPC_URL=',
          'NEAR_EXPLORER_URL="https://explorer.example"',
          'REGISTRY_CONTRACT_ID=registry.example.testnet',
          'AGENTGATE_MODE=mock',
          'AGENTGATE_ADMIN_TOKEN=not-a-real-token',
          'GATEWAY_ACCOUNT_ID=gateway.example.testnet',
          'GATEWAY_PRIVATE_KEY=ed25519:not-a-real-key',
          'ANTHROPIC_API_KEY=not-a-real-key',
          '',
        ].join('\n'),
      );
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(fakeRepo, { recursive: true, force: true });
    });

    it('carries the chain settings from the root .env and is forced into live mode', () => {
      const dashboard = appNamed(loadApps(path.join(fakeRepo, 'deploy', 'neargate.ecosystem.config.cjs')), 'neargate-dashboard');

      expect(dashboard.env).toMatchObject({
        AGENTGATE_MODE: 'live', // the .env says mock; a public deploy is live
        NEAR_NETWORK: 'testnet',
        NEAR_EXPLORER_URL: 'https://explorer.example', // quotes stripped
        REGISTRY_CONTRACT_ID: 'registry.example.testnet',
      });
      expect(dashboard.env).not.toHaveProperty('NEAR_RPC_URL'); // empty in the file: the default applies
    });

    it('never receives the gateway admin token, account ids or keys', () => {
      const dashboard = appNamed(loadApps(path.join(fakeRepo, 'deploy', 'neargate.ecosystem.config.cjs')), 'neargate-dashboard');

      const dump = JSON.stringify(dashboard.env);
      expect(dump).not.toMatch(/not-a-real|ADMIN_TOKEN|PRIVATE_KEY|ACCOUNT_ID|API_KEY/);
    });

    it('lets a value already in the environment win over the file, like the repo .env loader', () => {
      process.env['REGISTRY_CONTRACT_ID'] = 'from-the-shell.testnet';
      const dashboard = appNamed(loadApps(path.join(fakeRepo, 'deploy', 'neargate.ecosystem.config.cjs')), 'neargate-dashboard');

      expect(dashboard.env['REGISTRY_CONTRACT_ID']).toBeUndefined(); // not overridden: pm2 passes the shell value on
    });

    it('loads with no .env at all', () => {
      rmSync(path.join(fakeRepo, '.env'));

      const dashboard = appNamed(loadApps(path.join(fakeRepo, 'deploy', 'neargate.ecosystem.config.cjs')), 'neargate-dashboard');

      expect(dashboard.env['PORT']).toBe('3011');
    });
  });
});

describe('.dockerignore: secrets stay out of every image', () => {
  /** Docker's rule set: a later pattern overrides an earlier one, `!` re-includes, `**\/` spans directories. */
  function ignoreRules(): Array<{ negate: boolean; re: RegExp }> {
    return readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((line) => {
        const negate = line.startsWith('!');
        const glob = negate ? line.slice(1) : line;
        const source = glob
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\u0000/g, '(?:.*/)?');
        return { negate, re: new RegExp(`^${source}$`) };
      });
  }

  /** Whether the build context leaves `file` out: the path itself or any parent directory is ignored. */
  function isIgnored(file: string): boolean {
    const rules = ignoreRules();
    const parts = file.split('/');
    return parts.some((_, i) => {
      const candidate = parts.slice(0, i + 1).join('/');
      let ignored = false;
      for (const { negate, re } of rules) if (re.test(candidate)) ignored = !negate;
      return ignored;
    });
  }

  it('drops env files, keys and near credentials at the root and at any depth', () => {
    for (const file of [
      '.env',
      '.env.local',
      'dashboard/.env',
      'dashboard/.env.local',
      'dashboard/.env.production.local',
      'packages/middleware/.env',
      'keys/seller.pem',
      'dashboard/certs/tls.pem',
      '.near-credentials/testnet/seller.testnet.json',
      'packages/cli/.near-credentials-backup/key.json',
    ]) {
      expect(isIgnored(file), file).toBe(true);
    }
  });

  it('keeps the env template and ordinary dashboard sources', () => {
    for (const file of ['.env.example', 'dashboard/.env.example', 'dashboard/lib/server/chain.ts', 'dashboard/package.json']) {
      expect(isIgnored(file), file).toBe(false);
    }
  });
});

describe('hosting files: copy guard', () => {
  /**
   * The words the NEAR port retired. The config contract still spells two variables with the old
   * prefix, and the compose file and the ecosystem must name them to set them, so exactly those two
   * identifiers are exempt; any other mention is a failure.
   */
  const FORBIDDEN = /casper|cspr|\bmotes\b|account-hash|deploy hash|\bpem\b|agentgate/i;
  const ENV_VARS_STILL_NAMED_BY_THE_CONFIG = /\bAGENTGATE_(?:MODE|ADMIN_TOKEN)\b/g;

  function hostingFiles(): string[] {
    const deployDir = path.join(REPO_ROOT, 'deploy');
    const deployFiles = readdirSync(deployDir).map((f) => path.join(deployDir, f));
    return [...deployFiles, path.join(REPO_ROOT, 'docker-compose.hosting.yml'), path.join(REPO_ROOT, 'vercel.json')];
  }

  it('covers deploy/, the compose file and vercel.json (the guard cannot pass by scanning nothing)', () => {
    const names = hostingFiles().map((f) => path.relative(REPO_ROOT, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'deploy/README.md',
        'deploy/neargate.ecosystem.config.cjs',
        'docker-compose.hosting.yml',
        'vercel.json',
      ]),
    );
  });

  it('none of them says Casper, CSPR, motes, account-hash, deploy hash, PEM or agentgate', () => {
    const offenders: string[] = [];
    for (const file of hostingFiles()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.test(line.replace(ENV_VARS_STILL_NAMED_BY_THE_CONFIG, ''))) {
            offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
