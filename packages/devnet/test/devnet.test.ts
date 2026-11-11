import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  REGISTRATION_DEPOSIT_YOCTO,
  MIN_PRICE_YOCTO,
  base58Decode,
  isNearTxHash,
  loadConfig,
  nearToYocto,
} from '@agentgate/shared';
import type { Logger } from '@agentgate/shared';
import {
  ACTIVITY_CAP,
  MAX_ATTESTATIONS,
  MAX_PAYMENTS,
  MAX_SERVICES,
  deriveDevnetKey,
  startServer,
} from '../src/index';
import type { RunningServer } from '../src/index';
import { DevnetState } from '../src/state';
import { rustTrim } from '../src/trim';

const REGISTRY = 'registry.mock';
const OWNER = 'owner.mock';
const ATTESTOR = 'attestor.mock';
const BUYER = 'buyer.mock';
const STRANGER = 'stranger.mock';
const TARGET = 'seller.mock';

const GATEWAY = 'http://localhost:4021';
const PRICE = nearToYocto('0.5');
const FEE = PAYMENT_STORAGE_FEE_YOCTO;
const REG_DEPOSIT = REGISTRATION_DEPOSIT_YOCTO;
const NEAR = (n: string): string => nearToYocto(n);

let server: RunningServer;
let base: string;
let nonceCounter = 1_000;

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

/** A nonce no earlier test used. */
function freshNonce(): string {
  nonceCounter += 1;
  return String(nonceCounter);
}

async function fund(accountId: string, amountYocto = NEAR('1000')): Promise<HttpResult> {
  return post('/faucet', { accountId, amountYocto });
}

async function balanceOf(accountId: string): Promise<bigint> {
  const res = await get(`/accounts/${accountId}/balance`);
  expect(res.status).toBe(200);
  return BigInt(res.body.balanceYocto);
}

function registerInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Gold Spot Feed',
    description: 'XAU/USD spot price with confidence score',
    gatewayBaseUrl: GATEWAY,
    priceYocto: PRICE,
    paymentTarget: TARGET,
    attestor: ATTESTOR,
    ...overrides,
  };
}

async function register(
  input: Record<string, unknown> = {},
  opts: { signer?: string; depositYocto?: string } = {},
): Promise<HttpResult> {
  return post('/registry/register', {
    signer: opts.signer ?? OWNER,
    input: registerInput(input),
    depositYocto: opts.depositYocto ?? REG_DEPOSIT,
  });
}

async function newService(input: Record<string, unknown> = {}): Promise<number> {
  const res = await register(input);
  expect(res.status).toBe(200);
  return res.body.serviceId as number;
}

async function pay(
  serviceId: number,
  nonce: string,
  opts: { signer?: string; depositYocto?: string } = {},
): Promise<HttpResult> {
  return post('/registry/pay', {
    signer: opts.signer ?? BUYER,
    serviceId,
    nonce,
    depositYocto: opts.depositYocto ?? (BigInt(PRICE) + BigInt(FEE)).toString(),
  });
}

async function attest(
  serviceId: number,
  nonce: string,
  opts: { signer?: string; paymentTxHash?: string; success?: boolean } = {},
): Promise<HttpResult> {
  return post('/registry/attest', {
    signer: opts.signer ?? ATTESTOR,
    serviceId,
    nonce,
    paymentTxHash: opts.paymentTxHash ?? 'h'.repeat(44),
    success: opts.success ?? true,
  });
}

async function setActive(serviceId: number, active: boolean, signer = OWNER): Promise<HttpResult> {
  return post('/registry/active', { signer, serviceId, active });
}

/** The contract answers with a 400 and a stable `ERR_*` code plus human text. */
function expectErr(res: HttpResult, code: string): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.error).toBe(code);
  expect(typeof res.body.message).toBe('string');
  expect(res.body.message.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  await fund(OWNER);
  await fund(BUYER);
  await fund(ATTESTOR);
  await fund(STRANGER);
});

afterAll(async () => {
  await server.close();
});

describe('live-mode fail-closed', () => {
  it('refuses to boot when config.mode === "live" (the mock chain must never run live)', async () => {
    const liveConfig = loadConfig({
      AGENTGATE_MODE: 'live',
      AGENTGATE_ADMIN_TOKEN: 'a-strong-unique-admin-token',
    });
    expect(liveConfig.mode).toBe('live');

    await expect(startServer({ port: 0, config: liveConfig })).rejects.toMatchObject({
      code: 'DEVNET_LIVE_REFUSED',
      httpStatus: 500,
    });
    await expect(startServer({ port: 0, config: liveConfig })).rejects.toBeInstanceOf(AgentGateError);
  });
});

