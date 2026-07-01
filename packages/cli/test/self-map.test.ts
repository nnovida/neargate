import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyAlgorithm, PrivateKey } from 'casper-js-sdk';
import {
  buildSelfMapMessage,
  type AnySigner,
  type ChainClient,
  type RegisterServiceInput,
} from '@agentgate/shared';
import { verifyOwnerSignature } from '@agentgate/chain';
import { signMessage, wrapService } from '../src/index';

let dir: string;
let pemPath: string;
let ownerAcct: string;

beforeAll(async () => {
  const priv = PrivateKey.generate(KeyAlgorithm.SECP256K1);
  ownerAcct = priv.publicKey.accountHash().toPrefixedString();
  dir = await mkdtemp(join(tmpdir(), 'agentgate-pem-'));
  pemPath = join(dir, 'seller.pem');
  await writeFile(pemPath, priv.toPem(), { mode: 0o600 });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Minimal ChainClient: wrapService only calls registerService in these tests. */
function fakeChain(): ChainClient {
  return {
    network: 'casper-test',
    registerService: async (_input: RegisterServiceInput, _signer: AnySigner) => ({
      serviceId: 1,
      txHash: 'a'.repeat(64),
    }),
  } as unknown as ChainClient;
}

describe('signMessage (pem signer)', () => {
  it('produces a signature verifyOwnerSignature accepts under the derived owner', async () => {
    const msg = buildSelfMapMessage({
      network: 'casper-test',
      serviceId: 7,
      upstreamUrl: 'https://api.example.com/x',
      timestamp: 111,
    });
    const { publicKeyHex, signatureHex } = await signMessage({ kind: 'pem', pemPath }, msg);
    const res = verifyOwnerSignature(publicKeyHex, msg, signatureHex);
    expect(res.valid).toBe(true);
    expect(res.accountHash).toBe(ownerAcct);
  });

  it('rejects a mock signer (self-map needs a real key)', async () => {
    await expect(
      signMessage({ kind: 'mock', publicKey: `01${'a'.repeat(64)}` }, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'SIGNER_UNSUPPORTED' });
  });
});

describe('wrapService self-map path (pem signer)', () => {
  it('POSTs a valid owner-signed body to /services/:id/map (no admin token)', async () => {
    let capturedUrl = '';
    let capturedBody: {
      upstreamUrl: string;
      publicKeyHex: string;
      timestamp: number;
      signatureHex: string;
    } | null = null;
    let sawAuthHeader = true;

    const result = await wrapService({
      upstreamUrl: 'https://api.example.com/gold',
      priceCspr: '0.5',
      name: 'Gold',
      gateway: 'https://gw.example',
      chain: fakeChain(),
      signer: { kind: 'pem', pemPath },
      adminToken: 'dev-admin-token',
      mode: 'live',
      network: 'casper-test',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        sawAuthHeader = 'authorization' in ((init?.headers as Record<string, string>) ?? {});
        capturedBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
    });

    expect(result.adminOk).toBe(true);
    expect(capturedUrl).toBe('https://gw.example/services/1/map');
    expect(sawAuthHeader).toBe(false); // no bearer token on the self-map path
    expect(capturedBody).not.toBeNull();

    // Rebuild the challenge from the transmitted body and verify the signature.
    const body = capturedBody!;
    const msg = buildSelfMapMessage({
      network: 'casper-test',
      serviceId: 1,
      upstreamUrl: body.upstreamUrl,
      timestamp: body.timestamp,
    });
    const res = verifyOwnerSignature(body.publicKeyHex, msg, body.signatureHex);
    expect(res.valid).toBe(true);
    expect(res.accountHash).toBe(ownerAcct);
  });
});
