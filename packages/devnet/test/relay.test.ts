import { KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import type { Action } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESCROW_STORAGE_FEE_YOCTO, PAYMENT_STORAGE_FEE_YOCTO, REGISTRATION_DEPOSIT_YOCTO, nearToYocto } from '@agentgate/shared';
import { PAY_DELEGATE_GAS, buildEscrowPayDelegate, payDelegateArgs } from '@agentgate/chain/delegate';
import { devnetRelayTxHash } from '@agentgate/chain/devnet-key';
import { deriveDevnetKey, startServer } from '../src/index';
import type { RunningServer } from '../src/index';

// The devnet's NEP-366 relay (Task 10c): POST /registry/relay checks a SignedDelegate the way NEAR
// does (signature over near-api-js's encoding, the sender's key, its nonce, the expiry), then runs
// the one call it relays, pay_from_escrow, as the delegate's sender.

const REGISTRY = 'registry.mock';
const OWNER = 'relay-owner.mock';
const TARGET = 'relay-target.mock';
const RELAYER = 'relay-gateway.mock';
const PRICE = nearToYocto('0.5');
const TOTAL = (BigInt(PRICE) + BigInt(PAYMENT_STORAGE_FEE_YOCTO)).toString();

interface HttpResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

let server: RunningServer;
let base: string;
let serviceId: number;
let accounts = 0;
let nonceCounter = 70_000;

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

function freshNonce(): string {
  nonceCounter += 1;
  return String(nonceCounter);
}

async function height(): Promise<number> {
  const res = await get('/block');
  expect(res.status).toBe(200);
  return res.body.height as number;
}

/** A funded account with 1 NEAR in its escrow, and a near-api-js signer holding its devnet key. */
async function escrowBuyer(): Promise<{ accountId: string; signer: KeyPairSigner }> {
  accounts += 1;
  const accountId = `relay-buyer-${accounts}.mock`;
  expect((await post('/faucet', { accountId, amountYocto: nearToYocto('10') })).status).toBe(200);
  expect((await post('/registry/deposit-escrow', { signer: accountId, depositYocto: nearToYocto('1') })).status).toBe(200);
  return { accountId, signer: new KeyPairSigner(KeyPair.fromString(deriveDevnetKey(accountId).secretKey as `ed25519:${string}`)) };
}

function accessKeyPath(accountId: string, publicKey: string): string {
  return `/accounts/${accountId}/access-key/${encodeURIComponent(publicKey)}`;
}

/** The delegate the client builds for invoice `nonce`: key nonce `delegateNonce`, valid 100 blocks. */
async function payDelegate(
  buyer: { accountId: string; signer: KeyPairSigner },
  over: { nonce?: string; delegateNonce?: bigint; maxBlockHeight?: bigint } = {},
): Promise<string> {
  return buildEscrowPayDelegate(buyer.signer, {
    registryId: REGISTRY,
    senderId: buyer.accountId,
    serviceId,
    nonce: over.nonce ?? freshNonce(),
    delegateNonce: over.delegateNonce ?? 1n,
    maxBlockHeight: over.maxBlockHeight ?? BigInt((await height()) + 100),
  });
}

/** Any delegate, signed by `signer` through near-api-js. */
async function anyDelegate(
  signer: KeyPairSigner,
  parts: { senderId: string; receiverId?: string; actions: Action[] },
): Promise<string> {
  const delegateAction = buildDelegateAction({
    senderId: parts.senderId,
    receiverId: parts.receiverId ?? REGISTRY,
    actions: parts.actions,
    nonce: 1n,
    maxBlockHeight: BigInt((await height()) + 100),
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegateAction);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
}

function payCall(over: { method?: string; deposit?: bigint } = {}): Action {
  return actions.functionCall(
    over.method ?? 'pay_from_escrow',
    Buffer.from(payDelegateArgs(serviceId, freshNonce())),
    PAY_DELEGATE_GAS,
    over.deposit ?? 0n,
  );
}

function relay(signedDelegate: unknown, relayer: unknown = RELAYER): Promise<HttpResult> {
  return post('/registry/relay', { relayer, signedDelegate });
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  await post('/faucet', { accountId: OWNER, amountYocto: nearToYocto('100') });
  const registered = await post('/registry/register', {
    signer: OWNER,
    input: {
      name: 'Relay Feed',
      description: 'relayed',
      gatewayBaseUrl: 'http://localhost:4021',
      priceYocto: PRICE,
      paymentTarget: TARGET,
      attestor: OWNER,
    },
    depositYocto: REGISTRATION_DEPOSIT_YOCTO,
  });
  expect(registered.status).toBe(200);
  serviceId = registered.body.serviceId as number;
});

afterAll(async () => {
  await server.close();
});

describe('GET /block and GET /accounts/:id/access-key/:publicKey', () => {
  it('/block answers the devnet height, which each block raises', async () => {
    const before = await height();
    await post('/faucet', { accountId: 'relay-height.mock', amountYocto: '1' });
    expect(await height()).toBe(before + 1);
  });

  it("the access key is the account's devnet key, FullAccess with nonce 0 until a delegate uses it; 404 for any other", async () => {
    const buyer = await escrowBuyer();
    const { publicKey } = deriveDevnetKey(buyer.accountId);
    expect(await get(accessKeyPath(buyer.accountId, publicKey))).toEqual({
      status: 200,
      body: { accountId: buyer.accountId, publicKey, nonce: '0', permission: 'FullAccess' },
    });
    expect((await get(accessKeyPath(buyer.accountId, deriveDevnetKey('other.mock').publicKey))).status).toBe(404);
    expect((await get(accessKeyPath('never-seen.mock', deriveDevnetKey('never-seen.mock').publicKey))).status).toBe(404);
    expect((await get(accessKeyPath('Bad Id', publicKey))).body).toMatchObject({ error: 'ERR_INVALID_ACCOUNT_ID' });
  });
});