describe('devnet basics', () => {
  it('serves /healthz with the near-mock network id', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, network: 'near-mock' });
  });

  it('faucets and reads balances (yocto strings, never numbers)', async () => {
    const accountId = 'faucet-test.mock';
    const res = await fund(accountId, '1000000000000000000000000');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId, balanceYocto: '1000000000000000000000000' });

    // a second faucet call adds to the balance
    const again = await fund(accountId, '5');
    expect(again.body.balanceYocto).toBe('1000000000000000000000005');

    const balance = await get(`/accounts/${accountId}/balance`);
    expect(balance.status).toBe(200);
    expect(balance.body).toEqual({ accountId, balanceYocto: '1000000000000000000000005' });
  });

  it('returns 0 balance for unknown accounts and 404s on unknown routes', async () => {
    const balance = await get('/accounts/never-funded.mock/balance');
    expect(balance.body.balanceYocto).toBe('0');

    const missing = await get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('no longer serves the transfer-based /chain/* routes', async () => {
    expect((await get('/chain/services')).status).toBe(404);
    expect((await get('/chain/balance/buyer.mock')).status).toBe(404);
    expect((await post('/chain/transfers', {})).status).toBe(404);
    expect((await post('/chain/register-service', {})).status).toBe(404);
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

  it('answers framework 4xx errors with their own status and logs nothing as an error', async () => {
    const errors: string[] = [];
    const spy: Logger = {
      name: 'spy',
      level: 'error',
      debug() {},
      info() {},
      warn() {},
      error: (msg) => {
        errors.push(msg);
      },
      child: () => spy,
    };
    const quiet = await startServer({ port: 0, logger: spy });
    try {
      const url = `http://127.0.0.1:${quiet.port}`;

      // body-parser: over the 256kb limit -> 413
      const tooBig = await fetch(`${url}/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'big.mock', amountYocto: '1', pad: 'x'.repeat(300_000) }),
      });
      expect(tooBig.status).toBe(413);
      const tooBigBody: any = await tooBig.json();
      expect(tooBigBody.error).toBe('invalid_request');
      expect(typeof tooBigBody.message).toBe('string');

      // the router: a malformed percent-escape in a path parameter -> 400
      for (const path of [
        '/accounts/%E0%A4%A/balance',
        '/accounts/x.mock/keys/%E0%A4%A',
        '/registry/payments/%E0%A4%A',
        '/registry/services/%E0%A4%A',
      ]) {
        const res = await fetch(`${url}${path}`);
        expect(res.status, path).toBe(400);
        expect(((await res.json()) as any).error, path).toBe('invalid_request');
      }
      expect(errors).toEqual([]);
    } finally {
      await quiet.close();
    }
  });

  it('rejects bad faucet requests: float amounts, a missing account id, amounts above u128', async () => {
    expect((await post('/faucet', { accountId: 'x.mock', amountYocto: '1.5' })).status).toBe(400);
    expect((await post('/faucet', { accountId: 'x.mock', amountYocto: 7 })).status).toBe(400);
    expect((await post('/faucet', { amountYocto: '1' })).status).toBe(400);
    const tooBig = (2n ** 128n).toString();
    expect((await post('/faucet', { accountId: 'x.mock', amountYocto: tooBig })).status).toBe(400);
  });

  it('validates every account id it receives with ERR_INVALID_ACCOUNT_ID', async () => {
    expectErr(await fund('Not Valid'), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await fund('UPPER.mock'), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await fund('a'), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await get('/accounts/Not%20Valid/balance'), 'ERR_INVALID_ACCOUNT_ID');

    // signer, paymentTarget and attestor on register
    expectErr(await register({}, { signer: 'Bad Signer' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await register({ paymentTarget: 'Bad Target' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await register({ attestor: 'Bad Attestor' }), 'ERR_INVALID_ACCOUNT_ID');

    // signer on every other write
    const serviceId = await newService();
    expectErr(await pay(serviceId, freshNonce(), { signer: 'Bad Payer' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await attest(serviceId, freshNonce(), { signer: 'Bad Attestor' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await setActive(serviceId, false, 'Bad Owner'), 'ERR_INVALID_ACCOUNT_ID');
  });
});

describe('account ids the devnet receives (ERR_INVALID_ACCOUNT_ID)', () => {
  it('treats an empty string like any other malformed account id', async () => {
    expectErr(await fund(''), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await register({}, { signer: '' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await register({ paymentTarget: '' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await register({ attestor: '' }), 'ERR_INVALID_ACCOUNT_ID');
    const serviceId = await newService();
    expectErr(await pay(serviceId, freshNonce(), { signer: '' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await attest(serviceId, freshNonce(), { signer: '' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await setActive(serviceId, false, ''), 'ERR_INVALID_ACCOUNT_ID');
  });

  it('checks the signer\'s own id, then its balance, then the argument ids, then the contract rules', async () => {
    // a malformed signer is rejected even when the attached deposit is huge
    expectErr(
      await register({ name: ' ', paymentTarget: 'Bad Target' }, { signer: 'Bad Signer', depositYocto: NEAR('999999999') }),
      'ERR_INVALID_ACCOUNT_ID',
    );
    // an unfunded signer with a malformed paymentTarget or attestor is told about its balance first
    const unfunded = 'unfunded-registrant.mock';
    expectErr(await register({ paymentTarget: 'Bad Target' }, { signer: unfunded }), 'ERR_INSUFFICIENT_BALANCE');
    expectErr(await register({ attestor: 'Bad Attestor' }, { signer: unfunded }), 'ERR_INSUFFICIENT_BALANCE');
    // once it can cover the deposit, the malformed argument id is what fails, ahead of the contract rules
    expectErr(
      await register({ name: ' ', paymentTarget: 'Bad Target' }),
      'ERR_INVALID_ACCOUNT_ID',
    );
    expectErr(await register({ name: ' ' }), 'ERR_EMPTY_NAME');
  });
});

describe('devnet keys: one deterministic full-access ed25519 key per account', () => {
  it('derives the key pair from sha256("neargate-devnet-key/v1:" + accountId)', () => {
    const accountId = 'derive-me.mock';
    const key = deriveDevnetKey(accountId);
    const seed = createHash('sha256').update(`neargate-devnet-key/v1:${accountId}`).digest();

    expect(key.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(key.secretKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    const pub = base58Decode(key.publicKey.slice('ed25519:'.length));
    const secret = base58Decode(key.secretKey.slice('ed25519:'.length));
    expect(pub).toHaveLength(32);
    expect(secret).toHaveLength(64); // near-cli format: seed || public key
    expect(Buffer.from(secret.subarray(0, 32)).equals(seed)).toBe(true);
    expect(Buffer.from(secret.subarray(32)).equals(Buffer.from(pub))).toBe(true);

    // deterministic, and different per account
    expect(deriveDevnetKey(accountId)).toEqual(key);
    expect(deriveDevnetKey('someone-else.mock').publicKey).not.toBe(key.publicKey);
  });

  it('is a working ed25519 pair: a signature from the secret key verifies under the public key', () => {
    const key = deriveDevnetKey('signer.mock');
    const secret = Buffer.from(base58Decode(key.secretKey.slice('ed25519:'.length)));
    const pub = Buffer.from(base58Decode(key.publicKey.slice('ed25519:'.length)));
    const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const privateKey = createPrivateKey({
      key: Buffer.concat([pkcs8Prefix, secret.subarray(0, 32)]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, pub]), format: 'der', type: 'spki' });
    const message = Buffer.from('NearGate/self-map/v1\nnear-mock\n1');
    expect(verify(null, message, publicKey, sign(null, message, privateKey))).toBe(true);
    expect(verify(null, Buffer.from('tampered'), publicKey, sign(null, message, privateKey))).toBe(false);
  });

  it('the faucet returns the derived key of the funded account', async () => {
    const accountId = 'keyed.mock';
    const res = await fund(accountId);
    expect(res.status).toBe(200);
    const key = deriveDevnetKey(accountId);
    expect(res.body.publicKey).toBe(key.publicKey);
    expect(res.body.secretKey).toBe(key.secretKey);
  });

  it('GET /accounts/:id/keys/:publicKey is fullAccess only for the known account and its derived key', async () => {
    const accountId = 'keyed.mock';
    await fund(accountId);
    const mine = deriveDevnetKey(accountId).publicKey;
    const other = deriveDevnetKey('keyed-other.mock').publicKey;
    const keyPath = (id: string, publicKey: string): string =>
      `/accounts/${id}/keys/${encodeURIComponent(publicKey)}`;

    expect((await get(keyPath(accountId, mine))).body).toEqual({ fullAccess: true });
    expect((await get(keyPath(accountId, other))).body).toEqual({ fullAccess: false });
    expect((await get(keyPath(accountId, 'ed25519:notakey'))).body).toEqual({ fullAccess: false });
    expect((await get(keyPath(accountId, 'garbage'))).body).toEqual({ fullAccess: false });
    // a malformed account id is a malformed argument, as on the balance route
    expectErr(await get(keyPath('Bad Id', mine)), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await get(keyPath('UPPER.mock', mine)), 'ERR_INVALID_ACCOUNT_ID');
    // an account the devnet has never seen has no keys, even with its own derived key
    const stranger = 'never-seen.mock';
    expect((await get(keyPath(stranger, deriveDevnetKey(stranger).publicKey))).body).toEqual({
      fullAccess: false,
    });
    // ... until the faucet creates it
    await fund(stranger, '1');
    expect((await get(keyPath(stranger, deriveDevnetKey(stranger).publicKey))).body).toEqual({
      fullAccess: true,
    });
  });
});

describe('GET /accounts/:id: an account exists iff it has a balance record', () => {
  it('answers {accountId, exists} — false until the faucet creates the account', async () => {
    const accountId = 'exists-check.mock';
    expect(await get(`/accounts/${accountId}`)).toEqual({ status: 200, body: { accountId, exists: false } });
    await fund(accountId, '1');
    expect(await get(`/accounts/${accountId}`)).toEqual({ status: 200, body: { accountId, exists: true } });
    // the balance route does not create the account
    expect((await get('/accounts/read-only.mock/balance')).body.balanceYocto).toBe('0');
    expect((await get('/accounts/read-only.mock')).body).toEqual({ accountId: 'read-only.mock', exists: false });
  });

  it('an account that only ever received a payment exists', async () => {
    const target = 'paid-target.mock';
    expect((await get(`/accounts/${target}`)).body.exists).toBe(false);
    const serviceId = await newService({ paymentTarget: target, name: 'exists via payment' });
    expect((await pay(serviceId, freshNonce())).status).toBe(200);
    expect((await get(`/accounts/${target}`)).body).toEqual({ accountId: target, exists: true });
  });

  it('rejects a malformed account id with ERR_INVALID_ACCOUNT_ID', async () => {
    expectErr(await get('/accounts/Not%20Valid'), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await get('/accounts/UPPER.mock'), 'ERR_INVALID_ACCOUNT_ID');
  });

  it('DevnetState.accountExists mirrors the route', () => {
    const state = new DevnetState();
    expect(state.accountExists('fresh.mock')).toBe(false);
    state.faucet('fresh.mock', '1');
    expect(state.accountExists('fresh.mock')).toBe(true);
    let thrown: unknown;
    try {
      state.accountExists('Bad Id');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ERR_INVALID_ACCOUNT_ID' });
  });
});

describe('register_service', () => {
  it('registers a service: id, 44-char base58 tx hash, computed endpointUrl, one native option', async () => {
    const res = await register({ gatewayBaseUrl: `${GATEWAY}/` }); // trailing slash stripped on read
    expect(res.status).toBe(200);
    expect(res.body.serviceId).toBeGreaterThanOrEqual(1);
    expect(res.body.txHash).toHaveLength(44);
    expect(isNearTxHash(res.body.txHash)).toBe(true);
    const serviceId = res.body.serviceId as number;

    const record = await get(`/registry/services/${serviceId}`);
    expect(record.status).toBe(200);
    expect(record.body).toMatchObject({
      id: serviceId,
      name: 'Gold Spot Feed',
      description: 'XAU/USD spot price with confidence score',
      endpointUrl: `${GATEWAY}/svc/${serviceId}`,
      priceYocto: PRICE,
      paymentTarget: TARGET,
      owner: OWNER,
      attestor: ATTESTOR,
      active: true,
      accepts: [{ asset: 'near', amount: PRICE, decimals: 24, symbol: 'NEAR' }],
    });
    expect(typeof record.body.createdAt).toBe('number');

    const list = await get('/registry/services');
    expect(list.status).toBe(200);
    expect(list.body.some((s: any) => s.id === serviceId)).toBe(true);
    // ids ascend, 1-based
    const ids = list.body.map((s: any) => s.id);
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual(ids);
    expect(ids[0]).toBe(1);
  });

  it('keeps exactly the registration deposit and refunds the excess', async () => {
    const owner = 'depositor.mock';
    await fund(owner, NEAR('5'));
    const registryBefore = await balanceOf(REGISTRY);

    const res = await register({}, { signer: owner, depositYocto: NEAR('1') });
    expect(res.status).toBe(200);

    expect(await balanceOf(owner)).toBe(BigInt(NEAR('5')) - BigInt(REG_DEPOSIT));
    expect((await balanceOf(REGISTRY)) - registryBefore).toBe(BigInt(REG_DEPOSIT));
  });

  it('trims the name before storing it', async () => {
    const id = await newService({ name: '  Padded Name \n' });
    expect((await get(`/registry/services/${id}`)).body.name).toBe('Padded Name');
  });

  it('trims like Rust str::trim: Unicode White_Space only, so U+0085 goes and U+FEFF stays', async () => {
    // every White_Space character, front and back
    const whiteSpace = '\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
    const padded = await register({ name: `${whiteSpace}Spaced${whiteSpace}` });
    expect(padded.status).toBe(200);
    expect((await get(`/registry/services/${padded.body.serviceId}`)).body.name).toBe('Spaced');

    // U+0085 alone is blank to Rust (but not to JS trim)
    expectErr(await register({ name: '\u0085' }), 'ERR_EMPTY_NAME');
    expectErr(await register({ name: '\u0085\u2028 \u3000' }), 'ERR_EMPTY_NAME');

    // U+FEFF and U+200B are not White_Space in Rust: a name made of them is not blank, and is kept
    for (const name of ['\ufeff', '\u200b', '\ufeffName']) {
      const kept = await register({ name });
      expect(kept.status, JSON.stringify(name)).toBe(200);
      expect((await get(`/registry/services/${kept.body.serviceId}`)).body.name).toBe(name);
    }

    // the byte limit applies to the trimmed name
    expect((await register({ name: `${'\u3000'.repeat(20)}${'n'.repeat(64)}` })).status).toBe(200);
  });

  it('ERR_EMPTY_NAME for a blank name', async () => {
    expectErr(await register({ name: '   ' }), 'ERR_EMPTY_NAME');
    expectErr(await register({ name: '' }), 'ERR_EMPTY_NAME');
  });

  it('counts field limits in UTF-8 bytes, not characters (ERR_FIELD_TOO_LONG)', async () => {
    expect((await register({ name: 'n'.repeat(64) })).status).toBe(200);
    expectErr(await register({ name: 'n'.repeat(65) }), 'ERR_FIELD_TOO_LONG');
    // 16 four-byte characters are 64 bytes; 17 are 68 bytes but only 17 characters
    expect((await register({ name: '😀'.repeat(16) })).status).toBe(200);
    expectErr(await register({ name: '😀'.repeat(17) }), 'ERR_FIELD_TOO_LONG');

    expect((await register({ description: 'd'.repeat(280) })).status).toBe(200);
    expectErr(await register({ description: 'd'.repeat(281) }), 'ERR_FIELD_TOO_LONG');
    expectErr(await register({ description: 'é'.repeat(141) }), 'ERR_FIELD_TOO_LONG'); // 282 bytes

    const url = (n: number): string => `http://example.com/${'p'.repeat(n - 'http://example.com/'.length)}`;
    expect((await register({ gatewayBaseUrl: url(200) })).status).toBe(200);
    expectErr(await register({ gatewayBaseUrl: url(201) }), 'ERR_FIELD_TOO_LONG');
  });

  it('ERR_INVALID_PRICE below the native floor, accepted at exactly the floor', async () => {
    const below = (BigInt(MIN_PRICE_YOCTO) - 1n).toString();
    expectErr(await register({ priceYocto: below }), 'ERR_INVALID_PRICE');
    expectErr(await register({ priceYocto: '0' }), 'ERR_INVALID_PRICE');
    const floor = await register({ priceYocto: MIN_PRICE_YOCTO });
    expect(floor.status).toBe(200);
    expect((await get(`/registry/services/${floor.body.serviceId}`)).body.priceYocto).toBe(MIN_PRICE_YOCTO);
  });

  it('ERR_DEPOSIT_TOO_LOW below the registration deposit, accepted at exactly the deposit', async () => {
    const short = (BigInt(REG_DEPOSIT) - 1n).toString();
    const res = await register({}, { depositYocto: short });
    expectErr(res, 'ERR_DEPOSIT_TOO_LOW');
    expect(res.body.message).toContain(REG_DEPOSIT);
    expect((await register({}, { depositYocto: REG_DEPOSIT })).status).toBe(200);
  });

  it('checks in the contract order: name, lengths, price, deposit', async () => {
    const lowPrice = '1';
    const lowDeposit = '1';
    expectErr(
      await register({ name: ' ', description: 'd'.repeat(281), priceYocto: lowPrice }, { depositYocto: lowDeposit }),
      'ERR_EMPTY_NAME',
    );
    expectErr(
      await register({ description: 'd'.repeat(281), priceYocto: lowPrice }, { depositYocto: lowDeposit }),
      'ERR_FIELD_TOO_LONG',
    );
    expectErr(await register({ priceYocto: lowPrice }, { depositYocto: lowDeposit }), 'ERR_INVALID_PRICE');
    expectErr(await register({}, { depositYocto: lowDeposit }), 'ERR_DEPOSIT_TOO_LOW');
  });

  it('ERR_INSUFFICIENT_BALANCE (mock-only) when the signer cannot cover the attached deposit, before any contract check', async () => {
    const broke = 'broke-owner.mock';
    await fund(broke, '1000');
    // the contract would answer ERR_EMPTY_NAME, but the transaction never reaches it
    expectErr(await register({ name: ' ' }, { signer: broke }), 'ERR_INSUFFICIENT_BALANCE');
    expectErr(await register({}, { signer: 'unfunded-owner.mock' }), 'ERR_INSUFFICIENT_BALANCE');
    // nothing moved
    expect(await balanceOf(broke)).toBe(1000n);
  });

  it('a rejected registration changes no balance and takes no service id', async () => {
    const before = (await get('/registry/services')).body.length;
    const ownerBefore = await balanceOf(OWNER);
    const registryBefore = await balanceOf(REGISTRY);
    expectErr(await register({ priceYocto: '1' }), 'ERR_INVALID_PRICE');
    expect(await balanceOf(OWNER)).toBe(ownerBefore);
    expect(await balanceOf(REGISTRY)).toBe(registryBefore);
    expect((await get('/registry/services')).body).toHaveLength(before);
  });

  it('400s malformed request shapes', async () => {
    expect((await post('/registry/register', { signer: OWNER, depositYocto: REG_DEPOSIT })).status).toBe(400);
    expect((await post('/registry/register', { input: registerInput(), depositYocto: REG_DEPOSIT })).status).toBe(400);
    expect((await register({ priceYocto: '1.5' })).status).toBe(400);
    expect((await register({ priceYocto: 500 })).status).toBe(400);
    expect((await register({ name: 7 })).status).toBe(400);
    expect((await post('/registry/register', { signer: OWNER, input: registerInput() })).status).toBe(400);
    expect((await register({}, { depositYocto: '-1' })).status).toBe(400);
  });
});

describe('pay: the registry forwards exactly the price, keeps the fee and refunds the excess', () => {
  it('moves the price to the seller, the fee to the registry and refunds the excess', async () => {
    const target = 'payout-a.mock';
    const buyer = 'payer-a.mock';
    await fund(buyer, NEAR('10'));
    const serviceId = await newService({ paymentTarget: target });
    const registryBefore = await balanceOf(REGISTRY);

    // attach 1 NEAR for a 0.5 NEAR service: 0.5 + 0.002 is used, the rest comes back
    const res = await pay(serviceId, freshNonce(), { signer: buyer, depositYocto: NEAR('1') });
    expect(res.status).toBe(200);
    expect(res.body.txHash).toHaveLength(44);
    expect(isNearTxHash(res.body.txHash)).toBe(true);

    expect(await balanceOf(buyer)).toBe(BigInt(NEAR('10')) - BigInt(PRICE) - BigInt(FEE));
    expect(await balanceOf(target)).toBe(BigInt(PRICE));
    expect((await balanceOf(REGISTRY)) - registryBefore).toBe(BigInt(FEE));
  });

  it('settles an exact price + fee deposit with nothing to refund', async () => {
    const target = 'payout-b.mock';
    const buyer = 'payer-b.mock';
    await fund(buyer, NEAR('2'));
    const serviceId = await newService({ paymentTarget: target });
    const exact = (BigInt(PRICE) + BigInt(FEE)).toString();
    expect((await pay(serviceId, freshNonce(), { signer: buyer, depositYocto: exact })).status).toBe(200);
    expect(await balanceOf(buyer)).toBe(BigInt(NEAR('2')) - BigInt(exact));
    expect(await balanceOf(target)).toBe(BigInt(PRICE));
  });

  it('stores the payment record, readable by nonce', async () => {
    const serviceId = await newService();
    const nonce = freshNonce();
    await pay(serviceId, nonce);

    const res = await get(`/registry/payments/${nonce}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      nonce,
      serviceId,
      payer: BUYER,
      amountYocto: PRICE, // the price the target received, not the deposit
      selfPaid: false,
      attested: false,
    });
    expect(typeof res.body.timestamp).toBe('number');
    expect(typeof res.body.blockHeight).toBe('number');

    expect((await get(`/registry/payments/${freshNonce()}`)).status).toBe(404);
  });

  it('ERR_NONCE_USED on reuse, across services too, and the retry moves no money', async () => {
    const serviceA = await newService();
    const serviceB = await newService();
    const nonce = freshNonce();
    expect((await pay(serviceA, nonce)).status).toBe(200);

    const buyerBefore = await balanceOf(BUYER);
    expectErr(await pay(serviceA, nonce), 'ERR_NONCE_USED');
    expectErr(await pay(serviceB, nonce), 'ERR_NONCE_USED');
    expect(await balanceOf(BUYER)).toBe(buyerBefore);
  });

  it('ERR_INVALID_NONCE unless 1 to 20 decimal digits', async () => {
    const serviceId = await newService();
    for (const bad of ['', 'abc', '1.5', '-1', ' 7', '1'.repeat(21), '١٢٣']) {
      expectErr(await pay(serviceId, bad), 'ERR_INVALID_NONCE');
    }
    expect((await pay(serviceId, '9'.repeat(20))).status).toBe(200);
    expect((await pay(serviceId, '0')).status).toBe(200);
  });

  it('ERR_DEPOSIT_TOO_LOW below price + fee, naming the required amount', async () => {
    const serviceId = await newService();
    const required = (BigInt(PRICE) + BigInt(FEE)).toString();
    const res = await pay(serviceId, freshNonce(), { depositYocto: (BigInt(required) - 1n).toString() });
    expectErr(res, 'ERR_DEPOSIT_TOO_LOW');
    expect(res.body.message).toContain(required);
    expectErr(await pay(serviceId, freshNonce(), { depositYocto: PRICE }), 'ERR_DEPOSIT_TOO_LOW'); // price without the fee
    expectErr(await pay(serviceId, freshNonce(), { depositYocto: '0' }), 'ERR_DEPOSIT_TOO_LOW');
  });

  it('ERR_SERVICE_NOT_FOUND and ERR_SERVICE_INACTIVE, ahead of the deposit and nonce checks', async () => {
    expectErr(await pay(999_999, freshNonce()), 'ERR_SERVICE_NOT_FOUND');
    expectErr(await pay(0, freshNonce()), 'ERR_SERVICE_NOT_FOUND');
    expectErr(await pay(999_999, 'bad nonce', { depositYocto: '0' }), 'ERR_SERVICE_NOT_FOUND');

    const serviceId = await newService();
    expect((await setActive(serviceId, false)).status).toBe(200);
    expectErr(await pay(serviceId, 'bad nonce', { depositYocto: '0' }), 'ERR_SERVICE_INACTIVE');
    expect((await setActive(serviceId, true)).status).toBe(200);
    expect((await pay(serviceId, freshNonce())).status).toBe(200);
  });

  it('checks deposit before nonce shape, and nonce shape before reuse', async () => {
    const serviceId = await newService();
    expectErr(await pay(serviceId, 'bad nonce', { depositYocto: '0' }), 'ERR_DEPOSIT_TOO_LOW');
    expectErr(await pay(serviceId, 'bad nonce'), 'ERR_INVALID_NONCE');
  });

  it('ERR_INSUFFICIENT_BALANCE (mock-only) when the payer cannot fund the attached deposit; the nonce stays free', async () => {
    const serviceId = await newService();
    const poor = 'poor-payer.mock';
    await fund(poor, NEAR('0.1'));
    const nonce = freshNonce();
    expectErr(await pay(serviceId, nonce, { signer: poor }), 'ERR_INSUFFICIENT_BALANCE');
    expectErr(await pay(serviceId, nonce, { signer: 'never-funded.mock' }), 'ERR_INSUFFICIENT_BALANCE');
    // the whole attached deposit must be covered, even the part that would be refunded
    expectErr(
      await pay(serviceId, nonce, { signer: BUYER, depositYocto: NEAR('999999999') }),
      'ERR_INSUFFICIENT_BALANCE',
    );
    expect(await balanceOf(poor)).toBe(BigInt(NEAR('0.1')));

    expect((await pay(serviceId, nonce)).status).toBe(200); // not burned by the failures
    expect((await get(`/registry/payments/${nonce}`)).body.payer).toBe(BUYER);
  });

  it('marks owner and payment-target payments selfPaid', async () => {
    const target = 'self-target.mock';
    await fund(target, NEAR('10'));
    const serviceId = await newService({ paymentTarget: target });

    const byOwner = freshNonce();
    expect((await pay(serviceId, byOwner, { signer: OWNER })).status).toBe(200);
    expect((await get(`/registry/payments/${byOwner}`)).body).toMatchObject({ payer: OWNER, selfPaid: true });

    const byTarget = freshNonce();
    const targetBefore = await balanceOf(target);
    expect((await pay(serviceId, byTarget, { signer: target })).status).toBe(200);
    expect((await get(`/registry/payments/${byTarget}`)).body).toMatchObject({ payer: target, selfPaid: true });
    // paying yourself costs only the storage fee: the price comes straight back
    expect(await balanceOf(target)).toBe(targetBefore - BigInt(FEE));

    const byBuyer = freshNonce();
    await pay(serviceId, byBuyer);
    expect((await get(`/registry/payments/${byBuyer}`)).body.selfPaid).toBe(false);
  });

  it('400s malformed request shapes', async () => {
    const serviceId = await newService();
    const ok = { signer: BUYER, serviceId, nonce: freshNonce(), depositYocto: NEAR('1') };
    expect((await post('/registry/pay', { ...ok, serviceId: '1' })).status).toBe(400);
    expect((await post('/registry/pay', { ...ok, serviceId: 1.5 })).status).toBe(400);
    expect((await post('/registry/pay', { ...ok, serviceId: -1 })).status).toBe(400);
    expect((await post('/registry/pay', { ...ok, nonce: 42 })).status).toBe(400);
    expect((await post('/registry/pay', { ...ok, depositYocto: '1.5' })).status).toBe(400);
    expect((await post('/registry/pay', { ...ok, depositYocto: 1000 })).status).toBe(400);
    expect((await post('/registry/pay', { signer: BUYER, serviceId })).status).toBe(400);
    expect((await post('/registry/pay', [])).status).toBe(400);
  });
});

describe('record_attestation', () => {
  it('accepts the attestor and the owner, bumps the score, lists newest first and marks the payment attested', async () => {
    const serviceId = await newService();
    const n1 = freshNonce();
    const n2 = freshNonce();
    const hash1 = (await pay(serviceId, n1)).body.txHash as string;
    const hash2 = (await pay(serviceId, n2)).body.txHash as string;

    const first = await attest(serviceId, n1, { signer: ATTESTOR, paymentTxHash: hash1, success: true });
    expect(first.status).toBe(200);
    expect(isNearTxHash(first.body.txHash)).toBe(true);
    expect((await get(`/registry/services/${serviceId}/score`)).body).toEqual({ totalCalls: 1, successCalls: 1 });

    const second = await attest(serviceId, n2, { signer: OWNER, paymentTxHash: hash2, success: false });
    expect(second.status).toBe(200);
    expect((await get(`/registry/services/${serviceId}/score`)).body).toEqual({ totalCalls: 2, successCalls: 1 });

    const list = await get(`/registry/services/${serviceId}/attestations`);
    expect(list.body).toHaveLength(2);
    expect(list.body[0]).toMatchObject({ serviceId, nonce: n2, paymentTxHash: hash2, success: false });
    expect(list.body[1]).toMatchObject({ serviceId, nonce: n1, paymentTxHash: hash1, success: true });
    expect(typeof list.body[0].timestamp).toBe('number');
    expect((await get(`/registry/services/${serviceId}/attestations?limit=1`)).body).toHaveLength(1);

    expect((await get(`/registry/payments/${n1}`)).body.attested).toBe(true);
    expect((await get(`/registry/payments/${n2}`)).body.attested).toBe(true);
  });

  it('keeps at most 100 attestations per service, newest first, but scores every one', async () => {
    const serviceId = await newService({ priceYocto: MIN_PRICE_YOCTO });
    const total = MAX_ATTESTATIONS + 5;
    const nonces: string[] = [];
    const depositYocto = (BigInt(MIN_PRICE_YOCTO) + BigInt(FEE)).toString();
    for (let i = 0; i < total; i += 1) {
      const nonce = freshNonce();
      nonces.push(nonce);
      expect((await pay(serviceId, nonce, { depositYocto })).status).toBe(200);
      expect((await attest(serviceId, nonce, { success: i % 2 === 0 })).status).toBe(200);
    }

    const list = await get(`/registry/services/${serviceId}/attestations?limit=1000`);
    expect(list.body).toHaveLength(MAX_ATTESTATIONS);
    expect(list.body[0].nonce).toBe(nonces[total - 1]); // newest first
    expect(list.body[MAX_ATTESTATIONS - 1].nonce).toBe(nonces[total - MAX_ATTESTATIONS]);
    expect(list.body.some((a: any) => a.nonce === nonces[0])).toBe(false); // oldest dropped
    // the default (no limit) is also the full capped list
    expect((await get(`/registry/services/${serviceId}/attestations`)).body).toHaveLength(MAX_ATTESTATIONS);

    const score = (await get(`/registry/services/${serviceId}/score`)).body;
    expect(score).toEqual({ totalCalls: total, successCalls: Math.ceil(total / 2) });
  }, 60_000);

  it('ERR_ALREADY_ATTESTED for a second attestation of the same payment; the score stays', async () => {
    const serviceId = await newService();
    const nonce = freshNonce();
    await pay(serviceId, nonce);
    expect((await attest(serviceId, nonce)).status).toBe(200);
    expectErr(await attest(serviceId, nonce, { success: false }), 'ERR_ALREADY_ATTESTED');
    expectErr(await attest(serviceId, nonce, { signer: OWNER }), 'ERR_ALREADY_ATTESTED');
    expect((await get(`/registry/services/${serviceId}/score`)).body).toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('ERR_SELF_PAYMENT for a payment by the owner or the payment target', async () => {
    const target = 'self-attest-target.mock';
    await fund(target, NEAR('10'));
    const serviceId = await newService({ paymentTarget: target });

    const byOwner = freshNonce();
    await pay(serviceId, byOwner, { signer: OWNER });
    expectErr(await attest(serviceId, byOwner), 'ERR_SELF_PAYMENT');
    expectErr(await attest(serviceId, byOwner, { signer: OWNER }), 'ERR_SELF_PAYMENT');

    const byTarget = freshNonce();
    await pay(serviceId, byTarget, { signer: target });
    expectErr(await attest(serviceId, byTarget), 'ERR_SELF_PAYMENT');

    expect((await get(`/registry/services/${serviceId}/score`)).body).toEqual({ totalCalls: 0, successCalls: 0 });
    expect((await get(`/registry/payments/${byOwner}`)).body.attested).toBe(false);
  });

  it('ERR_NOT_AUTHORIZED for anyone but the attestor and the owner', async () => {
    const serviceId = await newService();
    const nonce = freshNonce();
    await pay(serviceId, nonce);
    expectErr(await attest(serviceId, nonce, { signer: STRANGER }), 'ERR_NOT_AUTHORIZED');
    expectErr(await attest(serviceId, nonce, { signer: BUYER }), 'ERR_NOT_AUTHORIZED');
    expectErr(await attest(serviceId, nonce, { signer: TARGET }), 'ERR_NOT_AUTHORIZED');
  });

  it('ERR_SERVICE_NOT_FOUND for unknown services', async () => {
    expectErr(await attest(999_999, freshNonce()), 'ERR_SERVICE_NOT_FOUND');
  });

  it('ERR_SERVICE_INACTIVE while the service is switched off', async () => {
    const serviceId = await newService();
    const nonce = freshNonce();
    await pay(serviceId, nonce);
    await setActive(serviceId, false);
    expectErr(await attest(serviceId, nonce), 'ERR_SERVICE_INACTIVE');
    await setActive(serviceId, true);
    expect((await attest(serviceId, nonce)).status).toBe(200);
  });

  it('ERR_PAYMENT_NOT_FOUND and ERR_PAYMENT_WRONG_SERVICE', async () => {
    const serviceA = await newService();
    const serviceB = await newService();
    const nonce = freshNonce();
    await pay(serviceA, nonce);

    expectErr(await attest(serviceA, freshNonce()), 'ERR_PAYMENT_NOT_FOUND');
    expectErr(await attest(serviceA, ''), 'ERR_PAYMENT_NOT_FOUND'); // no nonce format check here
    expectErr(await attest(serviceA, 'not a nonce'), 'ERR_PAYMENT_NOT_FOUND');
    expectErr(await attest(serviceB, nonce), 'ERR_PAYMENT_WRONG_SERVICE');
    expect((await get(`/registry/payments/${nonce}`)).body.attested).toBe(false);
  });

  it('ERR_FIELD_TOO_LONG for a payment_tx_hash above 64 bytes (counted in bytes)', async () => {
    const serviceId = await newService();
    const nonce = freshNonce();
    await pay(serviceId, nonce);
    expectErr(await attest(serviceId, nonce, { paymentTxHash: 'h'.repeat(65) }), 'ERR_FIELD_TOO_LONG');
    expectErr(await attest(serviceId, nonce, { paymentTxHash: 'é'.repeat(33) }), 'ERR_FIELD_TOO_LONG'); // 66 bytes
    expect((await attest(serviceId, nonce, { paymentTxHash: 'h'.repeat(64) })).status).toBe(200);
  });

  it('checks in the contract order: service, auth, active, hash length, payment, service match, attested, self-payment', async () => {
    const serviceA = await newService();
    const serviceB = await newService();
    const unknown = freshNonce();
    const paid = freshNonce();
    const ownerPaid = freshNonce();
    await pay(serviceA, paid);
    await pay(serviceA, ownerPaid, { signer: OWNER });
    const longHash = 'h'.repeat(65);

    // a stranger on an inactive service: auth comes before the active check
    await setActive(serviceA, false);
    expectErr(await attest(serviceA, paid, { signer: STRANGER }), 'ERR_NOT_AUTHORIZED');
    // inactive comes before the hash length
    expectErr(await attest(serviceA, paid, { paymentTxHash: longHash }), 'ERR_SERVICE_INACTIVE');
    await setActive(serviceA, true);
    // hash length comes before the payment lookup
    expectErr(await attest(serviceA, unknown, { paymentTxHash: longHash }), 'ERR_FIELD_TOO_LONG');
    // wrong service comes before attested and self-payment
    expect((await attest(serviceA, paid)).status).toBe(200);
    expectErr(await attest(serviceB, paid), 'ERR_PAYMENT_WRONG_SERVICE');
    expectErr(await attest(serviceB, ownerPaid), 'ERR_PAYMENT_WRONG_SERVICE');
    // a payment is never both attested and self-paid, so each of these two is reached on its own
    expectErr(await attest(serviceA, paid), 'ERR_ALREADY_ATTESTED');
    expectErr(await attest(serviceA, ownerPaid), 'ERR_SELF_PAYMENT');
  });

  it('400s malformed request shapes', async () => {
    const serviceId = await newService();
    const ok = { signer: ATTESTOR, serviceId, nonce: '1', paymentTxHash: 'h', success: true };
    expect((await post('/registry/attest', { ...ok, success: 'yes' })).status).toBe(400);
    expect((await post('/registry/attest', { ...ok, serviceId: 'x' })).status).toBe(400);
    expect((await post('/registry/attest', { ...ok, nonce: 1 })).status).toBe(400);
    expect((await post('/registry/attest', { ...ok, paymentTxHash: undefined })).status).toBe(400);
  });
});

describe('set_active', () => {
  it('is owner-only and flips the flag', async () => {
    const serviceId = await newService();
    expectErr(await setActive(serviceId, false, STRANGER), 'ERR_NOT_AUTHORIZED');
    expectErr(await setActive(serviceId, false, ATTESTOR), 'ERR_NOT_AUTHORIZED');
    expect((await get(`/registry/services/${serviceId}`)).body.active).toBe(true);

    const off = await setActive(serviceId, false);
    expect(off.status).toBe(200);
    expect(isNearTxHash(off.body.txHash)).toBe(true);
    expect((await get(`/registry/services/${serviceId}`)).body.active).toBe(false);

    expect((await setActive(serviceId, false)).status).toBe(200); // idempotent
    expect((await setActive(serviceId, true)).status).toBe(200);
    expect((await get(`/registry/services/${serviceId}`)).body.active).toBe(true);
  });

  it('ERR_SERVICE_NOT_FOUND for unknown services, even for a non-owner', async () => {
    expectErr(await setActive(999_999, false), 'ERR_SERVICE_NOT_FOUND');
    expectErr(await setActive(999_999, false, STRANGER), 'ERR_SERVICE_NOT_FOUND');
  });

  it('400s a non-boolean flag', async () => {
    const serviceId = await newService();
    expect((await post('/registry/active', { signer: OWNER, serviceId, active: 'no' })).status).toBe(400);
  });
});

describe('reads', () => {
  it('serves defaults for unknown services like the contract views', async () => {
    expect((await get('/registry/services/999999')).status).toBe(404);
    expect((await get('/registry/services/999999/score')).body).toEqual({ totalCalls: 0, successCalls: 0 });
    expect((await get('/registry/services/999999/attestations')).body).toEqual([]);
  });

  it('400s a non-numeric service id and bad limits', async () => {
    expect((await get('/registry/services/abc')).status).toBe(400);
    expect((await get('/registry/services/0')).status).toBe(400);
    const serviceId = await newService();
    expect((await get(`/registry/services/${serviceId}/attestations?limit=0`)).status).toBe(400);
    expect((await get(`/registry/services/${serviceId}/attestations?limit=x`)).status).toBe(400);
  });
});

describe('activity feed', () => {
  it('lists the loop newest first, with mock tx hashes and strictly increasing block heights', async () => {
    const owner = 'activity-owner.mock';
    const buyer = 'activity-buyer.mock';
    await fund(owner);
    await fund(buyer);
    const reg = await register({}, { signer: owner });
    const serviceId = reg.body.serviceId as number;
    const nonce = freshNonce();
    const paid = await pay(serviceId, nonce, { signer: buyer });
    const attested = await attest(serviceId, nonce, { signer: owner, paymentTxHash: paid.body.txHash });

    const res = await get('/registry/activity?limit=50');
    expect(res.status).toBe(200);
    const mine = res.body.filter((e: any) => e.serviceId === serviceId);
    expect(mine.map((e: any) => e.kind)).toEqual(['attestation', 'payment', 'service_registered']);

    const [att, payment, registered] = mine;
    expect(registered).toMatchObject({ account: owner, txHash: reg.body.txHash });
    expect(registered.detail).toBe(`service #${serviceId} registered by ${owner}`);
    expect(payment).toMatchObject({ account: buyer, txHash: paid.body.txHash, amountYocto: PRICE, nonce });
    expect(payment.detail).toBe(`${buyer} paid 0.5 NEAR to service #${serviceId}`);
    expect(att).toMatchObject({ account: owner, txHash: attested.body.txHash, success: true, nonce });
    // an attestation names the payment it attests; its own tx hash stays `txHash`
    expect(att.paymentTxHash).toBe(paid.body.txHash);
    expect(att.txHash).not.toBe(att.paymentTxHash);
    expect(registered).not.toHaveProperty('paymentTxHash');
    expect(payment).not.toHaveProperty('paymentTxHash');
    expect(att.detail).toBe(`attested service #${serviceId} — success`);

    for (const e of mine) {
      expect(isNearTxHash(e.txHash)).toBe(true);
      expect(typeof e.timestamp).toBe('number');
    }
    // one block per mutating call, and nothing else ran in between
    expect(registered.blockHeight).toBeGreaterThan(0);
    expect(payment.blockHeight).toBe(registered.blockHeight + 1);
    expect(att.blockHeight).toBe(payment.blockHeight + 1);
    const timestamps = mine.map((e: any) => e.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    // the payment record carries the same height as its activity event
    expect((await get(`/registry/payments/${nonce}`)).body.blockHeight).toBe(payment.blockHeight);
  });

  it('attributes each payment to the service it paid, not to the shared payment target', async () => {
    const shared = 'shared-target.mock';
    const serviceA = await newService({ paymentTarget: shared });
    const serviceB = await newService({ paymentTarget: shared });
    await pay(serviceA, freshNonce());
    await pay(serviceB, freshNonce());
    const [newest, older] = (await get('/registry/activity?limit=2')).body;
    expect(newest).toMatchObject({ kind: 'payment', serviceId: serviceB });
    expect(older).toMatchObject({ kind: 'payment', serviceId: serviceA });
  });

  it('only successful calls take a block and an activity slot', async () => {
    const serviceId = await newService();
    const first = freshNonce();
    await pay(serviceId, first);
    const heightBefore = (await get(`/registry/payments/${first}`)).body.blockHeight as number;
    const feedBefore = (await get('/registry/activity?limit=1000')).body;

    expectErr(await pay(serviceId, first), 'ERR_NONCE_USED');
    expectErr(await attest(serviceId, freshNonce()), 'ERR_PAYMENT_NOT_FOUND');
    expectErr(await setActive(serviceId, false, STRANGER), 'ERR_NOT_AUTHORIZED');
    expect((await get('/registry/activity?limit=1000')).body).toEqual(feedBefore);

    const next = freshNonce();
    await pay(serviceId, next);
    expect((await get(`/registry/payments/${next}`)).body.blockHeight).toBe(heightBefore + 1);
  });

  it('set_active writes no activity entry, like the contract', async () => {
    const serviceId = await newService();
    const before = (await get('/registry/activity?limit=1000')).body;
    await setActive(serviceId, false);
    await setActive(serviceId, true);
    const after = (await get('/registry/activity?limit=1000')).body;
    expect(after).toEqual(before);
  });

  it(`keeps only the newest ${ACTIVITY_CAP} events`, async () => {
    const whale = 'activity-whale.mock';
    await fund(whale, NEAR('100000'));
    const serviceId = await newService({ priceYocto: MIN_PRICE_YOCTO });
    const depositYocto = (BigInt(MIN_PRICE_YOCTO) + BigInt(FEE)).toString();

    let firstHash = '';
    let lastHash = '';
    for (let i = 0; i < ACTIVITY_CAP + 5; i += 1) {
      const res = await pay(serviceId, freshNonce(), { signer: whale, depositYocto });
      expect(res.status).toBe(200);
      if (i === 0) firstHash = res.body.txHash;
      lastHash = res.body.txHash;
    }

    const res = await get('/registry/activity?limit=1000');
    expect(res.body).toHaveLength(ACTIVITY_CAP);
    expect(res.body[0].txHash).toBe(lastHash); // newest first
    expect(res.body.some((e: any) => e.txHash === firstHash)).toBe(false); // oldest dropped
    expect((await get('/registry/activity?limit=3')).body).toHaveLength(3);
    expect((await get('/registry/activity')).body).toHaveLength(50); // the default limit
  }, 60_000);

  it('rejects out-of-range limit values', async () => {
    expect((await get('/registry/activity?limit=1001')).status).toBe(400);
    expect((await get('/registry/activity?limit=0')).status).toBe(400);
    expect((await get('/registry/activity?limit=abc')).status).toBe(400);
  });
});

describe('escrow: deposit_escrow, withdraw_escrow, pay_from_escrow, escrow_of (mirror of the contract, Task 10a)', () => {
  const ESCROW_FEE = '2000000000000000000000'; // ESCROW_STORAGE_FEE_YOCTO, 0.002 NEAR
  let escrowAccounts = 0;

  /** A funded account no earlier test touched. */
  async function freshBuyer(funds = NEAR('100')): Promise<string> {
    escrowAccounts += 1;
    const accountId = `escrow-buyer-${escrowAccounts}.mock`;
    await fund(accountId, funds);
    return accountId;
  }

  const depositEscrow = (signer: string, depositYocto: string): Promise<HttpResult> =>
    post('/registry/deposit-escrow', { signer, depositYocto });
  const withdrawEscrow = (signer: string, amountYocto: string, depositYocto = '1'): Promise<HttpResult> =>
    post('/registry/withdraw-escrow', { signer, amountYocto, depositYocto });
  const payFromEscrow = (
    serviceId: number,
    nonce: string,
    opts: { signer?: string; depositYocto?: string } = {},
  ): Promise<HttpResult> =>
    post('/registry/pay-from-escrow', {
      signer: opts.signer ?? BUYER,
      serviceId,
      nonce,
      depositYocto: opts.depositYocto ?? '0',
    });
  async function escrowOf(accountId: string): Promise<bigint> {
    const res = await get(`/registry/escrow/${accountId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.accountId).toBe(accountId);
    expect(typeof res.body.escrowYocto).toBe('string');
    return BigInt(res.body.escrowYocto);
  }
  /** Opens `account`'s escrow holding exactly `balance` (the first deposit keeps the storage fee). */
  async function fundEscrow(accountId: string, balance: bigint): Promise<void> {
    expect((await depositEscrow(accountId, (balance + BigInt(ESCROW_FEE)).toString())).status).toBe(200);
    expect(await escrowOf(accountId)).toBe(balance);
  }

  it('escrow_of is "0" for an account that never deposited; escrows are per account', async () => {
    const res = await get('/registry/escrow/never-deposited.mock');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accountId: 'never-deposited.mock', escrowYocto: '0' });
  });

  it('the first deposit keeps the 0.002 NEAR storage fee, later deposits are credited in full', async () => {
    const buyer = await freshBuyer();
    const registryBefore = await balanceOf(REGISTRY);

    const first = await depositEscrow(buyer, NEAR('1'));
    expect(first.status).toBe(200);
    expect(isNearTxHash(first.body.txHash)).toBe(true);
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('1')) - BigInt(ESCROW_FEE)); // 0.998 NEAR
    expect(await balanceOf(buyer)).toBe(BigInt(NEAR('99')));
    expect((await balanceOf(REGISTRY)) - registryBefore).toBe(BigInt(NEAR('1'))); // the registry holds it all

    expect((await depositEscrow(buyer, NEAR('1'))).status).toBe(200);
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('2')) - BigInt(ESCROW_FEE)); // 1.998 NEAR
    expect(await escrowOf(await freshBuyer())).toBe(0n);
  });

  it('the first deposit must be more than the fee (ERR_DEPOSIT_TOO_LOW); a top-up must attach something', async () => {
    const buyer = await freshBuyer();
    const registryBefore = await balanceOf(REGISTRY);
    const first = await depositEscrow(buyer, ESCROW_FEE);
    expectErr(first, 'ERR_DEPOSIT_TOO_LOW');
    expect(first.body.message).toBe(
      'the first deposit must be more than 2000000000000000000000 yocto (0.002 NEAR escrow storage fee)',
    );
    expectErr(await depositEscrow(buyer, '0'), 'ERR_DEPOSIT_TOO_LOW');
    expect(await escrowOf(buyer)).toBe(0n);
    expect(await balanceOf(buyer)).toBe(BigInt(NEAR('100'))); // a rejected call moves nothing
    expect(await balanceOf(REGISTRY)).toBe(registryBefore);

    // one yocto above the fee opens the escrow with a one-yocto balance
    expect((await depositEscrow(buyer, (BigInt(ESCROW_FEE) + 1n).toString())).status).toBe(200);
    expect(await escrowOf(buyer)).toBe(1n);
    // from then on any deposit above zero is credited in full, and zero is refused
    const topUp = await depositEscrow(buyer, '0');
    expectErr(topUp, 'ERR_DEPOSIT_TOO_LOW');
    expect(topUp.body.message).toBe('attach a deposit');
    expect((await depositEscrow(buyer, '1')).status).toBe(200);
    expect(await escrowOf(buyer)).toBe(2n);
  });

  it('an emptied escrow keeps its entry: the next deposit pays no second storage fee', async () => {
    const buyer = await freshBuyer();
    await fundEscrow(buyer, 5n);
    expect((await withdrawEscrow(buyer, '5')).status).toBe(200);
    expect(await escrowOf(buyer)).toBe(0n);
    expectErr(await depositEscrow(buyer, '0'), 'ERR_DEPOSIT_TOO_LOW'); // "attach a deposit", not the first-deposit rule
    expect((await depositEscrow(buyer, '7')).status).toBe(200); // below the fee, credited in full
    expect(await escrowOf(buyer)).toBe(7n);
  });

  it('withdraw_escrow needs exactly 1 yocto attached, as the first check (ERR_ONE_YOCTO_REQUIRED)', async () => {
    const buyer = await freshBuyer();
    await fundEscrow(buyer, BigInt(NEAR('1')));
    for (const attached of ['0', '2']) {
      const res = await withdrawEscrow(buyer, NEAR('0.5'), attached);
      expectErr(res, 'ERR_ONE_YOCTO_REQUIRED');
      expect(res.body.message).toBe('attach exactly 1 yocto (only a full-access key can withdraw)');
    }
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('1')));
    // it is the first check: an account without an escrow, and an amount over the balance, get it too
    expectErr(await withdrawEscrow('stranger.mock', '1', '0'), 'ERR_ONE_YOCTO_REQUIRED');
    expectErr(await withdrawEscrow(buyer, NEAR('999'), '0'), 'ERR_ONE_YOCTO_REQUIRED');
  });

  it('withdraw_escrow: 1 <= amount <= balance (ERR_ESCROW_INSUFFICIENT), unknown accounts and zero included', async () => {
    const buyer = await freshBuyer();
    await fundEscrow(buyer, BigInt(NEAR('1')));
    const over = await withdrawEscrow(buyer, (BigInt(NEAR('1')) + 1n).toString());
    expectErr(over, 'ERR_ESCROW_INSUFFICIENT');
    expect(over.body.message).toBe(
      `the amount must be between 1 and the escrow balance, ${NEAR('1')} yocto`,
    );
    expectErr(await withdrawEscrow(buyer, '0'), 'ERR_ESCROW_INSUFFICIENT'); // zero is not a withdrawal
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('1')));
    const stranger = await freshBuyer();
    const none = await withdrawEscrow(stranger, '1');
    expectErr(none, 'ERR_ESCROW_INSUFFICIENT');
    expect(none.body.message).toContain(', 0 yocto');
  });

  it('withdraw_escrow debits the escrow and sends the amount to the caller; the 1 yocto stays in the registry', async () => {
    const buyer = await freshBuyer();
    await fundEscrow(buyer, BigInt(NEAR('1')));
    const accountBefore = await balanceOf(buyer);
    const registryBefore = await balanceOf(REGISTRY);

    const quarter = BigInt(NEAR('0.25'));
    const res = await withdrawEscrow(buyer, quarter.toString());
    expect(res.status).toBe(200);
    expect(isNearTxHash(res.body.txHash)).toBe(true);
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('0.75')));
    expect(await balanceOf(buyer)).toBe(accountBefore + quarter - 1n);
    expect(await balanceOf(REGISTRY)).toBe(registryBefore - quarter + 1n);

    // the rest can be withdrawn too, which leaves nothing
    expect((await withdrawEscrow(buyer, NEAR('0.75'))).status).toBe(200);
    expect(await escrowOf(buyer)).toBe(0n);
    expectErr(await withdrawEscrow(buyer, '1'), 'ERR_ESCROW_INSUFFICIENT');
  });

  it('pay_from_escrow debits price + fee, pays the target, refunds nothing and leaves the account balance alone', async () => {
    const target = 'escrow-payout-a.mock';
    const buyer = await freshBuyer();
    const serviceId = await newService({ paymentTarget: target });
    await fundEscrow(buyer, BigInt(NEAR('1')));
    const accountBefore = await balanceOf(buyer);
    const registryBefore = await balanceOf(REGISTRY);
    const nonce = freshNonce();

    const res = await payFromEscrow(serviceId, nonce, { signer: buyer });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(isNearTxHash(res.body.txHash)).toBe(true);
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('0.498'))); // 1 - 0.5 - 0.002
    expect(await balanceOf(target)).toBe(BigInt(PRICE));
    expect(await balanceOf(buyer)).toBe(accountBefore); // the account itself paid nothing
    expect(await balanceOf(REGISTRY)).toBe(registryBefore - BigInt(PRICE)); // the fee stays in the registry

    // the same record and activity entry as pay: the payer is the caller, the amount the price
    expect((await get(`/registry/payments/${nonce}`)).body).toMatchObject({
      nonce,
      serviceId,
      payer: buyer,
      amountYocto: PRICE,
      selfPaid: false,
      attested: false,
    });
    const [latest] = (await get('/registry/activity?limit=1')).body;
    expect(latest).toMatchObject({
      kind: 'payment',
      serviceId,
      account: buyer,
      txHash: res.body.txHash,
      amountYocto: PRICE,
      nonce,
    });
    // and it is attested like any other payment
    expect((await attest(serviceId, nonce, { paymentTxHash: res.body.txHash })).status).toBe(200);
  });

  it('pay_from_escrow takes no deposit (ERR_DEPOSIT_NOT_ALLOWED) and checks that before the service', async () => {
    const buyer = await freshBuyer();
    const serviceId = await newService();
    await fundEscrow(buyer, BigInt(NEAR('1')));
    for (const attached of ['1', (BigInt(PRICE) + BigInt(FEE)).toString()]) {
      const res = await payFromEscrow(serviceId, '77', { signer: buyer, depositYocto: attached });
      expectErr(res, 'ERR_DEPOSIT_NOT_ALLOWED');
      expect(res.body.message).toBe('pay_from_escrow takes no deposit, it spends the escrow');
    }
    expectErr(await payFromEscrow(999_999, '77', { signer: buyer, depositYocto: '1' }), 'ERR_DEPOSIT_NOT_ALLOWED');
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('1')));
    expect((await get('/registry/payments/77')).status).toBe(404);
  });

  it('pay_from_escrow: ERR_ESCROW_INSUFFICIENT for no escrow or one yocto short, checked before the nonce', async () => {
    const serviceId = await newService();
    const required = BigInt(PRICE) + BigInt(FEE);

    const noEscrow = await freshBuyer();
    const none = await payFromEscrow(serviceId, freshNonce(), { signer: noEscrow });
    expectErr(none, 'ERR_ESCROW_INSUFFICIENT');
    expect(none.body.message).toBe(
      `the escrow holds 0 yocto, the payment needs ${required} (price + storage fee)`,
    );

    const short = await freshBuyer();
    await fundEscrow(short, required - 1n);
    const nonce = freshNonce();
    expectErr(await payFromEscrow(serviceId, nonce, { signer: short }), 'ERR_ESCROW_INSUFFICIENT');
    // where `pay` checks its deposit: before the nonce shape
    expectErr(await payFromEscrow(serviceId, '1x', { signer: short }), 'ERR_ESCROW_INSUFFICIENT');
    // a rejected call changes nothing
    expect(await escrowOf(short)).toBe(required - 1n);
    expect((await get(`/registry/payments/${nonce}`)).status).toBe(404);

    // exactly price + fee is enough, and leaves nothing
    expect((await depositEscrow(short, '1')).status).toBe(200);
    expect((await payFromEscrow(serviceId, nonce, { signer: short })).status).toBe(200);
    expect(await escrowOf(short)).toBe(0n);
  });

  it('a price near u128::MAX is an escrow error, not an overflow: the required amount saturates at u128::MAX', async () => {
    const u128Max = ((1n << 128n) - 1n).toString();
    const huge = await newService({ priceYocto: (BigInt(u128Max) - 5n).toString() });
    const buyer = await freshBuyer();
    await fundEscrow(buyer, BigInt(NEAR('1')));
    const res = await payFromEscrow(huge, freshNonce(), { signer: buyer });
    expectErr(res, 'ERR_ESCROW_INSUFFICIENT');
    expect(res.body.message).toContain(`the payment needs ${u128Max} (price + storage fee)`);
  });

  it('a nonce is single-use across pay and pay_from_escrow, in both directions', async () => {
    const serviceId = await newService();
    const buyer = await freshBuyer();
    await fundEscrow(buyer, BigInt(NEAR('3')));
    const viaEscrow = freshNonce();
    expect((await payFromEscrow(serviceId, viaEscrow, { signer: buyer })).status).toBe(200);
    const left = await escrowOf(buyer);

    expectErr(await payFromEscrow(serviceId, viaEscrow, { signer: buyer }), 'ERR_NONCE_USED');
    expectErr(await pay(serviceId, viaEscrow), 'ERR_NONCE_USED');
    const viaDeposit = freshNonce();
    expect((await pay(serviceId, viaDeposit)).status).toBe(200);
    expectErr(await payFromEscrow(serviceId, viaDeposit, { signer: buyer }), 'ERR_NONCE_USED');
    expectErr(await payFromEscrow(serviceId, '4x', { signer: buyer }), 'ERR_INVALID_NONCE');
    expect(await escrowOf(buyer)).toBe(left); // no rejected call debited the escrow
    expect((await get(`/registry/payments/${viaEscrow}`)).body.payer).toBe(buyer);
    expect((await get(`/registry/payments/${viaDeposit}`)).body.payer).toBe(BUYER);
  });

  it('pay_from_escrow: ERR_SERVICE_NOT_FOUND and ERR_SERVICE_INACTIVE come before the escrow check', async () => {
    const serviceId = await newService();
    const buyer = await freshBuyer();
    await fundEscrow(buyer, BigInt(NEAR('1')));
    expect((await setActive(serviceId, false)).status).toBe(200);

    expectErr(await payFromEscrow(serviceId, freshNonce(), { signer: buyer }), 'ERR_SERVICE_INACTIVE');
    expectErr(await payFromEscrow(999_999, freshNonce(), { signer: buyer }), 'ERR_SERVICE_NOT_FOUND');
    // the service is checked before the escrow: an account without one gets the same error
    expectErr(await payFromEscrow(serviceId, freshNonce(), { signer: await freshBuyer() }), 'ERR_SERVICE_INACTIVE');
    expect(await escrowOf(buyer)).toBe(BigInt(NEAR('1')));

    // switched back on, it takes escrow payments again
    expect((await setActive(serviceId, true)).status).toBe(200);
    expect((await payFromEscrow(serviceId, freshNonce(), { signer: buyer })).status).toBe(200);
  });

  it('pay_from_escrow marks the owner and the payment target selfPaid, and a self-paid payment cannot be attested', async () => {
    const target = 'escrow-self-target.mock';
    await fund(target, NEAR('10'));
    const serviceId = await newService({ paymentTarget: target });
    const buyer = await freshBuyer();
    const flags: Array<[string, boolean]> = [
      [OWNER, true],
      [target, true],
      [ATTESTOR, false],
      [buyer, false],
    ];
    for (const [payer, selfPaid] of flags) {
      const nonce = freshNonce();
      await fundEscrow(payer, BigInt(NEAR('1')));
      expect((await payFromEscrow(serviceId, nonce, { signer: payer })).status).toBe(200);
      expect((await get(`/registry/payments/${nonce}`)).body, payer).toMatchObject({ payer, selfPaid });
      if (selfPaid) expectErr(await attest(serviceId, nonce), 'ERR_SELF_PAYMENT');
    }
  });

  it('ERR_INSUFFICIENT_BALANCE (mock-only) when the signer cannot fund the attached deposit, before any contract check', async () => {
    const poor = await freshBuyer(NEAR('0.1'));
    expectErr(await depositEscrow(poor, NEAR('1')), 'ERR_INSUFFICIENT_BALANCE');
    expectErr(await depositEscrow('never-funded-escrow.mock', NEAR('1')), 'ERR_INSUFFICIENT_BALANCE');
    expect(await escrowOf(poor)).toBe(0n);
    expect(await balanceOf(poor)).toBe(BigInt(NEAR('0.1')));
  });

  it('only successful escrow calls take a block; a rejected one changes no state', async () => {
    const buyer = await freshBuyer();
    const serviceId = await newService();
    /** The block height a probe `pay` lands in. */
    const probeHeight = async (): Promise<number> => {
      const nonce = freshNonce();
      expect((await pay(serviceId, nonce)).status).toBe(200);
      return (await get(`/registry/payments/${nonce}`)).body.blockHeight as number;
    };
    const before = await probeHeight();
    expectErr(await depositEscrow(buyer, '0'), 'ERR_DEPOSIT_TOO_LOW');
    expectErr(await withdrawEscrow(buyer, '1'), 'ERR_ESCROW_INSUFFICIENT');
    expectErr(await payFromEscrow(serviceId, freshNonce(), { signer: buyer }), 'ERR_ESCROW_INSUFFICIENT');
    expect(await probeHeight()).toBe(before + 1); // none of the three rejected calls took a block
    await fundEscrow(buyer, 1n); // a successful deposit does
    expect(await probeHeight()).toBe(before + 3);
  });

  it('validates every account id with ERR_INVALID_ACCOUNT_ID', async () => {
    expectErr(await depositEscrow('Bad Account', NEAR('1')), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await depositEscrow('', NEAR('1')), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await withdrawEscrow('Bad Account', '1'), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await payFromEscrow(1, '1', { signer: 'Bad Account' }), 'ERR_INVALID_ACCOUNT_ID');
    expectErr(await get('/registry/escrow/Bad%20Account'), 'ERR_INVALID_ACCOUNT_ID');
  });

  it('400s malformed request shapes', async () => {
    const buyer = await freshBuyer();
    expect((await post('/registry/deposit-escrow', { signer: buyer })).status).toBe(400);
    expect((await post('/registry/deposit-escrow', { signer: buyer, depositYocto: '1.5' })).status).toBe(400);
    expect((await post('/registry/deposit-escrow', { signer: buyer, depositYocto: 1000 })).status).toBe(400);
    expect((await post('/registry/withdraw-escrow', { signer: buyer, depositYocto: '1' })).status).toBe(400);
    expect((await post('/registry/withdraw-escrow', { signer: buyer, amountYocto: '-1', depositYocto: '1' })).status).toBe(400);
    expect((await post('/registry/pay-from-escrow', { signer: buyer, serviceId: '1', nonce: '1', depositYocto: '0' })).status).toBe(400);
    expect((await post('/registry/pay-from-escrow', { signer: buyer, serviceId: 1, nonce: 5, depositYocto: '0' })).status).toBe(400);
    expect((await post('/registry/pay-from-escrow', { signer: buyer, serviceId: 1, nonce: '5' })).status).toBe(400);
    expect((await post('/registry/pay-from-escrow', [])).status).toBe(400);
  });
});

describe('DevnetState payments memory guard', () => {
  it(`caps stored payments at ${MAX_PAYMENTS} by default and never evicts to make room`, () => {
    expect(MAX_PAYMENTS).toBe(100_000);

    const state = new DevnetState({ maxPayments: 3 });
    state.faucet('guard-owner.mock', NEAR('10'));
    state.faucet('guard-buyer.mock', NEAR('10'));
    const { serviceId } = state.registerService(
      'guard-owner.mock',
      { name: 'svc', description: '', gatewayBaseUrl: GATEWAY, priceYocto: PRICE, paymentTarget: TARGET, attestor: ATTESTOR },
      REG_DEPOSIT,
    );
    const deposit = (BigInt(PRICE) + BigInt(FEE)).toString();
    for (const nonce of ['1', '2', '3']) state.pay('guard-buyer.mock', serviceId, nonce, deposit);

    const balanceBefore = state.getBalance('guard-buyer.mock');
    expect(() => state.pay('guard-buyer.mock', serviceId, '4', deposit)).toThrowError(
      expect.objectContaining({ code: 'devnet_capacity', httpStatus: 429 }),
    );
    // the refused call took no money and burned no nonce
    expect(state.getBalance('guard-buyer.mock')).toBe(balanceBefore);
    expect(() => state.getPayment('4')).toThrowError(expect.objectContaining({ httpStatus: 404 }));

    // nothing was evicted: the first nonces are still single-use
    expect(() => state.pay('guard-buyer.mock', serviceId, '1', deposit)).toThrowError(
      expect.objectContaining({ code: 'ERR_NONCE_USED' }),
    );
    expect(state.getPayment('1').payer).toBe('guard-buyer.mock');
    // the contract's own rejections still win over the guard
    expect(() => state.pay('guard-buyer.mock', serviceId, 'x', deposit)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_NONCE' }),
    );
  });
});

describe('DevnetState memory guard', () => {
  it(`caps the registry at ${MAX_SERVICES} services (a devnet-only guard, not a protocol rule)`, () => {
    const state = new DevnetState();
    state.faucet('guard-owner.mock', NEAR('1000'));
    const input = {
      name: 'svc',
      description: '',
      gatewayBaseUrl: GATEWAY,
      priceYocto: PRICE,
      paymentTarget: TARGET,
      attestor: ATTESTOR,
    };
    for (let i = 0; i < MAX_SERVICES; i += 1) {
      state.registerService('guard-owner.mock', input, REG_DEPOSIT);
    }
    expect(() => state.registerService('guard-owner.mock', input, REG_DEPOSIT)).toThrowError(
      expect.objectContaining({ code: 'service_limit_reached', httpStatus: 429 }),
    );
    // the refused call took nothing from the owner
    expect(BigInt(state.getBalance('guard-owner.mock'))).toBe(
      BigInt(NEAR('1000')) - BigInt(MAX_SERVICES) * BigInt(REG_DEPOSIT),
    );
  });
});

describe('rustTrim', () => {
  it('strips exactly the Unicode White_Space set from both ends', () => {
    expect(rustTrim('  a b  ')).toBe('a b');
    expect(rustTrim('\u0085a\u0085')).toBe('a');
    expect(rustTrim('\ufeffa\ufeff')).toBe('\ufeffa\ufeff');
    expect(rustTrim('\u200ba\u200b')).toBe('\u200ba\u200b');
    expect(rustTrim('')).toBe('');
    expect(rustTrim(' \t\n ')).toBe('');
  });

  it('is linear on long whitespace runs with a non-space tail (no regex backtracking)', () => {
    const started = Date.now();
    expect(rustTrim(`${' '.repeat(200_000)}x${' '.repeat(10)}y`)).toBe(`x${' '.repeat(10)}y`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
