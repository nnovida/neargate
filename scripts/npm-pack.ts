/**
 * scripts/npm-pack.ts — `npm run npm:pack`: builds the two packages NearGate publishes to npm,
 * @neargate/cli and @neargate/sdk, and packs each into a publish-ready tarball in dist/npm/.
 *
 * The workspace manifests stay `private` (they point at TypeScript sources the monorepo runs with
 * tsx and vitest), so nothing can be published from the workspace by mistake. This script writes
 * the manifest npm gets instead: exports and types pointing at the bundled dist/, the runtime
 * dependencies only (the private @agentgate/* packages are bundled in, code and types), no
 * scripts, plus the README and the repository's LICENSE. Publish exactly the tarball it prints:
 *
 *   npm publish dist/npm/neargate-sdk-<version>.tgz --access public
 *   npm publish dist/npm/neargate-cli-<version>.tgz --access public
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_URL = 'https://github.com/nnovida/neargate';

/** The packages published to npm, by workspace directory, with their homepage. */
export const NPM_PACKAGES = [
  { dir: 'packages/sdk', homepage: `${REPOSITORY_URL}/tree/main/packages/sdk#readme` },
  { dir: 'packages/cli', homepage: 'https://neargate-dashboard-production.up.railway.app/docs/cli' },
] as const;

type Manifest = Record<string, unknown>;

/** The manifest published for a workspace package: what npm users install. */
export function publishManifest(pkg: Manifest, dir: string, homepage: string): Manifest {
  const out: Manifest = {
    name: pkg['name'],
    version: pkg['version'],
    description: pkg['description'],
    type: 'module',
    license: pkg['license'],
    keywords: pkg['keywords'],
    engines: pkg['engines'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    types: './dist/index.d.ts',
    files: ['dist', 'README.md', 'LICENSE'],
    dependencies: pkg['dependencies'],
    repository: { type: 'git', url: `git+${REPOSITORY_URL}.git`, directory: dir },
    homepage,
    bugs: { url: `${REPOSITORY_URL}/issues` },
    publishConfig: { access: 'public' },
  };
  if (pkg['bin'] !== undefined) out['bin'] = pkg['bin'];
  return out;
}

function readJson(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

/** Builds, stages and packs one package; returns the tarball's path. */
export function packPackage(dir: string, homepage: string, outRoot: string): string {
  const pkgDir = path.join(REPO_ROOT, dir);
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  execFileSync('npx', ['tsup'], { cwd: pkgDir, stdio: 'pipe' });

  const stage = path.join(outRoot, path.basename(dir));
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(path.join(pkgDir, 'dist'), path.join(stage, 'dist'), { recursive: true });
  cpSync(path.join(pkgDir, 'README.md'), path.join(stage, 'README.md'));
  cpSync(path.join(REPO_ROOT, 'LICENSE'), path.join(stage, 'LICENSE'));
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(publishManifest(pkg, dir, homepage), null, 2)}\n`,
  );

  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', outRoot], {
    cwd: stage,
    encoding: 'utf8',
  });
  const [info] = JSON.parse(out) as { filename: string }[];
  if (info === undefined) throw new Error(`npm pack printed nothing for ${dir}`);
  return path.join(outRoot, info.filename);
}

function main(): void {
  const outRoot = path.join(REPO_ROOT, 'dist', 'npm');
  mkdirSync(outRoot, { recursive: true });
  for (const { dir, homepage } of NPM_PACKAGES) {
    const tarball = packPackage(dir, homepage, outRoot);
    if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);
    console.log(path.relative(REPO_ROOT, tarball));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