describe('POST /registry/relay {relayer, signedDelegate}', () => {
  it("runs pay_from_escrow as the delegate's sender: the escrow pays price + fee, the key nonce moves to the delegate's", async () => {
    const buyer = await escrowBuyer();
    const nonce = freshNonce();
    const balanceBefore = (await get(`/accounts/${buyer.accountId}/balance`)).body.balanceYocto as string;
    const signedDelegate = await payDelegate(buyer, { nonce });
    const res = await relay(signedDelegate);
    expect(res.status).toBe(200);
    // The relay's tx is named by its delegate: what a mock client whose answer timed out names too.
    expect(res.body.txHash).toBe(devnetRelayTxHash(signedDelegate));
    expect((await get('/registry/activity?limit=5')).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'payment', nonce, txHash: devnetRelayTxHash(signedDelegate) })]),
    );
    expect((await get(`/registry/payments/${nonce}`)).body).toMatchObject({ payer: buyer.accountId, serviceId, amountYocto: PRICE });
    expect((await get(`/registry/escrow/${buyer.accountId}`)).body.escrowYocto).toBe(
      (BigInt(nearToYocto('1')) - BigInt(ESCROW_STORAGE_FEE_YOCTO) - BigInt(TOTAL)).toString(),
    );
    expect((await get(`/accounts/${buyer.accountId}/balance`)).body.balanceYocto).toBe(balanceBefore);
    expect((await get(accessKeyPath(buyer.accountId, deriveDevnetKey(buyer.accountId).publicKey))).body.nonce).toBe('1');
  });

  it('refuses a delegate NEAR would refuse, as DELEGATE_REJECTED naming the DelegateAction error; the key nonce is not spent', async () => {
    const buyer = await escrowBuyer();
    const publicKey = deriveDevnetKey(buyer.accountId).publicKey;
    const forged = Buffer.from(await payDelegate(buyer), 'base64');
    forged[forged.length - 1]! ^= 0x01;
    const thief = { accountId: buyer.accountId, signer: new KeyPairSigner(KeyPair.fromRandom('ed25519')) };
    const cases: Array<[string, string]> = [
      [forged.toString('base64'), 'DelegateActionInvalidSignature'],
      [await payDelegate(thief), 'DelegateActionAccessKeyError'], // a valid signature by a key the account does not hold
      [await payDelegate(buyer, { maxBlockHeight: BigInt((await height()) - 1) }), 'DelegateActionExpired'],
      [await payDelegate(buyer, { delegateNonce: 0n }), 'DelegateActionInvalidNonce'],
      [await payDelegate(buyer, { delegateNonce: BigInt(await height()) * 1_000_000n }), 'DelegateActionNonceTooLarge'],
    ];
    for (const [signedDelegate, error] of cases) {
      const res = await relay(signedDelegate);
      expect(res, error).toMatchObject({ status: 400, body: { error: 'DELEGATE_REJECTED' } });
      expect(res.body.message).toMatch(new RegExp(error));
    }
    expect((await get(accessKeyPath(buyer.accountId, publicKey))).body.nonce).toBe('0');
  });

  it('the inner pay_from_escrow failing keeps its contract code, and the delegate nonce is spent anyway (as on NEAR)', async () => {
    const buyer = await escrowBuyer();
    const nonce = freshNonce();
    expect((await relay(await payDelegate(buyer, { nonce }))).status).toBe(200);
    // Top the escrow up, so the contract gets past its funding check to the nonce.
    expect((await post('/registry/deposit-escrow', { signer: buyer.accountId, depositYocto: nearToYocto('1') })).status).toBe(200);
    const replayOfInvoice = await relay(await payDelegate(buyer, { nonce, delegateNonce: 2n })); // the invoice is paid already
    expect(replayOfInvoice).toMatchObject({ status: 400, body: { error: 'ERR_NONCE_USED' } });
    expect((await get(accessKeyPath(buyer.accountId, deriveDevnetKey(buyer.accountId).publicKey))).body.nonce).toBe('2');
  });

  it('relays only one zero-deposit pay_from_escrow to the registry (unsupported_delegate otherwise); garbage is invalid_request', async () => {
    const buyer = await escrowBuyer();
    const unsupported = [
      await anyDelegate(buyer.signer, { senderId: buyer.accountId, receiverId: 'other.mock', actions: [payCall()] }),
      await anyDelegate(buyer.signer, { senderId: buyer.accountId, actions: [payCall(), payCall()] }),
      await anyDelegate(buyer.signer, { senderId: buyer.accountId, actions: [payCall({ method: 'withdraw_escrow' })] }),
      await anyDelegate(buyer.signer, { senderId: buyer.accountId, actions: [payCall({ deposit: 1n })] }),
      await anyDelegate(buyer.signer, { senderId: buyer.accountId, actions: [actions.transfer(1n)] }),
    ];
    for (const signedDelegate of unsupported) {
      expect((await relay(signedDelegate)).body).toMatchObject({ error: 'unsupported_delegate' });
    }
    for (const garbage of ['', 'not base64!', Buffer.from('borsh SignedDelegate bytes').toString('base64'), 7]) {
      expect(await relay(garbage)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect((await relay(await payDelegate(buyer), 'Bad Relayer')).body).toMatchObject({ error: 'ERR_INVALID_ACCOUNT_ID' });
    expect((await get(accessKeyPath(buyer.accountId, deriveDevnetKey(buyer.accountId).publicKey))).body.nonce).toBe('0');
  });
});
