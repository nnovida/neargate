/**
 * e2e/near-shell-scripts.test.ts — scripts/near/bootstrap-testnet.sh and deploy-registry.sh,
 * run as bash against STUB `near`, `curl` and `cargo` executables. The stubs record every call
 * and keep a tiny fake chain (one file per account), so the scripts' real logic runs: the
 * idempotent account creation, the refusals (missing account, low balance, existing contract),
 * the build → deploy → check order, and DRY_RUN=1 touching nothing. Nothing here reaches a
 * network, the real near CLI, or ~/.near-credentials.
 */
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NO_CODE = '11111111111111111111111111111111';
const NEAR_24 = '000000000000000000000000';

const STUBS: Record<string, string> = {
  curl: `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
body=""
while [ $# -gt 0 ]; do
  if [ "$1" = -d ]; then body=$2; fi
  shift
done
id=$(printf '%s' "$body" | sed -n 's/.*"account_id":"\\([^"]*\\)".*/\\1/p')
if [ -f "$STUB_STATE/$id" ]; then
  read -r amount code < "$STUB_STATE/$id"
  printf '{"jsonrpc":"2.0","result":{"amount":"%s","code_hash":"%s","locked":"0"},"id":"neargate"}' "$amount" "$code"
else
  printf '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_ACCOUNT","info":{"requested_account_id":"%s"}}},"id":"neargate"}' "$id"
fi
`,
  near: `#!/usr/bin/env bash
echo "near $*" >> "$STUB_LOG"
case "$1 $2" in
  "account create-account")
    prev=""
    for a in "$@"; do
      if [ "$prev" = sponsor-by-faucet-service ]; then echo "10000000000000000000000000 ${NO_CODE}" > "$STUB_STATE/$a"; fi
      prev=$a
    done ;;
  "contract deploy")
    read -r amount _ < "$STUB_STATE/$3"
    echo "$amount DEPLOYEDCODEHASH" > "$STUB_STATE/$3" ;;
  "contract call-function") echo "0" ;;
esac
if [ "$1" = tokens ]; then echo "balance of $2: 10 NEAR"; fi
`,
  cargo: `#!/usr/bin/env bash
echo "cargo $*" >> "$STUB_LOG"
mkdir -p "$STUB_ROOT/contracts/target/near/neargate_registry"
printf 'stub wasm' > "$STUB_ROOT/contracts/target/near/neargate_registry/neargate_registry.wasm"
`,
};

