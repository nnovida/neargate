import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '@agentgate/devnet';
import type { RunningServer } from '@agentgate/devnet';
import {
  AgentGateError,
  MOCK_NETWORK,
  MOCK_REGISTRY_ID,
  PAYMENT_STORAGE_FEE_YOCTO,
  REGISTRATION_DEPOSIT_YOCTO,
  isMockNetwork,
  isNearTxHash,
  loadConfig,
  nearToYocto,
} from '@agentgate/shared';
import type { ChainClient, MockSigner, RegisterServiceInput } from '@agentgate/shared';
import { MockChainHttpClient, createChainClient } from '../src/index';

const OWNER: MockSigner = { kind: 'mock', accountId: 'owner.mock' };
const ATTESTOR: MockSigner = { kind: 'mock', accountId: 'attestor.mock' };
const BUYER: MockSigner = { kind: 'mock', accountId: 'buyer.mock' };
const STRANGER: MockSigner = { kind: 'mock', accountId: 'stranger.mock' };

const GATEWAY = 'http://localhost:4021';
const PRICE = nearToYocto('0.5');
const FEE = PAYMENT_STORAGE_FEE_YOCTO;
const SELLER_TARGET = 'seller.mock';
const DEPOSIT = (BigInt(PRICE) + BigInt(FEE)).toString();

let server: RunningServer;
let base: string;
let chain: ChainClient;
let nonceCounter = 500_000;

function freshNonce(): string {
  nonceCounter += 1;
  return String(nonceCounter);
}

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

