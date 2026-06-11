import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '@agentgate/devnet';
import type { RunningServer } from '@agentgate/devnet';
import { AgentGateError, loadConfig } from '@agentgate/shared';
import type { ChainClient, RegisterServiceInput, SignerRef } from '@agentgate/shared';
import { LiveCasperClient, MockChainHttpClient, createChainClient, mockAccountHash } from '../src/index';

const OWNER: SignerRef = { kind: 'mock', publicKey: '01aa11'.padEnd(66, '0') };
const ATTESTOR: SignerRef = { kind: 'mock', publicKey: '01bb22'.padEnd(66, '0') };
const BUYER: SignerRef = { kind: 'mock', publicKey: '01cc33'.padEnd(66, '0') };
const STRANGER: SignerRef = { kind: 'mock', publicKey: '01dd44'.padEnd(66, '0') };

const GATEWAY = 'http://localhost:4021';
const PRICE = '500000000'; // 0.5 CSPR
const SELLER_TARGET = mockAccountHash('01ee55'.padEnd(66, '0'));

let server: RunningServer;
let base: string;
let chain: ChainClient;

function registerInput(overrides: Partial<RegisterServiceInput> = {}): RegisterServiceInput {
  return {
    name: 'USD/IDR Feed',
    description: 'Spot USD/IDR with confidence',
    endpointUrl: GATEWAY,
    priceMotes: PRICE,
    paymentTarget: SELLER_TARGET,
    attestor: ATTESTOR.publicKey,
    ...overrides,
  };
}

