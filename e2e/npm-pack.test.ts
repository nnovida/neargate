/**
 * e2e/npm-pack.test.ts — the two npm packages, @neargate/cli and @neargate/sdk, as
 * `npm run npm:pack` builds them (scripts/npm-pack.ts):
 *   - the published manifest is public, points exports and types at the bundled dist/, names the
 *     repository, and depends on no private @agentgate/* package;
 *   - the tarball holds exactly dist/, README.md, LICENSE and package.json, and nothing in it
 *     names a private package or a local home directory;
 *   - the built SDK exports the paying client and its version, and the built CLI prints its
 *     version; both versions match their manifests and the docs badge.
 * Offline: the build runs tsup, the pack runs `npm pack`, and the imports resolve near-api-js from
 * the repository's node_modules.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCS_VERSION } from '../dashboard/lib/version';
import { NPM_PACKAGES, REPOSITORY_URL, packPackage, publishManifest } from '../scripts/npm-pack';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Under the repository, so the staged packages resolve their dependencies from its node_modules.
mkdirSync(path.join(REPO_ROOT, 'dist'), { recursive: true });
const OUT = mkdtempSync(path.join(REPO_ROOT, 'dist', 'npm-test-'));

type Manifest = Record<string, unknown>;
const readJson = (file: string): Manifest => JSON.parse(readFileSync(file, 'utf8')) as Manifest;

const tarballs: Record<string, string> = {};

beforeAll(() => {
  for (const { dir, homepage } of NPM_PACKAGES) tarballs[dir] = packPackage(dir, homepage, OUT);
}, 120_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

function listTarball(file: string): string[] {
  return execFileSync('tar', ['tzf', file], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '')
    .sort();
}

function stagedFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe.each(NPM_PACKAGES.map((p) => [p.dir, p.homepage] as const))('%s on npm', (dir, homepage) => {
  const workspace = readJson(path.join(REPO_ROOT, dir, 'package.json'));
  const stage = path.join(OUT, path.basename(dir));

  it('the workspace manifest stays private; the published one is public and complete', () => {
    expect(workspace['private']).toBe(true);
    const published = readJson(path.join(stage, 'package.json'));
    expect(published).toEqual(publishManifest(workspace, dir, homepage));
    expect(published['private']).toBeUndefined();
    expect(published['name']).toBe(workspace['name']);
    expect(published['version']).toBe(workspace['version']);
    expect(published['exports']).toEqual({ '.': { types: './dist/index.d.ts', import: './dist/index.js' } });
    expect(published['publishConfig']).toEqual({ access: 'public' });
    expect(published['repository']).toEqual({ type: 'git', url: `git+${REPOSITORY_URL}.git`, directory: dir });
    expect(published['scripts']).toBeUndefined();
    expect(published['devDependencies']).toBeUndefined();
    const deps = Object.keys((published['dependencies'] ?? {}) as Record<string, string>);
    expect(deps.filter((d) => d.startsWith('@agentgate/'))).toEqual([]);
  });

  it('the tarball holds the bundle, its types, the README and the LICENSE, and nothing private', () => {
    const files = listTarball(tarballs[dir]!);
    expect(files).toContain('package/dist/index.js');
    expect(files).toContain('package/dist/index.d.ts');
    expect(files).toContain('package/README.md');
    expect(files).toContain('package/LICENSE');
    expect(files.filter((f) => !/^package\/(dist\/[\w.-]+\.(js|d\.ts)|README\.md|LICENSE|package\.json)$/.test(f))).toEqual([]);
    for (const file of stagedFiles(stage)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/@agentgate\//);
      expect(text, file).not.toMatch(/\/home\/[a-z]|\/Users\/[A-Za-z]/);
    }
  });
});

describe('the built packages run', () => {
  it('the SDK exports the paying client, the chain factory and its version', async () => {
    const sdk = (await import(pathToFileURL(path.join(OUT, 'sdk', 'dist', 'index.js')).href)) as Record<string, unknown>;
    for (const name of ['createAgentGateClient', 'createNearGateChain', 'createChainClient', 'loadConfig', 'nearToYocto']) {
      expect(typeof sdk[name], name).toBe('function');
    }
    const version = readJson(path.join(REPO_ROOT, 'packages/sdk/package.json'))['version'];
    expect(sdk['SDK_VERSION']).toBe(version);
    expect(DOCS_VERSION.sdk).toBe(version);
  });

  it('the CLI prints its version, the one in its manifest and on the docs badge', () => {
    const version = readJson(path.join(REPO_ROOT, 'packages/cli/package.json'))['version'];
    const printed = execFileSync(process.execPath, [path.join(OUT, 'cli', 'dist', 'bin.js'), '--version'], {
      encoding: 'utf8',
    }).trim();
    expect(printed).toBe(version);
    expect(DOCS_VERSION.cli).toBe(version);
  });
});