async function faucet(
  accountId: string,
  amountYocto: string,
): Promise<{ accountId: string; balanceYocto: string; publicKey: string; secretKey: string }> {
  const res = await fetch(`${base}/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, amountYocto }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    accountId: string;
    balanceYocto: string;
    publicKey: string;
    secretKey: string;
  };
}

/** The mock client throws `AgentGateError`: code = the ERR_* code, message starts with it. */
async function expectContractError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentGateError);
  const err = caught as AgentGateError;
  expect(err.code).toBe(code);
  expect(err.message.startsWith(`${code}: `)).toBe(true);
  expect(err.message.length).toBeGreaterThan(code.length + 2);
  expect(err.httpStatus).toBe(400);
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
  for (const signer of [OWNER, ATTESTOR, BUYER, STRANGER]) {
    await faucet(signer.accountId, nearToYocto('1000'));
  }
});

afterAll(async () => {
  await server.close();
});

describe('createChainClient', () => {
  it('selects MockChainHttpClient in mock mode, on the near-mock network', () => {
    expect(chain).toBeInstanceOf(MockChainHttpClient);
    expect(chain.network).toBe('near-mock');
    expect(chain.network).toBe(MOCK_NETWORK);
    expect(isMockNetwork(chain.network)).toBe(true);
    expect(chain.registryId).toBe('registry.mock');
    expect(chain.registryId).toBe(MOCK_REGISTRY_ID);
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

  it('rejects a non-http devnet URL', () => {
    expect(() => new MockChainHttpClient('ftp://localhost')).toThrow(AgentGateError);
    expect(() => new MockChainHttpClient('not a url')).toThrow(AgentGateError);
  });

  it('ping resolves while the devnet is up', async () => {
    await expect(chain.ping?.()).resolves.toBeUndefined();
  });
});

describe('MockChainHttpClient — full surface against an in-process devnet', () => {
  let serviceId: number;
  let payTx: string;
  const nonce = freshNonce();

  it('registerService returns the id and a base58 tx hash; reads see the computed endpointUrl', async () => {
    const registryBefore = BigInt(await chain.getBalance(MOCK_REGISTRY_ID));
    const ownerBefore = BigInt(await chain.getBalance(OWNER.accountId));

    const result = await chain.registerService(registerInput({ gatewayBaseUrl: `${GATEWAY}/` }), OWNER);
    expect(result.serviceId).toBeGreaterThanOrEqual(1);
    expect(result.txHash).toHaveLength(44);
    expect(isNearTxHash(result.txHash)).toBe(true);
    serviceId = result.serviceId;

    // the registration deposit moved from the owner to the registry
    expect(BigInt(await chain.getBalance(OWNER.accountId))).toBe(ownerBefore - BigInt(REGISTRATION_DEPOSIT_YOCTO));
    expect(BigInt(await chain.getBalance(MOCK_REGISTRY_ID))).toBe(registryBefore + BigInt(REGISTRATION_DEPOSIT_YOCTO));

    const record = await chain.getService(serviceId);
    expect(record).toMatchObject({
      id: serviceId,
      name: 'USD/IDR Feed',
      endpointUrl: `${GATEWAY}/svc/${serviceId}`,
      priceYocto: PRICE,
      paymentTarget: SELLER_TARGET,
      owner: OWNER.accountId,
      attestor: ATTESTOR.accountId,
      active: true,
      accepts: [{ asset: 'near', amount: PRICE, decimals: 24, symbol: 'NEAR' }],
    });

    const all = await chain.listServices();
    expect(all.some((s) => s.id === serviceId)).toBe(true);
  });

  it('getService returns null for unknown ids', async () => {
    expect(await chain.getService(424242)).toBeNull();
  });

  it('getBalance + pay: the price reaches the seller, the fee stays in the registry, the excess comes back', async () => {
    const buyerBefore = BigInt(await chain.getBalance(BUYER.accountId));
    const sellerBefore = BigInt(await chain.getBalance(SELLER_TARGET));
    const registryBefore = BigInt(await chain.getBalance(MOCK_REGISTRY_ID));

    const result = await chain.pay({ serviceId, nonce, depositYocto: nearToYocto('2') }, BUYER);
    expect(result.txHash).toHaveLength(44);
    expect(isNearTxHash(result.txHash)).toBe(true);
    payTx = result.txHash;

    expect(BigInt(await chain.getBalance(BUYER.accountId))).toBe(buyerBefore - BigInt(DEPOSIT));
    expect(BigInt(await chain.getBalance(SELLER_TARGET))).toBe(sellerBefore + BigInt(PRICE));
    expect(BigInt(await chain.getBalance(MOCK_REGISTRY_ID))).toBe(registryBefore + BigInt(FEE));
  });

  it('getPayment returns the registry record by nonce, null for an unknown nonce', async () => {
    const payment = await chain.getPayment(nonce);
    expect(payment).toMatchObject({
      nonce,
      serviceId,
      payer: BUYER.accountId,
      amountYocto: PRICE,
      selfPaid: false,
      attested: false,
    });
    expect(typeof payment?.timestamp).toBe('number');
    expect(typeof payment?.blockHeight).toBe('number');
    expect(await chain.getPayment(freshNonce())).toBeNull();
  });

  it('verifyPayment accepts the payment by nonce', async () => {
    const verdict = await chain.verifyPayment({
      nonce,
      serviceId,
      minAmountYocto: PRICE,
      maxAgeMs: 60_000,
      txHash: payTx,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountYocto).toBe(PRICE);
      expect(verdict.payer).toBe(BUYER.accountId);
      expect(verdict.selfPaid).toBe(false);
      expect(typeof verdict.timestamp).toBe('number');
    }
  });

  it('pay surfaces the contract and devnet errors as AgentGateError: code ERR_*, message starting with it', async () => {
    await expectContractError(
      chain.pay({ serviceId, nonce: freshNonce(), depositYocto: nearToYocto('999999999') }, BUYER),
      'ERR_INSUFFICIENT_BALANCE',
    );
    await expectContractError(chain.pay({ serviceId, nonce, depositYocto: DEPOSIT }, BUYER), 'ERR_NONCE_USED');
    await expectContractError(
      chain.pay({ serviceId, nonce: freshNonce(), depositYocto: PRICE }, BUYER),
      'ERR_DEPOSIT_TOO_LOW',
    );
    await expectContractError(chain.pay({ serviceId, nonce: 'abc', depositYocto: DEPOSIT }, BUYER), 'ERR_INVALID_NONCE');
    await expectContractError(
      chain.pay({ serviceId: 999_999, nonce: freshNonce(), depositYocto: DEPOSIT }, BUYER),
      'ERR_SERVICE_NOT_FOUND',
    );
    await expectContractError(
      chain.pay({ serviceId, nonce: freshNonce(), depositYocto: DEPOSIT }, { kind: 'mock', accountId: 'Bad Id' }),
      'ERR_INVALID_ACCOUNT_ID',
    );
  });

  it('recordAttestation bumps the score and lists newest first', async () => {
    const result = await chain.recordAttestation(
      { serviceId, nonce, paymentTxHash: payTx, success: true },
      ATTESTOR,
    );
    expect(isNearTxHash(result.txHash)).toBe(true);
    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 1, successCalls: 1 });
    expect((await chain.getPayment(nonce))?.attested).toBe(true);

    // a second payment, attested by the owner (also authorized)
    const nonce2 = freshNonce();
    const tx2 = (await chain.pay({ serviceId, nonce: nonce2, depositYocto: DEPOSIT }, BUYER)).txHash;
    await chain.recordAttestation({ serviceId, nonce: nonce2, paymentTxHash: tx2, success: false }, OWNER);
    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 2, successCalls: 1 });

    const attestations = await chain.listAttestations(serviceId);
    expect(attestations).toHaveLength(2);
    expect(attestations[0]).toMatchObject({ serviceId, nonce: nonce2, paymentTxHash: tx2, success: false });
    expect(attestations[1]).toMatchObject({ serviceId, nonce, paymentTxHash: payTx, success: true });
    expect(await chain.listAttestations(serviceId, 1)).toHaveLength(1);
  });

  it('rejects a stranger (ERR_NOT_AUTHORIZED) and a second attestation (ERR_ALREADY_ATTESTED)', async () => {
    await expectContractError(
      chain.recordAttestation({ serviceId, nonce, paymentTxHash: payTx, success: true }, STRANGER),
      'ERR_NOT_AUTHORIZED',
    );
    await expectContractError(
      chain.recordAttestation({ serviceId, nonce, paymentTxHash: payTx, success: true }, ATTESTOR),
      'ERR_ALREADY_ATTESTED',
    );
    await expectContractError(
      chain.recordAttestation({ serviceId, nonce: freshNonce(), paymentTxHash: payTx, success: true }, ATTESTOR),
      'ERR_PAYMENT_NOT_FOUND',
    );
  });

  it('a self-paid payment cannot be attested (ERR_SELF_PAYMENT)', async () => {
    const selfNonce = freshNonce();
    const selfTx = (await chain.pay({ serviceId, nonce: selfNonce, depositYocto: DEPOSIT }, OWNER)).txHash;
    await expectContractError(
      chain.recordAttestation({ serviceId, nonce: selfNonce, paymentTxHash: selfTx, success: true }, ATTESTOR),
      'ERR_SELF_PAYMENT',
    );
  });

  it('setActive is owner-only and inactive services reject payments and attestations', async () => {
    await expectContractError(chain.setActive(serviceId, false, STRANGER), 'ERR_NOT_AUTHORIZED');
    await expectContractError(chain.setActive(424_242, false, OWNER), 'ERR_SERVICE_NOT_FOUND');

    const pending = freshNonce();
    const pendingTx = (await chain.pay({ serviceId, nonce: pending, depositYocto: DEPOSIT }, BUYER)).txHash;

    const result = await chain.setActive(serviceId, false, OWNER);
    expect(isNearTxHash(result.txHash)).toBe(true);
    expect((await chain.getService(serviceId))?.active).toBe(false);

    await expectContractError(
      chain.recordAttestation({ serviceId, nonce: pending, paymentTxHash: pendingTx, success: true }, ATTESTOR),
      'ERR_SERVICE_INACTIVE',
    );
    await expectContractError(
      chain.pay({ serviceId, nonce: freshNonce(), depositYocto: DEPOSIT }, BUYER),
      'ERR_SERVICE_INACTIVE',
    );

    await chain.setActive(serviceId, true, OWNER);
    expect((await chain.getService(serviceId))?.active).toBe(true);
  });

  it('listRecentActivity returns newest-first events covering the whole loop, with mock tx hashes', async () => {
    const activity = await chain.listRecentActivity(100);
    expect(activity.length).toBeGreaterThanOrEqual(4);
    const timestamps = activity.map((e) => e.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    const heights = activity.map((e) => e.blockHeight);
    expect([...heights].sort((a, b) => b - a)).toEqual(heights);
    expect(new Set(heights).size).toBe(heights.length); // one block per call: strictly decreasing
    expect(new Set(activity.map((e) => e.kind))).toEqual(new Set(['service_registered', 'payment', 'attestation']));
    for (const event of activity) expect(isNearTxHash(event.txHash)).toBe(true);

    const payment = activity.find((e) => e.kind === 'payment' && e.nonce === nonce);
    expect(payment).toMatchObject({ serviceId, account: BUYER.accountId, txHash: payTx, amountYocto: PRICE });

    // an attestation event names the payment it attests (R33); its own hash stays txHash
    const attestation = activity.find((e) => e.kind === 'attestation' && e.nonce === nonce);
    expect(attestation).toMatchObject({ serviceId, account: ATTESTOR.accountId, paymentTxHash: payTx });
    expect(attestation?.txHash).not.toBe(payTx);
    for (const event of activity.filter((e) => e.kind !== 'attestation')) {
      expect(event).not.toHaveProperty('paymentTxHash');
    }

    expect(await chain.listRecentActivity(2)).toHaveLength(2);
    expect((await chain.listRecentActivity())[0]).toEqual(activity[0]);
  });

  it('isFullAccessKey: true only for the account\'s own devnet key', async () => {
    const owner = await faucet(OWNER.accountId, '1');
    const buyer = await faucet(BUYER.accountId, '1');
    expect(await chain.isFullAccessKey(OWNER.accountId, owner.publicKey)).toBe(true);
    expect(await chain.isFullAccessKey(BUYER.accountId, buyer.publicKey)).toBe(true);
    expect(await chain.isFullAccessKey(OWNER.accountId, buyer.publicKey)).toBe(false);
    expect(await chain.isFullAccessKey(OWNER.accountId, 'ed25519:nope')).toBe(false);
    expect(await chain.isFullAccessKey('never-seen.mock', owner.publicKey)).toBe(false);
    await expectContractError(chain.isFullAccessKey('Bad Id', owner.publicKey), 'ERR_INVALID_ACCOUNT_ID');
  });

  it('accountExists: true once the devnet has a balance record for the account', async () => {
    expect(await chain.accountExists('exists-later.mock')).toBe(false);
    await faucet('exists-later.mock', '1');
    expect(await chain.accountExists('exists-later.mock')).toBe(true);
    await expectContractError(chain.accountExists('Bad Id'), 'ERR_INVALID_ACCOUNT_ID');
    await expectAgentGateError(chain.accountExists(''), 'invalid_query', 400);
  });

  it('rejects non-mock signers and empty arguments before touching the devnet', async () => {
    await expectAgentGateError(
      chain.pay(
        { serviceId, nonce: freshNonce(), depositYocto: DEPOSIT },
        { kind: 'near', accountId: 'buyer.testnet', keyPath: '/tmp/nope.json' },
      ),
      'invalid_signer',
      400,
    );
    await expectAgentGateError(
      chain.pay({ serviceId, nonce: freshNonce(), depositYocto: DEPOSIT }, { kind: 'mock', accountId: ' ' }),
      'invalid_signer',
      400,
    );
    await expectAgentGateError(chain.getService(0), 'invalid_query', 400);
    await expectAgentGateError(chain.getBalance(''), 'invalid_query', 400);
    await expectAgentGateError(chain.isFullAccessKey('', 'ed25519:x'), 'invalid_query', 400);
    await expectAgentGateError(chain.isFullAccessKey(OWNER.accountId, ''), 'invalid_query', 400);
    await expectAgentGateError(
      chain.pay({ serviceId, nonce: freshNonce(), depositYocto: '1.5' }, BUYER),
      'invalid_query',
      400,
    );
  });

  it('registerService maps contract errors too', async () => {
    await expectContractError(chain.registerService(registerInput({ name: '  ' }), OWNER), 'ERR_EMPTY_NAME');
    await expectContractError(chain.registerService(registerInput({ priceYocto: '1' }), OWNER), 'ERR_INVALID_PRICE');
    await expectContractError(
      chain.registerService(registerInput({ name: 'n'.repeat(65) }), OWNER),
      'ERR_FIELD_TOO_LONG',
    );
    await expectContractError(
      chain.registerService(registerInput(), { kind: 'mock', accountId: 'unfunded-seller.mock' }),
      'ERR_INSUFFICIENT_BALANCE',
    );
  });
});

describe('MockChainHttpClient.verifyPayment — every failure reason, in the registry-record order', () => {
  let serviceId: number;
  let otherServiceId: number;
  let txHash: string;
  let nonce: string;
  const query = (overrides: Partial<Parameters<ChainClient['verifyPayment']>[0]> = {}) => ({
    nonce,
    serviceId,
    minAmountYocto: PRICE,
    maxAgeMs: 60_000,
    txHash,
    ...overrides,
  });

  beforeAll(async () => {
    serviceId = (await chain.registerService(registerInput(), OWNER)).serviceId;
    otherServiceId = (await chain.registerService(registerInput({ paymentTarget: 'someone-else.mock' }), OWNER))
      .serviceId;
    nonce = freshNonce();
    txHash = (await chain.pay({ serviceId, nonce, depositYocto: DEPOSIT }, BUYER)).txHash;
  });

  it('not_found for a nonce the registry never saw', async () => {
    expect(await chain.verifyPayment(query({ nonce: freshNonce() }))).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_service when the payment belongs to another service', async () => {
    expect(await chain.verifyPayment(query({ serviceId: otherServiceId }))).toEqual({
      ok: false,
      reason: 'wrong_service',
    });
    // an unknown service is the same answer: the payment is not for it
    expect(await chain.verifyPayment(query({ serviceId: 999_999 }))).toEqual({ ok: false, reason: 'wrong_service' });
  });

  it('amount_too_low when the paid price is below the minimum', async () => {
    expect(await chain.verifyPayment(query({ minAmountYocto: (BigInt(PRICE) + 1n).toString() }))).toEqual({
      ok: false,
      reason: 'amount_too_low',
    });
    // the fee is not part of the paid amount: exactly the price is enough
    expect((await chain.verifyPayment(query({ minAmountYocto: PRICE }))).ok).toBe(true);
  });

  it('expired when the payment is older than maxAgeMs', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await chain.verifyPayment(query({ maxAgeMs: 5 }))).toEqual({ ok: false, reason: 'expired' });
    expect((await chain.verifyPayment(query({ maxAgeMs: 60_000 }))).ok).toBe(true);
  });

  it('ok with selfPaid for a payment by the service owner', async () => {
    const ownerNonce = freshNonce();
    await chain.pay({ serviceId, nonce: ownerNonce, depositYocto: DEPOSIT }, OWNER);
    const verdict = await chain.verifyPayment(query({ nonce: ownerNonce, txHash: undefined }));
    expect(verdict).toMatchObject({ ok: true, payer: OWNER.accountId, amountYocto: PRICE, selfPaid: true });
  });

  it('ok with selfPaid for a payment by the payment target', async () => {
    const targetNonce = freshNonce();
    await faucet(SELLER_TARGET, nearToYocto('5'));
    await chain.pay({ serviceId, nonce: targetNonce, depositYocto: DEPOSIT }, { kind: 'mock', accountId: SELLER_TARGET });
    const verdict = await chain.verifyPayment(query({ nonce: targetNonce }));
    expect(verdict).toMatchObject({ ok: true, payer: SELLER_TARGET, selfPaid: true });
  });

  it('ignores txHash and payer: tx_mismatch is a live-only check', async () => {
    const verdict = await chain.verifyPayment(query({ txHash: 'F'.repeat(44), payer: 'someone-else.mock' }));
    expect(verdict).toMatchObject({ ok: true, payer: BUYER.accountId, selfPaid: false });
    expect((await chain.verifyPayment(query({ txHash: undefined }))).ok).toBe(true);
  });

  it('already_attested after the payment is attested', async () => {
    const attestedNonce = freshNonce();
    const tx = (await chain.pay({ serviceId, nonce: attestedNonce, depositYocto: DEPOSIT }, BUYER)).txHash;
    expect((await chain.verifyPayment(query({ nonce: attestedNonce }))).ok).toBe(true);
    await chain.recordAttestation({ serviceId, nonce: attestedNonce, paymentTxHash: tx, success: true }, ATTESTOR);
    expect(await chain.verifyPayment(query({ nonce: attestedNonce }))).toEqual({
      ok: false,
      reason: 'already_attested',
    });
  });

  it('checks wrong_service, then amount_too_low, then expired, then already_attested', async () => {
    const attestedNonce = freshNonce();
    const tx = (await chain.pay({ serviceId, nonce: attestedNonce, depositYocto: DEPOSIT }, BUYER)).txHash;
    await chain.recordAttestation({ serviceId, nonce: attestedNonce, paymentTxHash: tx, success: true }, ATTESTOR);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stale = { nonce: attestedNonce, maxAgeMs: 1 };
    const tooLow = (BigInt(PRICE) + 1n).toString();

    // attested + expired + too low + wrong service: wrong_service wins
    expect(await chain.verifyPayment(query({ ...stale, serviceId: otherServiceId, minAmountYocto: tooLow }))).toEqual({
      ok: false,
      reason: 'wrong_service',
    });
    // attested + expired + too low: amount_too_low wins
    expect(await chain.verifyPayment(query({ ...stale, minAmountYocto: tooLow }))).toEqual({
      ok: false,
      reason: 'amount_too_low',
    });
    // attested + expired: expired wins
    expect(await chain.verifyPayment(query(stale))).toEqual({ ok: false, reason: 'expired' });
    // attested only
    expect(await chain.verifyPayment(query({ nonce: attestedNonce }))).toEqual({
      ok: false,
      reason: 'already_attested',
    });
  });

  it('throws invalid_query on malformed queries instead of guessing', async () => {
    await expectAgentGateError(chain.verifyPayment(query({ minAmountYocto: '1.5' })), 'invalid_query', 400);
    await expectAgentGateError(chain.verifyPayment(query({ nonce: 'abc' })), 'invalid_query', 400);
    await expectAgentGateError(chain.verifyPayment(query({ serviceId: 0 })), 'invalid_query', 400);
    await expectAgentGateError(chain.verifyPayment(query({ maxAgeMs: -1 })), 'invalid_query', 400);
    await expectAgentGateError(chain.verifyPayment(query({ maxAgeMs: Number.NaN })), 'invalid_query', 400);
  });
});

describe('MockChainHttpClient key and account checks fail closed on a malformed devnet answer', () => {
  let stub: http.Server;
  let client: MockChainHttpClient;
  let answer = '';

  beforeAll(async () => {
    stub = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    client = new MockChainHttpClient(`http://127.0.0.1:${(stub.address() as AddressInfo).port}`);
  });

  afterAll(async () => {
    stub.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  it('passes a boolean answer through', async () => {
    answer = '{"fullAccess":true}';
    expect(await client.isFullAccessKey('owner.mock', 'ed25519:abc')).toBe(true);
    answer = '{"fullAccess":false}';
    expect(await client.isFullAccessKey('owner.mock', 'ed25519:abc')).toBe(false);
  });

  it.each(['{"fullAccess":"yes"}', '{"fullAccess":"true"}', '{"fullAccess":1}', '{"fullAccess":null}', '{}', 'null', '[]', 'not json', ''])(
    'throws devnet_bad_response instead of answering for %j',
    async (body) => {
      answer = body;
      await expect(client.isFullAccessKey('owner.mock', 'ed25519:abc')).rejects.toMatchObject({
        code: 'devnet_bad_response',
        httpStatus: 502,
      });
    },
  );

  it('accountExists passes a boolean answer through and fails closed on anything else', async () => {
    answer = '{"accountId":"owner.mock","exists":true}';
    expect(await client.accountExists('owner.mock')).toBe(true);
    answer = '{"accountId":"owner.mock","exists":false}';
    expect(await client.accountExists('owner.mock')).toBe(false);
    for (const body of ['{"exists":"yes"}', '{"exists":1}', '{"exists":null}', '{}', 'null', '[]', 'not json', '']) {
      answer = body;
      await expect(client.accountExists('owner.mock'), body).rejects.toMatchObject({
        code: 'devnet_bad_response',
        httpStatus: 502,
      });
    }
  });
});
