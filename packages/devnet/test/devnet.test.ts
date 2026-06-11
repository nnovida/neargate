import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIVITY_LOG_CAP, startServer } from '../src/index';
import type { RunningServer } from '../src/index';

const accountHash = (publicKey: string): string =>
  `account-hash-${createHash('sha256').update(publicKey).digest('hex')}`;

const OWNER = '01aa00000000000000000000000000000000000000000000000000000000000001';
const ATTESTOR = '01bb00000000000000000000000000000000000000000000000000000000000002';
const BUYER = '01cc00000000000000000000000000000000000000000000000000000000000003';
const STRANGER = '01dd00000000000000000000000000000000000000000000000000000000000004';
const SELLER_TARGET = accountHash('01ee00000000000000000000000000000000000000000000000000000000000005');

const GATEWAY = 'http://localhost:4021';
const PRICE = '500000000'; // 0.5 CSPR

let server: RunningServer;
let base: string;

interface HttpResult {
  status: number;
  body: any;
}

async function post(path: string, body: unknown): Promise<HttpResult> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path: string): Promise<HttpResult> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function registerService(overrides: Record<string, unknown> = {}): Promise<HttpResult> {
  return post('/chain/register-service', {
    name: 'Gold Spot Feed',
    description: 'XAU/USD spot price with confidence score',
    endpointUrl: GATEWAY,
    priceMotes: PRICE,
    paymentTarget: SELLER_TARGET,
    attestor: ATTESTOR,
    ownerPublicKey: OWNER,
    ...overrides,
  });
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('devnet basics', () => {
  it('serves /healthz', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, network: 'mock' });
  });

  it('faucets and reads balances (motes strings, never numbers)', async () => {
    const account = accountHash('faucet-test-account');
    const res = await post('/faucet', { account, amountMotes: '1000000000000' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balanceMotes: '1000000000000' });

    const balance = await get(`/chain/balance/${account}`);
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({ account, balanceMotes: '1000000000000' });
  });

  it('returns 0 balance for unknown accounts and 404s on unknown routes', async () => {
    const balance = await get(`/chain/balance/${accountHash('never-funded')}`);
    expect(balance.body.balanceMotes).toBe('0');

    const missing = await get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('rejects malformed JSON bodies', async () => {
    const res = await fetch(`${base}/faucet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe('invalid_json');
  });
});

describe('happy path: register → transfer → attestation → score', () => {
  let serviceId: number;
  let registerTx: string;
  let paymentHash: string;

  it('registers a service and computes endpointUrl from the gateway base', async () => {
    const res = await registerService({ endpointUrl: `${GATEWAY}/` }); // trailing slash stripped
    expect(res.status).toBe(200);
    expect(res.body.serviceId).toBeGreaterThanOrEqual(1);
    expect(res.body.txHash).toMatch(/^[0-9a-f]{64}$/);
    serviceId = res.body.serviceId;
    registerTx = res.body.txHash;

    const record = await get(`/chain/services/${serviceId}`);
    expect(record.status).toBe(200);
    expect(record.body).toMatchObject({
      id: serviceId,
      name: 'Gold Spot Feed',
      endpointUrl: `${GATEWAY}/svc/${serviceId}`,
      priceMotes: PRICE,
      paymentTarget: SELLER_TARGET,
      owner: OWNER,
      attestor: ATTESTOR,
      active: true,
    });
    expect(typeof record.body.createdAt).toBe('number');

    const list = await get('/chain/services');
    expect(list.body.some((s: any) => s.id === serviceId)).toBe(true);
  });

  it('transfers exact price with transfer_id, debiting and crediting balances', async () => {
    await post('/faucet', { account: accountHash(BUYER), amountMotes: '1000000000' });
    const before = await get(`/chain/balance/${SELLER_TARGET}`);

    const res = await post('/chain/transfers', {
      fromPublicKey: BUYER,
      to: SELLER_TARGET,
      amountMotes: PRICE,
      transferId: '424242',
    });
    expect(res.status).toBe(200);
    expect(res.body.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof res.body.timestamp).toBe('number');
    paymentHash = res.body.deployHash;

    const buyerBalance = await get(`/chain/balance/${accountHash(BUYER)}`);
    expect(buyerBalance.body.balanceMotes).toBe('500000000');
    const after = await get(`/chain/balance/${SELLER_TARGET}`);
    expect(BigInt(after.body.balanceMotes) - BigInt(before.body.balanceMotes)).toBe(BigInt(PRICE));

    const lookup = await get(`/chain/transfers/${paymentHash}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({
      deployHash: paymentHash,
      from: accountHash(BUYER),
      to: SELLER_TARGET,
      amountMotes: PRICE,
      transferId: '424242',
    });

    const missing = await get(`/chain/transfers/${'0'.repeat(64)}`);
    expect(missing.status).toBe(404);
  });

  it('records an attestation by the attestor and bumps the score', async () => {
    const res = await post('/chain/attestations', {
      serviceId,
      paymentDeployHash: paymentHash,
      success: true,
      byPublicKey: ATTESTOR,
    });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toMatch(/^[0-9a-f]{64}$/);

    const score = await get(`/chain/services/${serviceId}/score`);
    expect(score.body).toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('also accepts attestations from the owner (auth: attestor OR owner)', async () => {
    const res = await post('/chain/attestations', {
      serviceId,
      paymentDeployHash: `${'a'.repeat(63)}1`,
      success: false,
      byPublicKey: OWNER,
    });
    expect(res.status).toBe(200);

    const score = await get(`/chain/services/${serviceId}/score`);
    expect(score.body).toEqual({ totalCalls: 2, successCalls: 1 });

    const attestations = await get(`/chain/services/${serviceId}/attestations`);
    expect(attestations.body).toHaveLength(2);
    // newest first
    expect(attestations.body[0].paymentDeployHash).toBe(`${'a'.repeat(63)}1`);
    expect(attestations.body[1].paymentDeployHash).toBe(paymentHash);
    expect(attestations.body[1]).toMatchObject({ serviceId, success: true });

    const limited = await get(`/chain/services/${serviceId}/attestations?limit=1`);
    expect(limited.body).toHaveLength(1);
  });

  it('shows the loop in the activity feed, newest first', async () => {
    const res = await get('/chain/activity?limit=50');
    expect(res.status).toBe(200);
    const mine = res.body.filter(
      (e: any) => e.serviceId === serviceId || e.txHash === registerTx || e.txHash === paymentHash,
    );
    const kinds = mine.map((e: any) => e.kind);
    expect(kinds).toEqual(['attestation', 'attestation', 'payment', 'service_registered']);
    const payment = mine.find((e: any) => e.kind === 'payment');
    expect(payment.amountMotes).toBe(PRICE);
    expect(payment.txHash).toBe(paymentHash);
    const timestamps = mine.map((e: any) => e.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });
});

describe('contract-rule mirroring', () => {
  it('403s attestations from a stranger (neither attestor nor owner)', async () => {
    const reg = await registerService();
    const res = await post('/chain/attestations', {
      serviceId: reg.body.serviceId,
      paymentDeployHash: 'b'.repeat(64),
      success: true,
      byPublicKey: STRANGER,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_authorized');
  });

  it('409s a duplicate payment hash for the same service, but allows it on another service', async () => {
    const regA = await registerService();
    const regB = await registerService();
    const dup = 'c'.repeat(64);

    const first = await post('/chain/attestations', {
      serviceId: regA.body.serviceId,
      paymentDeployHash: dup,
      success: true,
      byPublicKey: ATTESTOR,
    });
    expect(first.status).toBe(200);

    const second = await post('/chain/attestations', {
      serviceId: regA.body.serviceId,
      paymentDeployHash: dup,
      success: false,
      byPublicKey: ATTESTOR,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('duplicate_attestation');

    // score unchanged by the rejected duplicate
    const score = await get(`/chain/services/${regA.body.serviceId}/score`);
    expect(score.body).toEqual({ totalCalls: 1, successCalls: 1 });

    const other = await post('/chain/attestations', {
      serviceId: regB.body.serviceId,
      paymentDeployHash: dup,
      success: true,
      byPublicKey: ATTESTOR,
    });
    expect(other.status).toBe(200);
  });

  it('400s transfers exceeding the sender balance without mutating balances', async () => {
    const poorPub = '01ff00000000000000000000000000000000000000000000000000000000000006';
    await post('/faucet', { account: accountHash(poorPub), amountMotes: '100' });
    const res = await post('/chain/transfers', {
      fromPublicKey: poorPub,
      to: SELLER_TARGET,
      amountMotes: '101',
      transferId: '7',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('insufficient_balance');

    const balance = await get(`/chain/balance/${accountHash(poorPub)}`);
    expect(balance.body.balanceMotes).toBe('100');
  });

  it('enforces owner-only set_active and rejects attestations on inactive services', async () => {
    const reg = await registerService();
    const id = reg.body.serviceId;

    const denied = await post(`/chain/services/${id}/active`, {
      active: false,
      byPublicKey: STRANGER,
    });
    expect(denied.status).toBe(403);

    const attestorDenied = await post(`/chain/services/${id}/active`, {
      active: false,
      byPublicKey: ATTESTOR,
    });
    expect(attestorDenied.status).toBe(403);

    const ok = await post(`/chain/services/${id}/active`, { active: false, byPublicKey: OWNER });
    expect(ok.status).toBe(200);
    expect(ok.body.txHash).toMatch(/^[0-9a-f]{64}$/);

    const record = await get(`/chain/services/${id}`);
    expect(record.body.active).toBe(false);

    const attempt = await post('/chain/attestations', {
      serviceId: id,
      paymentDeployHash: 'd'.repeat(64),
      success: true,
      byPublicKey: ATTESTOR,
    });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error).toBe('service_inactive');

    const reactivate = await post(`/chain/services/${id}/active`, {
      active: true,
      byPublicKey: OWNER,
    });
    expect(reactivate.status).toBe(200);
    const after = await get(`/chain/services/${id}`);
    expect(after.body.active).toBe(true);
  });

  it('404s attestations and set_active for unknown services', async () => {
    const attest = await post('/chain/attestations', {
      serviceId: 999999,
      paymentDeployHash: 'e'.repeat(64),
      success: true,
      byPublicKey: ATTESTOR,
    });
    expect(attest.status).toBe(404);

    const active = await post('/chain/services/999999/active', {
      active: false,
      byPublicKey: OWNER,
    });
    expect(active.status).toBe(404);

    const record = await get('/chain/services/999999');
    expect(record.status).toBe(404);

    // unknown service score mirrors the contract's default mapping value
    const score = await get('/chain/services/999999/score');
    expect(score.body).toEqual({ totalCalls: 0, successCalls: 0 });
  });

  it('validates registration inputs like the contract (empty name, price floor)', async () => {
    const emptyName = await registerService({ name: '   ' });
    expect(emptyName.status).toBe(400);
    expect(emptyName.body.error).toBe('empty_name');

    const lowPrice = await registerService({ priceMotes: '999' });
    expect(lowPrice.status).toBe(400);
    expect(lowPrice.body.error).toBe('invalid_price');

    const badTarget = await registerService({ paymentTarget: 'not-an-account-hash' });
    expect(badTarget.status).toBe(400);
    expect(badTarget.body.error).toBe('invalid_payment_target');

    const badUrl = await registerService({ endpointUrl: 'ftp://example.com' });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error).toBe('invalid_endpoint_url');
  });

  it('validates transfer inputs (motes strings, u64 transfer ids)', async () => {
    const floatAmount = await post('/chain/transfers', {
      fromPublicKey: BUYER,
      to: SELLER_TARGET,
      amountMotes: '1.5',
      transferId: '1',
    });
    expect(floatAmount.status).toBe(400);

    const hugeId = await post('/chain/transfers', {
      fromPublicKey: BUYER,
      to: SELLER_TARGET,
      amountMotes: '1000',
      transferId: '18446744073709551616', // u64::MAX + 1
    });
    expect(hugeId.status).toBe(400);
  });
});

describe('activity log cap', () => {
  it(`keeps only the newest ${ACTIVITY_LOG_CAP} events`, async () => {
    const whalePub = '01ab00000000000000000000000000000000000000000000000000000000000007';
    await post('/faucet', { account: accountHash(whalePub), amountMotes: '1000000000000000' });

    let firstHash = '';
    let lastHash = '';
    for (let i = 0; i < ACTIVITY_LOG_CAP + 5; i += 1) {
      const res = await post('/chain/transfers', {
        fromPublicKey: whalePub,
        to: SELLER_TARGET,
        amountMotes: '1000',
        transferId: String(1_000_000 + i),
      });
      expect(res.status).toBe(200);
      if (i === 0) firstHash = res.body.deployHash;
      lastHash = res.body.deployHash;
    }

    const res = await get('/chain/activity?limit=1000');
    expect(res.body).toHaveLength(ACTIVITY_LOG_CAP);
    expect(res.body[0].txHash).toBe(lastHash); // newest first
    expect(res.body.some((e: any) => e.txHash === firstHash)).toBe(false); // oldest dropped
  }, 60_000);

  it('rejects out-of-range limit values', async () => {
    const tooBig = await get('/chain/activity?limit=1001');
    expect(tooBig.status).toBe(400);
    const zero = await get('/chain/activity?limit=0');
    expect(zero.status).toBe(400);
  });
});
