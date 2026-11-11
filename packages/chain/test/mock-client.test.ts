import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '@agentgate/devnet';
import type { RunningServer } from '@agentgate/devnet';
import { AgentGateError, loadConfig } from '@agentgate/shared';
import type { ChainClient, MockSigner, RegisterServiceInput } from '@agentgate/shared';
import { MockChainHttpClient, createChainClient } from '../src/index';

// TODO(Task 3): port to the NEAR registry rules (pay / getPayment / selfPaid / already_attested).

const OWNER: MockSigner = { kind: 'mock', accountId: 'owner.mock' };
const ATTESTOR: MockSigner = { kind: 'mock', accountId: 'attestor.mock' };
const BUYER: MockSigner = { kind: 'mock', accountId: 'buyer.mock' };
const STRANGER: MockSigner = { kind: 'mock', accountId: 'stranger.mock' };

const GATEWAY = 'http://localhost:4021';
const PRICE = '500000000000000000000000'; // 0.5 NEAR
const SELLER_TARGET = 'seller.mock';

let server: RunningServer;
let base: string;
let chain: ChainClient;

function registerInput(overrides: Partial<RegisterServiceInput> = {}): RegisterServiceInput {
  return {
    name: 'USD/IDR Feed',
    description: 'Spot USD/IDR with confidence',
    gatewayBaseUrl: GATEWAY,
    priceYocto: PRICE,
    paymentTarget: SELLER_TARGET,
    attestor: ATTESTOR.accountId,
    ...overrides,
  };
}

