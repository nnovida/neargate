/**
 * e2e/cli-wrap-gateway.test.ts — live `neargate wrap` without `--gateway`, through the real bin.
 *
 * The registry stores a service's gateway URL for good. With the hosted default set
 * (DEFAULT_GATEWAY_URL), a live `wrap` that names no gateway gets past the gateway check and, with no
 * key in an empty HOME, stops at the missing key before any RPC request. GATEWAY_REQUIRED (no hosted
 * default and no flag) is unit-tested on resolveWrapGateway in packages/cli/test/cli.test.ts. The
 * "chain" here is a loopback HTTP server that counts requests; nothing leaves the machine.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'packages/cli/src/bin.ts');

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

describe('neargate wrap (subprocess, live mode, no --gateway)', () => {
  let rpc: Server;
  let rpcRequests = 0;
  let rpcUrl: string;
  let home: string;

  function runWrap(extra: string[]): Promise<CliRun> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          BIN,
          'wrap',
          'https://api.example.com/gold',
          '--price',
          '0.5',
          '--name',
          'Gold Spot Feed',
          '--account',
          'seller.testnet',
          ...extra,
        ],
        {
          cwd: REPO_ROOT,
          // Never inherit the host shell's NearGate settings; HOME is empty, so no key exists.
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: home,
            AGENTGATE_MODE: 'live',
            NEAR_RPC_URL: rpcUrl,
            REGISTRY_CONTRACT_ID: 'registry.example.testnet',
          },
          timeout: 20_000,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'neargate-e2e-wrap-'));
    rpc = createServer((_req, res) => {
      rpcRequests += 1;
      res.statusCode = 500;
      res.end();
    });
    await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
    rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => rpc.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  it('uses the hosted default gateway: no GATEWAY_REQUIRED, it stops at the missing key before any RPC request', async () => {
    const run = await runWrap([]);

    expect(run.code).toBe(1);
    expect(run.stderr).not.toContain('GATEWAY_REQUIRED');
    expect(run.stderr).toContain('SIGNER_MISSING');
    expect(run.stdout).toBe('');
    expect(rpcRequests).toBe(0);
  });

  it('with --gateway it gets past that check (here it stops at the missing key instead)', async () => {
    const run = await runWrap(['--gateway', 'https://gateway.example']);

    expect(run.code).toBe(1);
    expect(run.stderr).not.toContain('GATEWAY_REQUIRED');
    expect(run.stderr).toContain('SIGNER_MISSING');
    expect(run.stdout).toBe('');
  });
});