async function faucet(account: string, amountMotes: string): Promise<void> {
  const res = await fetch(`${base}/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, amountMotes }),
  });
  expect(res.status).toBe(200);
  await res.json();
}

async function expectAgentGateError(
  promise: Promise<unknown>,
  code: string,
  httpStatus: number,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentGateError);
  const err = caught as AgentGateError;
  expect(err.code).toBe(code);
  expect(err.httpStatus).toBe(httpStatus);
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  chain = createChainClient(loadConfig({ AGENTGATE_MODE: 'mock', DEVNET_URL: base }));
});

afterAll(async () => {
  await server.close();
});

describe('mockAccountHash', () => {
  it('derives account-hash-<sha256 hex> deterministically', () => {
    const hash = mockAccountHash('01abcd');
    expect(hash).toMatch(/^account-hash-[0-9a-f]{64}$/);
    expect(mockAccountHash('01abcd')).toBe(hash);
    expect(mockAccountHash('01abce')).not.toBe(hash);
  });

  it('rejects empty public keys', () => {
    expect(() => mockAccountHash('')).toThrowError(AgentGateError);
  });
});

describe('createChainClient', () => {
  it('selects MockChainHttpClient in mock mode', () => {
    expect(chain).toBeInstanceOf(MockChainHttpClient);
    expect(chain.network).toBe('mock');
  });

  it('selects LiveCasperClient in live mode', () => {
    const live = createChainClient(
      loadConfig({
        AGENTGATE_MODE: 'live',
        CSPR_CLOUD_API_KEY: 'test-token',
        AGENTGATE_ADMIN_TOKEN: 'strong-token-for-tests',
      }),
    );
    expect(live).toBeInstanceOf(LiveCasperClient);
    expect(live.network).toBe('casper-test');
  });
});

describe('MockChainHttpClient — full surface against an in-process devnet', () => {
  let serviceId: number;
  let deployHash: string;
  const nonce = '987654321';

  it('registerService returns the id and tx hash; reads see the computed endpointUrl', async () => {
    const result = await chain.registerService(registerInput(), OWNER);
    expect(result.serviceId).toBeGreaterThanOrEqual(1);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    serviceId = result.serviceId;

    const record = await chain.getService(serviceId);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      id: serviceId,
      name: 'USD/IDR Feed',
      endpointUrl: `${GATEWAY}/svc/${serviceId}`,
      priceMotes: PRICE,
      paymentTarget: SELLER_TARGET,
      owner: OWNER.publicKey,
      attestor: ATTESTOR.publicKey,
      active: true,
    });

    const all = await chain.listServices();
    expect(all.some((s) => s.id === serviceId)).toBe(true);
  });

  it('getService returns null for unknown ids', async () => {
    expect(await chain.getService(424242)).toBeNull();
  });

  it('getBalance + transfer move motes and verifyTransfer accepts the payment', async () => {
    const buyerAccount = mockAccountHash(BUYER.publicKey);
    await faucet(buyerAccount, '1000000000');
    expect(await chain.getBalance(buyerAccount)).toBe('1000000000');

    const result = await chain.transfer(
      { to: SELLER_TARGET, amountMotes: PRICE, transferId: nonce },
      BUYER,
    );
    expect(result.deployHash).toMatch(/^[0-9a-f]{64}$/);
    deployHash = result.deployHash;

    expect(await chain.getBalance(buyerAccount)).toBe('500000000');
    expect(BigInt(await chain.getBalance(SELLER_TARGET))).toBeGreaterThanOrEqual(BigInt(PRICE));

    const verdict = await chain.verifyTransfer({
      deployHash,
      expectedTarget: SELLER_TARGET,
      minAmountMotes: PRICE,
      expectedTransferId: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountMotes).toBe(PRICE);
      expect(verdict.from).toBe(buyerAccount);
      expect(typeof verdict.timestamp).toBe('number');
    }
  });

  it('transfer surfaces insufficient_balance as a 400 AgentGateError', async () => {
    await expectAgentGateError(
      chain.transfer({ to: SELLER_TARGET, amountMotes: '999999999999999', transferId: '1' }, BUYER),
      'insufficient_balance',
      400,
    );
  });

  it('recordAttestation bumps the score and lists newest first', async () => {
    const result = await chain.recordAttestation(
      { serviceId, paymentDeployHash: deployHash, success: true },
      ATTESTOR,
    );
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 1, successCalls: 1 });

    await chain.recordAttestation(
      { serviceId, paymentDeployHash: 'f'.repeat(64), success: false },
      OWNER, // owner is also authorized
    );
    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 2, successCalls: 1 });

    const attestations = await chain.listAttestations(serviceId);
    expect(attestations).toHaveLength(2);
    expect(attestations[0]?.paymentDeployHash).toBe('f'.repeat(64));
    expect(attestations[1]).toMatchObject({
      serviceId,
      paymentDeployHash: deployHash,
      success: true,
    });
    expect(await chain.listAttestations(serviceId, 1)).toHaveLength(1);
  });

  it('rejects stranger attestations (403) and duplicates (409)', async () => {
    await expectAgentGateError(
      chain.recordAttestation(
        { serviceId, paymentDeployHash: '9'.repeat(64), success: true },
        STRANGER,
      ),
      'not_authorized',
      403,
    );
    await expectAgentGateError(
      chain.recordAttestation({ serviceId, paymentDeployHash: deployHash, success: true }, ATTESTOR),
      'duplicate_attestation',
      409,
    );
  });

  it('setActive is owner-only and inactive services reject attestations', async () => {
    await expectAgentGateError(chain.setActive(serviceId, false, STRANGER), 'not_authorized', 403);

    const result = await chain.setActive(serviceId, false, OWNER);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await chain.getService(serviceId))?.active).toBe(false);

    await expectAgentGateError(
      chain.recordAttestation(
        { serviceId, paymentDeployHash: '8'.repeat(64), success: true },
        ATTESTOR,
      ),
      'service_inactive',
      400,
    );

    await chain.setActive(serviceId, true, OWNER);
    expect((await chain.getService(serviceId))?.active).toBe(true);
  });

  it('listRecentActivity returns newest-first events covering the whole loop', async () => {
    const activity = await chain.listRecentActivity(100);
    expect(activity.length).toBeGreaterThanOrEqual(4);
    const timestamps = activity.map((e) => e.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    const kinds = new Set(activity.map((e) => e.kind));
    expect(kinds.has('service_registered')).toBe(true);
    expect(kinds.has('payment')).toBe(true);
    expect(kinds.has('attestation')).toBe(true);

    const limited = await chain.listRecentActivity(2);
    expect(limited).toHaveLength(2);
  });

  it('rejects non-mock signers', async () => {
    await expectAgentGateError(
      chain.transfer(
        { to: SELLER_TARGET, amountMotes: '1000', transferId: '5' },
        { kind: 'pem', pemPath: '/tmp/nope.pem' },
      ),
      'invalid_signer',
      400,
    );
  });
});

describe('MockChainHttpClient.verifyTransfer — every failure reason', () => {
  let deployHash: string;
  const nonce = '777000777';

  beforeAll(async () => {
    await faucet(mockAccountHash(BUYER.publicKey), '10000000000');
    const result = await chain.transfer(
      { to: SELLER_TARGET, amountMotes: PRICE, transferId: nonce },
      BUYER,
    );
    deployHash = result.deployHash;
  });

  it('not_found for unknown deploy hashes', async () => {
    const verdict = await chain.verifyTransfer({
      deployHash: '1'.repeat(64),
      expectedTarget: SELLER_TARGET,
      minAmountMotes: PRICE,
      expectedTransferId: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_target when the transfer went elsewhere (checked before amount)', async () => {
    const verdict = await chain.verifyTransfer({
      deployHash,
      expectedTarget: mockAccountHash('someone-else'),
      minAmountMotes: '999999999999', // also too low — target must win the ordering
      expectedTransferId: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'wrong_target' });
  });

  it('amount_too_low when the paid amount is below the minimum', async () => {
    const verdict = await chain.verifyTransfer({
      deployHash,
      expectedTarget: SELLER_TARGET,
      minAmountMotes: (BigInt(PRICE) + 1n).toString(),
      expectedTransferId: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('wrong_transfer_id when the nonce does not match', async () => {
    const verdict = await chain.verifyTransfer({
      deployHash,
      expectedTarget: SELLER_TARGET,
      minAmountMotes: PRICE,
      expectedTransferId: '123',
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'wrong_transfer_id' });
  });

  it('expired when the transfer is older than maxAgeMs', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const verdict = await chain.verifyTransfer({
      deployHash,
      expectedTarget: SELLER_TARGET,
      minAmountMotes: PRICE,
      expectedTransferId: nonce,
      maxAgeMs: 5,
    });
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  // 'pending' is unreachable in mock mode: devnet transfers settle synchronously
  // in the same request. The live client maps still-settling deploys to it.

  it('throws invalid_query on malformed queries instead of guessing', async () => {
    await expectAgentGateError(
      chain.verifyTransfer({
        deployHash,
        expectedTarget: SELLER_TARGET,
        minAmountMotes: '1.5',
        expectedTransferId: nonce,
        maxAgeMs: 60_000,
      }),
      'invalid_query',
      400,
    );
  });
});

describe('LiveCasperClient — NOT_DEPLOYED guard (no contract hash configured)', () => {
  const live = new LiveCasperClient(
    loadConfig({
      AGENTGATE_MODE: 'live',
      CSPR_CLOUD_API_KEY: 'test-token',
      AGENTGATE_ADMIN_TOKEN: 'strong-token-for-tests',
    }),
  );

  const expectNotDeployed = (promise: Promise<unknown>) =>
    expectAgentGateError(promise, 'NOT_DEPLOYED', 503);

  it('throws 503 NOT_DEPLOYED from every contract-dependent path', async () => {
    await expectNotDeployed(live.getService(1));
    await expectNotDeployed(live.listServices());
    await expectNotDeployed(live.getScore(1));
    await expectNotDeployed(live.listAttestations(1));
    await expectNotDeployed(live.listRecentActivity());
    await expectNotDeployed(
      live.registerService(registerInput({ attestor: ATTESTOR.publicKey }), {
        kind: 'pem',
        pemPath: '/tmp/unused.pem',
      }),
    );
    await expectNotDeployed(
      live.recordAttestation(
        { serviceId: 1, paymentDeployHash: 'a'.repeat(64), success: true },
        { kind: 'pem', pemPath: '/tmp/unused.pem' },
      ),
    );
    await expectNotDeployed(live.setActive(1, true, { kind: 'pem', pemPath: '/tmp/unused.pem' }));
  });
});