describe('scripts/near shell scripts (bash, stub near/curl/cargo)', () => {
  let tmp: string;
  let repo: string;
  let bin: string;
  let state: string;
  let home: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'neargate-shell-'));
    repo = path.join(tmp, 'repo');
    bin = path.join(tmp, 'bin');
    home = path.join(tmp, 'home');
    await mkdir(path.join(repo, 'scripts/near'), { recursive: true });
    await mkdir(path.join(repo, 'contracts/registry'), { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(home, { recursive: true });
    for (const name of ['bootstrap-testnet.sh', 'deploy-registry.sh']) {
      await copyFile(path.join(REPO_ROOT, 'scripts/near', name), path.join(repo, 'scripts/near', name));
    }
    for (const [name, body] of Object.entries(STUBS)) {
      await writeFile(path.join(bin, name), body);
      await chmod(path.join(bin, name), 0o755);
    }
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  });

  beforeEach(async () => {
    state = path.join(tmp, `state-${Math.random().toString(36).slice(2)}`);
    await mkdir(state, { recursive: true });
    await rm(path.join(repo, 'contracts/target'), { recursive: true, force: true });
  });

  async function putAccount(id: string, opts: { near?: string; code?: string } = {}): Promise<void> {
    await writeFile(path.join(state, id), `${opts.near ?? '10'}${NEAR_24} ${opts.code ?? NO_CODE}\n`);
  }

  async function bash(
    script: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string; calls: string[] }> {
    // One call log per run, so a test that runs a script twice sees each run's calls alone.
    const log = path.join(tmp, `calls-${Math.random().toString(36).slice(2)}.log`);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        'bash',
        [path.join(repo, 'scripts/near', script)],
        {
          cwd: repo,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: home,
            NEAR_RPC_URL: 'http://rpc.stub',
            STUB_LOG: log,
            STUB_STATE: state,
            STUB_ROOT: repo,
            ...env,
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
        },
      );
    });
    const calls = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l !== '');
    return { ...result, calls };
  }

  const creates = (calls: string[]): string[] => calls.filter((c) => c.startsWith('near account create-account'));
  const ids = (prefix: string): string[] =>
    ['registry', 'seller', 'gateway', 'buyer'].map((role) => `${prefix}-${role}.testnet`);

  describe('bootstrap-testnet.sh', () => {
    it('creates the four accounts through the faucet sponsor, saves keys in the legacy keychain, and is idempotent', async () => {
      const first = await bash('bootstrap-testnet.sh', { NEARGATE_PREFIX: 'neargate-1111' });
      expect(first.code, first.stderr).toBe(0);
      const made = creates(first.calls);
      expect(made).toHaveLength(4);
      ids('neargate-1111').forEach((id, i) => {
        expect(made[i]).toBe(
          `near account create-account sponsor-by-faucet-service ${id} autogenerate-new-keypair ` +
            '--signature-scheme ed25519 save-to-legacy-keychain network-config testnet create',
        );
      });
      expect(first.stdout).toContain('REGISTRY_CONTRACT_ID=neargate-1111-registry.testnet');
      expect(first.stdout).toContain('GATEWAY_ACCOUNT_ID=neargate-1111-gateway.testnet');
      expect(first.stdout).toContain('SELLER_ACCOUNT_ID=neargate-1111-seller.testnet');
      expect(first.stdout).toContain('BUYER_ACCOUNT_ID=neargate-1111-buyer.testnet');
      for (const id of ids('neargate-1111')) {
        expect(first.calls).toContain(`near tokens ${id} view-near-balance network-config testnet now`);
      }
      expect(first.stdout + first.stderr).not.toMatch(/private|secret|ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/i);

      const second = await bash('bootstrap-testnet.sh', { NEARGATE_PREFIX: 'neargate-1111' });
      expect(second.code, second.stderr).toBe(0);
      expect(creates(second.calls)).toEqual([]);
      expect(second.stdout.match(/^skip: .* already exists$/gm)).toHaveLength(4);
    });

    it('skips only what exists: a partial run creates the rest', async () => {
      await putAccount('neargate-2222-seller.testnet');
      await putAccount('neargate-2222-buyer.testnet');
      const run = await bash('bootstrap-testnet.sh', { NEARGATE_PREFIX: 'neargate-2222' });
      expect(run.code, run.stderr).toBe(0);
      expect(creates(run.calls).map((c) => c.split(' ')[4])).toEqual([
        'neargate-2222-registry.testnet',
        'neargate-2222-gateway.testnet',
      ]);
    });

    it('defaults the prefix to neargate-<MMDD>', async () => {
      const run = await bash('bootstrap-testnet.sh', { DRY_RUN: '1' });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/prefix=neargate-\d{4},/);
    });

    it('refuses a prefix that cannot be in a NEAR account id, before running anything', async () => {
      for (const prefix of ['Bad_Prefix', 'a b', '-lead', 'trail-', 'x'.repeat(47)]) {
        const run = await bash('bootstrap-testnet.sh', { NEARGATE_PREFIX: prefix });
        expect(run.code, prefix).not.toBe(0);
        expect(run.calls, prefix).toEqual([]);
      }
    });

    it('DRY_RUN=1 prints every command and runs none: no near, no curl, no cargo', async () => {
      const run = await bash('bootstrap-testnet.sh', { DRY_RUN: '1', NEARGATE_PREFIX: 'neargate-3333' });
      expect(run.code, run.stderr).toBe(0);
      expect(run.calls).toEqual([]);
      expect(run.stdout.match(/^\[dry-run\] near account create-account /gm)).toHaveLength(4);
      expect(run.stdout.match(/^\[dry-run\] near tokens /gm)).toHaveLength(4);
      expect(run.stdout).toContain(
        '[dry-run] near account create-account sponsor-by-faucet-service neargate-3333-registry.testnet ' +
          'autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet create',
      );
    });
  });

  describe('deploy-registry.sh', () => {
    const REGISTRY = 'neargate-4444-registry.testnet';
    const env = { NEARGATE_PREFIX: 'neargate-4444' };
    const wasm = (): string => path.join(repo, 'contracts/target/near/neargate_registry/neargate_registry.wasm');
    const notRun = (calls: string[]): void => {
      expect(calls.filter((c) => c.startsWith('cargo') || c.startsWith('near contract deploy'))).toEqual([]);
    };

    it('builds, deploys with the `new` init call, then reads services_count', async () => {
      await putAccount(REGISTRY);
      const run = await bash('deploy-registry.sh', env);
      expect(run.code, run.stderr).toBe(0);
      const steps = run.calls.filter((c) => !c.startsWith('curl'));
      expect(steps).toEqual([
        'cargo near build non-reproducible-wasm',
        `near contract deploy ${REGISTRY} use-file ${wasm()} with-init-call new json-args {} ` +
          'prepaid-gas 100 Tgas attached-deposit 0 NEAR network-config testnet sign-with-legacy-keychain send',
        `near contract call-function as-read-only ${REGISTRY} services_count json-args {} network-config testnet now`,
      ]);
      expect(run.stdout).toContain('== services_count (expect 0');
      expect(run.stdout).toMatch(/^wasm: 9 bytes, sha256 [0-9a-f]{64}$/m);
      expect(run.stdout).toContain(`REGISTRY_CONTRACT_ID=${REGISTRY}`);
    });

    it('REGISTRY_CONTRACT_ID wins over the prefix; anything that is not a testnet account is refused', async () => {
      await putAccount('custom-registry.testnet');
      const run = await bash('deploy-registry.sh', { ...env, REGISTRY_CONTRACT_ID: 'custom-registry.testnet' });
      expect(run.code, run.stderr).toBe(0);
      expect(run.calls.some((c) => c.startsWith('near contract deploy custom-registry.testnet '))).toBe(true);

      const bad = await bash('deploy-registry.sh', { REGISTRY_CONTRACT_ID: 'registry.near' });
      expect(bad.code).not.toBe(0);
      expect(bad.calls).toEqual([]);
    });

    it('refuses an account that does not exist yet and points at the bootstrap script', async () => {
      const run = await bash('deploy-registry.sh', env);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('npm run near:bootstrap');
      notRun(run.calls);
    });

    it('refuses an account that holds less than the minimum balance', async () => {
      await putAccount(REGISTRY, { near: '2' });
      const run = await bash('deploy-registry.sh', env);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(/under the 3 NEAR/);
      notRun(run.calls);

      await putAccount(REGISTRY, { near: '2' });
      const lowered = await bash('deploy-registry.sh', { ...env, MIN_REGISTRY_BALANCE_NEAR: '2' });
      expect(lowered.code, lowered.stderr).toBe(0);
    });

    it('compares balances of different digit counts correctly', async () => {
      await writeFile(path.join(state, REGISTRY), `999999999999999999999999 ${NO_CODE}\n`); // 0.999999 NEAR, 24 digits
      const run = await bash('deploy-registry.sh', { ...env, MIN_REGISTRY_BALANCE_NEAR: '1' });
      expect(run.code).not.toBe(0);
      notRun(run.calls);
      await writeFile(path.join(state, REGISTRY), `1${NEAR_24} ${NO_CODE}\n`); // exactly 1 NEAR
      const exact = await bash('deploy-registry.sh', { ...env, MIN_REGISTRY_BALANCE_NEAR: '1' });
      expect(exact.code, exact.stderr).toBe(0);
    });

    it('refuses to deploy over an existing contract; FORCE_REDEPLOY=1 deploys the code only, without `new`', async () => {
      await putAccount(REGISTRY, { code: 'SOMEOLDCODEHASH' });
      const refused = await bash('deploy-registry.sh', env);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('already holds a contract');
      expect(refused.stderr).toContain('FORCE_REDEPLOY=1');
      notRun(refused.calls);

      const forced = await bash('deploy-registry.sh', { ...env, FORCE_REDEPLOY: '1' });
      expect(forced.code, forced.stderr).toBe(0);
      const deploy = forced.calls.find((c) => c.startsWith('near contract deploy'));
      expect(deploy).toContain('without-init-call');
      expect(deploy).not.toContain('with-init-call');
      expect(deploy).not.toContain('json-args');
    });

    it('NEARGATE_REGISTRY_WASM deploys a prebuilt wasm and skips the build', async () => {
      await putAccount(REGISTRY);
      const prebuilt = path.join(tmp, 'prebuilt.wasm');
      await writeFile(prebuilt, 'prebuilt');
      const run = await bash('deploy-registry.sh', { ...env, NEARGATE_REGISTRY_WASM: prebuilt });
      expect(run.code, run.stderr).toBe(0);
      expect(run.calls.some((c) => c.startsWith('cargo'))).toBe(false);
      expect(run.calls.some((c) => c.includes(`use-file ${prebuilt} with-init-call new`))).toBe(true);
    });

    it('fails, without deploying, when the build leaves no wasm', async () => {
      await putAccount(REGISTRY);
      // A cargo that "succeeds" but writes no wasm.
      const brokenBin = path.join(tmp, 'broken-bin');
      await mkdir(brokenBin, { recursive: true });
      await writeFile(path.join(brokenBin, 'cargo'), '#!/usr/bin/env bash\necho "cargo $*" >> "$STUB_LOG"\n');
      await chmod(path.join(brokenBin, 'cargo'), 0o755);
      for (const name of ['curl', 'near']) {
        await copyFile(path.join(bin, name), path.join(brokenBin, name));
        await chmod(path.join(brokenBin, name), 0o755);
      }
      const run = await bash('deploy-registry.sh', { ...env, PATH: `${brokenBin}:/usr/bin:/bin` });
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('wasm not found');
      expect(run.calls.some((c) => c.startsWith('near contract deploy'))).toBe(false);
    });

    it('DRY_RUN=1 prints the plan and runs nothing: no near, no curl, no cargo, no build output', async () => {
      const run = await bash('deploy-registry.sh', { ...env, DRY_RUN: '1' });
      expect(run.code, run.stderr).toBe(0);
      expect(run.calls).toEqual([]);
      expect(run.stdout).toContain('[dry-run] cargo near build non-reproducible-wasm');
      expect(run.stdout).toContain(`[dry-run] near contract deploy ${REGISTRY} use-file `);
      expect(run.stdout).toContain("with-init-call new json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR'");
      expect(run.stdout).toContain(`[dry-run] near contract call-function as-read-only ${REGISTRY} services_count`);
      await expect(readFile(wasm())).rejects.toThrow();
    });
  });
});