async function faucet(account: string, amountYocto: string): Promise<void> {
  const res = await fetch(`${base}/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, amountYocto }),
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

describe('createChainClient', () => {
  it('selects MockChainHttpClient in mock mode', () => {
    expect(chain).toBeInstanceOf(MockChainHttpClient);
    expect(chain.network).toBe('mock');
    expect(chain.registryId).toBe('registry.mock');
  });

  it('refuses live mode with CONFIG_INVALID until the live NEAR client lands (Task 6)', () => {
    const config = loadConfig({ AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'strong-token-for-tests' });
    let thrown: unknown;
    try {
      createChainClient(config);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentGateError);
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringMatching(/Task 6/) });
  });
});

describe('MockChainHttpClient — full surface against an in-process devnet', () => {
  let serviceId: number;
  let txHash: string;
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
      priceYocto: PRICE,
      paymentTarget: SELLER_TARGET,
      owner: OWNER.accountId,
      attestor: ATTESTOR.accountId,
      active: true,
    });

    const all = await chain.listServices();
    expect(all.some((s) => s.id === serviceId)).toBe(true);
  });

  it('getService returns null for unknown ids', async () => {
    expect(await chain.getService(424242)).toBeNull();
  });

  it('getBalance + pay move yocto and verifyPayment accepts the payment', async () => {
    await faucet(BUYER.accountId, '1000000000000000000000000');
    expect(await chain.getBalance(BUYER.accountId)).toBe('1000000000000000000000000');

    const result = await chain.pay({ serviceId, nonce, depositYocto: PRICE }, BUYER);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    txHash = result.txHash;

    expect(await chain.getBalance(BUYER.accountId)).toBe('500000000000000000000000');
    expect(BigInt(await chain.getBalance(SELLER_TARGET))).toBeGreaterThanOrEqual(BigInt(PRICE));

    const verdict = await chain.verifyPayment({
      nonce,
      serviceId,
      minAmountYocto: PRICE,
      maxAgeMs: 60_000,
      txHash,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountYocto).toBe(PRICE);
      expect(verdict.payer).toBe(BUYER.accountId);
      expect(verdict.selfPaid).toBe(false);
      expect(typeof verdict.timestamp).toBe('number');
    }
  });

  it('pay surfaces insufficient_balance as a 400 AgentGateError', async () => {
    await expectAgentGateError(
      chain.pay({ serviceId, nonce: '1', depositYocto: '999999999999999999999999999' }, BUYER),
      'insufficient_balance',
      400,
    );
  });

  it('recordAttestation bumps the score and lists newest first', async () => {
    const result = await chain.recordAttestation(
      { serviceId, nonce, paymentTxHash: txHash, success: true },
      ATTESTOR,
    );
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 1, successCalls: 1 });

    await chain.recordAttestation(
      { serviceId, nonce: '2', paymentTxHash: 'G'.repeat(44), success: false },
      OWNER, // owner is also authorized
    );
    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 2, successCalls: 1 });

    const attestations = await chain.listAttestations(serviceId);
    expect(attestations).toHaveLength(2);
    expect(attestations[0]?.paymentTxHash).toBe('G'.repeat(44));
    expect(attestations[1]).toMatchObject({
      serviceId,
      nonce,
      paymentTxHash: txHash,
      success: true,
    });
    expect(await chain.listAttestations(serviceId, 1)).toHaveLength(1);
  });

  it('rejects stranger attestations (403) and duplicates (409)', async () => {
    await expectAgentGateError(
      chain.recordAttestation(
        { serviceId, nonce: '3', paymentTxHash: '9'.repeat(44), success: true },
        STRANGER,
      ),
      'not_authorized',
      403,
    );
    await expectAgentGateError(
      chain.recordAttestation({ serviceId, nonce, paymentTxHash: txHash, success: true }, ATTESTOR),
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
        { serviceId, nonce: '4', paymentTxHash: '8'.repeat(44), success: true },
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
      chain.pay(
        { serviceId, nonce: '5', depositYocto: PRICE },
        { kind: 'near', accountId: 'buyer.testnet', keyPath: '/tmp/nope.json' },
      ),
      'invalid_signer',
      400,
    );
  });
});

describe('MockChainHttpClient.verifyPayment — every failure reason', () => {
  let serviceId: number;
  let txHash: string;
  const nonce = '777000777';

  beforeAll(async () => {
    serviceId = (await chain.registerService(registerInput(), OWNER)).serviceId;
    await faucet(BUYER.accountId, '10000000000000000000000000');
    txHash = (await chain.pay({ serviceId, nonce, depositYocto: PRICE }, BUYER)).txHash;
  });

  it('not_found for unknown tx hashes', async () => {
    const verdict = await chain.verifyPayment({
      nonce,
      serviceId,
      minAmountYocto: PRICE,
      maxAgeMs: 60_000,
      txHash: 'F'.repeat(44), // well-formed (32 bytes) but unknown
    });
    expect(verdict).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_service when the payment went to another service', async () => {
    const other = (
      await chain.registerService(registerInput({ paymentTarget: 'someone-else.mock' }), OWNER)
    ).serviceId;
    const verdict = await chain.verifyPayment({
      nonce,
      serviceId: other,
      minAmountYocto: PRICE,
      maxAgeMs: 60_000,
      txHash,
    });
    expect(verdict).toEqual({ ok: false, reason: 'wrong_service' });
  });

  it('amount_too_low when the paid amount is below the minimum', async () => {
    const verdict = await chain.verifyPayment({
      nonce,
      serviceId,
      minAmountYocto: (BigInt(PRICE) + 1n).toString(),
      maxAgeMs: 60_000,
      txHash,
    });
    expect(verdict).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('tx_mismatch when the nonce does not match the tx', async () => {
    const verdict = await chain.verifyPayment({
      nonce: '123',
      serviceId,
      minAmountYocto: PRICE,
      maxAgeMs: 60_000,
      txHash,
    });
    expect(verdict).toEqual({ ok: false, reason: 'tx_mismatch' });
  });

  it('expired when the payment is older than maxAgeMs', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const verdict = await chain.verifyPayment({
      nonce,
      serviceId,
      minAmountYocto: PRICE,
      maxAgeMs: 5,
      txHash,
    });
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('throws invalid_query on malformed queries instead of guessing', async () => {
    await expectAgentGateError(
      chain.verifyPayment({
        nonce,
        serviceId,
        minAmountYocto: '1.5',
        maxAgeMs: 60_000,
        txHash,
      }),
      'invalid_query',
      400,
    );
  });
});
