import { KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TxTimeoutError, buildEscrowPayDelegate, decodeSignedDelegate, payDelegateArgs } from '@agentgate/chain';
import {
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  decodeXPaymentResponse,
  encodeXPayment,
  type AccessKeyInfo,
  type AnySigner,
  type PaymentRequiredResponse,
  type Yocto,
} from '@agentgate/shared';
import { createApp } from '../src/index';
import {
  adminMap,
  bootGateway,
  silentLogger,
  startUpstream,
  testConfig,
  until,
  type TestGateway,
  type TestUpstream,
} from './helpers';
import { FakeChainClient, contractError } from './fake-chain';

// The gasless rail (Task 10c, ruling R58): the gateway relays the buyer's signed NEP-366
// `pay_from_escrow` delegate. Delegates are real ones, built and signed with near-api-js; the chain
// is a fake whose relay settles the payment the way the registry would.

const GATEWAY = 'gateway.mock';
const BUYER = 'buyer.mock';
const REGISTRY = 'registry.mock';
const PRICE = '500000000000000000000000'; // 0.5 NEAR
const TOTAL = addYocto(PRICE, PAYMENT_STORAGE_FEE_YOCTO); // what the escrow pays: price + 0.002 NEAR
const RELAY_GAS = 30_000_000_000_000n;
/** Some tx hash for a relay that timed out without landing. */
const LOST_RELAY_TX = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';

interface RelayScript {
  /** Rejects the relay with this error (a function gets the landed relay's tx hash). */
  error?: Error | ((txHash: string) => Error);
  /** Settles the payment on chain first (default: when no error is scripted). */
  land?: boolean;
  /** The relay waits for this before doing anything. */
  gate?: Promise<void>;
}

/** The fake registry, plus the reads the delegate rail makes and a relay that settles the payment. */
class RelayChain extends FakeChainClient {
  height = 1_000;
  /** Access keys by `<account> <public key>`. */
  readonly keys = new Map<string, AccessKeyInfo>();
  readonly escrows = new Map<string, Yocto>();
  readonly relayed: Array<{ signedDelegate: string; relayer: AnySigner }> = [];
  script: RelayScript = {};

  override blockHeight(): Promise<number> {
    return Promise.resolve(this.height);
  }

  override accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
    return Promise.resolve(this.keys.get(`${accountId} ${publicKey}`) ?? null);
  }

  override escrowOf(accountId: string): Promise<Yocto> {
    return Promise.resolve(this.escrows.get(accountId) ?? '0');
  }

  override async relayPay(signedDelegate: string, relayer: AnySigner): Promise<{ txHash: string }> {
    this.relayed.push({ signedDelegate, relayer });
    const { error, land = error === undefined, gate } = this.script;
    if (gate !== undefined) await gate;
    let txHash = LOST_RELAY_TX;
    if (land) {
      // pay_from_escrow(service_id, nonce) as the delegate's sender: the escrow pays price + fee.
      const delegate = decodeSignedDelegate(signedDelegate);
      const call = delegate?.actions[0];
      if (delegate === null || call?.kind !== 'functionCall') throw new Error('RelayChain: not a pay delegate');
      const args = JSON.parse(Buffer.from(call.args).toString('utf8')) as { service_id: number; nonce: string };
      ({ txHash } = await this.pay(
        { serviceId: args.service_id, nonce: args.nonce, depositYocto: TOTAL },
        { kind: 'mock', accountId: delegate.senderId },
      ));
    }
    if (error !== undefined) throw typeof error === 'function' ? error(txHash) : error;
    return { txHash };
  }
}

interface BuyerKey {
  accountId: string;
  signer: KeyPairSigner;
  publicKey: string;
}

let gw: TestGateway;
let upstream: TestUpstream;
let chain: RelayChain;
let accounts = 0;

/** A fresh buyer account holding a fresh key (full access unless `permission` says otherwise) and a funded escrow. */
async function newBuyer(over: Partial<AccessKeyInfo> & { escrow?: Yocto } = {}): Promise<BuyerKey> {
  accounts += 1;
  const accountId = `buyer-${accounts}.mock`;
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  chain.keys.set(`${accountId} ${publicKey}`, { nonce: over.nonce ?? 41n, permission: over.permission ?? 'FullAccess' });
  chain.escrows.set(accountId, over.escrow ?? '10000000000000000000000000'); // 10 NEAR
  return { accountId, signer: new KeyPairSigner(keyPair), publicKey };
}

/** A fresh 402 invoice for service `serviceId`. */
async function invoice(serviceId = 1): Promise<{ nonce: string }> {
  const res = await fetch(`${gw.baseUrl}/svc/${serviceId}`);
  expect(res.status).toBe(402);
  const body = (await res.json()) as PaymentRequiredResponse;
  return { nonce: body.accepts[0]!.extra.nonce };
}

/** The buyer's signed delegate for invoice `nonce`, as the client builds it (each field overridable). */
function payDelegate(
  buyer: BuyerKey,
  over: { nonce: string; serviceId?: number; senderId?: string; delegateNonce?: bigint; maxBlockHeight?: bigint },
): Promise<string> {
  return buildEscrowPayDelegate(buyer.signer, {
    registryId: REGISTRY,
    senderId: over.senderId ?? buyer.accountId,
    serviceId: over.serviceId ?? 1,
    nonce: over.nonce,
    delegateNonce: over.delegateNonce ?? 42n,
    maxBlockHeight: over.maxBlockHeight ?? BigInt(chain.height + 100),
  });
}

/** A pay_from_escrow delegate with `deposit` attached, which the client never builds. */
async function depositDelegate(buyer: BuyerKey, nonce: string, deposit: bigint): Promise<string> {
  const delegateAction = buildDelegateAction({
    senderId: buyer.accountId,
    receiverId: REGISTRY,
    actions: [actions.functionCall('pay_from_escrow', Buffer.from(payDelegateArgs(1, nonce)), RELAY_GAS, deposit)],
    nonce: 42n,
    maxBlockHeight: BigInt(chain.height + 100),
    publicKey: await buyer.signer.getPublicKey(),
  });
  const { signedDelegate } = await buyer.signer.signDelegateAction(delegateAction);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
}

function delegateHeaders(signedDelegate: string, nonce: string, payer: string): Record<string, string> {
  return {
    'x-payment': encodeXPayment({
      x402Version: 1,
      scheme: 'exact',
      network: 'near-mock',
      payload: { kind: 'delegate', signedDelegate, nonce, payer },
    }),
  };
}

function presentDelegate(signedDelegate: string, nonce: string, payer: string): Promise<Response> {
  return fetch(`${gw.baseUrl}/svc/1`, { headers: delegateHeaders(signedDelegate, nonce, payer) });
}

/** The tx hash of the payment the (fake) registry holds for `nonce`. */
function paymentTx(nonce: string): string | undefined {
  return [...chain.payments.values()].find((p) => p.nonce === nonce)?.txHash;
}

beforeAll(async () => {
  chain = new RelayChain();
  gw = await bootGateway({ config: testConfig({ relayerEnabled: true, gatewayAccountId: GATEWAY }), fake: chain });
  upstream = await startUpstream();
  chain.addService({ id: 1, name: 'Gasless Feed', priceYocto: PRICE });
  chain.addService({ id: 2, name: 'Other Feed', priceYocto: PRICE });
  expect((await adminMap(gw, 1, `${upstream.url}/data`)).status).toBe(204);
});

afterAll(async () => {
  await gw.close();
  await upstream.close();
});

beforeEach(() => {
  chain.script = {};
});

describe('gasless rail: the offer (Task 10c)', () => {
  it('the 402 names the relayer (the gateway account) and the one method it relays', async () => {
    const res = await fetch(`${gw.baseUrl}/svc/1`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.accepts[0]!.extra).toMatchObject({
      relayer: GATEWAY,
      relayMethod: 'pay_from_escrow',
      method: 'pay', // the tx rails stay on offer
      settlement: 'neargate-registry-pay',
    });
  });

  it('fails closed: RELAYER_ENABLED without GATEWAY_ACCOUNT_ID (the relayer) is a config error', () => {
    expect(() =>
      createApp({ config: testConfig({ relayerEnabled: true }), chain: new FakeChainClient(), logger: silentLogger }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringMatching(/GATEWAY_ACCOUNT_ID/) }));
  });
});

describe('gasless rail: relay → verify → serve → attest', () => {
  it('delegate rail relays, verifies, serves, attests', async () => {
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });

    const res = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hello: 'world' });

    // One relay, of exactly the bytes the buyer signed, sent by the gateway account.
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
    expect(chain.relayed.at(-1)).toEqual({ signedDelegate, relayer: { kind: 'mock', accountId: GATEWAY } });
    // The escrow paid this invoice for this service, and the buyer is the payer.
    expect(await chain.getPayment(nonce)).toMatchObject({ serviceId: 1, payer: buyer.accountId, amountYocto: PRICE });
    const relayTx = paymentTx(nonce);
    expect(relayTx).toBeDefined();
    expect(decodeXPaymentResponse(res.headers.get('x-payment-response') ?? '')).toEqual({
      success: true,
      transaction: relayTx,
      network: 'near-mock',
      payer: buyer.accountId,
    });
    await until(() => chain.attestations.some((a) => a.nonce === nonce));
    expect(chain.attestations.find((a) => a.nonce === nonce)).toMatchObject({ paymentTxHash: relayTx, success: true });

    // Single use: the same delegate again is invoice_used and relays nothing.
    const again = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(again.status).toBe(402);
    expect(((await again.json()) as PaymentRequiredResponse).error).toBe('invoice_used');
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it("an agent's function-call key may sign it: receiver = the registry, pay_from_escrow listed or any method", async () => {
    for (const methodNames of [['pay_from_escrow'], []]) {
      const agent = await newBuyer({ permission: { receiverId: REGISTRY, methodNames, allowance: '100000000000000000000000' } });
      const { nonce } = await invoice();
      const res = await presentDelegate(await payDelegate(agent, { nonce }), nonce, agent.accountId);
      expect(res.status, JSON.stringify(methodNames)).toBe(200);
    }
  });
});

describe('gasless rail: every refusal comes before relayPay', () => {
  it('mismatched delegate is refused before relaying: 402 delegate_<reason>, a fresh invoice, relayPay never called', async () => {
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const seenBefore = upstream.seen.length;
    const cases: Array<[string, (nonce: string) => Promise<string>, string]> = [
      ['another invoice nonce', (n) => payDelegate(buyer, { nonce: String(BigInt(n) + 1n) }), 'delegate_wrong_args'],
      ['another service', (n) => payDelegate(buyer, { nonce: n, serviceId: 2 }), 'delegate_wrong_args'],
      ['a sender other than the payer', (n) => payDelegate(buyer, { nonce: n, senderId: 'mallory.mock' }), 'delegate_wrong_sender'],
      ['a deposit attached', (n) => depositDelegate(buyer, n, 1n), 'delegate_deposit_not_zero'],
      ['expired', (n) => payDelegate(buyer, { nonce: n, maxBlockHeight: BigInt(chain.height) }), 'delegate_expired'],
      ['not a SignedDelegate', () => Promise.resolve(Buffer.from('borsh SignedDelegate bytes').toString('base64')), 'delegate_malformed'],
    ];
    for (const [name, make, error] of cases) {
      const { nonce } = await invoice();
      const res = await presentDelegate(await make(nonce), nonce, buyer.accountId);
      expect(res.status, name).toBe(402);
      const body = (await res.json()) as PaymentRequiredResponse;
      expect(body.error, name).toBe(error);
      expect(body.accepts[0]!.extra.nonce, name).not.toBe(nonce); // a fresh invoice
    }
    expect(chain.relayed).toHaveLength(relayedBefore);
    expect(upstream.seen.length).toBe(seenBefore);
  });

  it('R58: a forged signature, an unknown key, a key that may not make this call, a stale nonce: 402, nothing relayed', async () => {
    const relayedBefore = chain.relayed.length;
    const refused = async (signedDelegate: string, nonce: string, payer: string, error: string): Promise<void> => {
      const res = await presentDelegate(signedDelegate, nonce, payer);
      expect(res.status, error).toBe(402);
      expect(((await res.json()) as PaymentRequiredResponse).error).toBe(error);
    };

    const buyer = await newBuyer();
    let { nonce } = await invoice();
    const forged = Buffer.from(await payDelegate(buyer, { nonce }), 'base64');
    forged[forged.length - 1]! ^= 0x01; // the signature's last byte
    await refused(forged.toString('base64'), nonce, buyer.accountId, 'bad_signature');

    ({ nonce } = await invoice());
    const stranger = await newBuyer();
    chain.keys.delete(`${stranger.accountId} ${stranger.publicKey}`); // the chain holds no such key
    await refused(await payDelegate(stranger, { nonce }), nonce, stranger.accountId, 'unknown_key');

    for (const permission of [
      { receiverId: 'other-registry.mock', methodNames: ['pay_from_escrow'], allowance: null },
      { receiverId: REGISTRY, methodNames: ['withdraw_escrow'], allowance: null },
    ]) {
      ({ nonce } = await invoice());
      const agent = await newBuyer({ permission });
      await refused(await payDelegate(agent, { nonce }), nonce, agent.accountId, 'key_not_allowed');
    }

    ({ nonce } = await invoice());
    const used = await newBuyer({ nonce: 42n });
    await refused(await payDelegate(used, { nonce, delegateNonce: 42n }), nonce, used.accountId, 'stale_nonce');

    expect(chain.relayed).toHaveLength(relayedBefore);
  });

  it('escrow too low → 402 escrow_insufficient; relayPay is never called', async () => {
    const poor = await newBuyer({ escrow: (BigInt(TOTAL) - 1n).toString() });
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const res = await presentDelegate(await payDelegate(poor, { nonce }), nonce, poor.accountId);
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequiredResponse).error).toBe('escrow_insufficient');
    expect(chain.relayed).toHaveLength(relayedBefore);
  });

  it('an invoice the registry already shows paid is never relayed again: invoice_used', async () => {
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    await chain.pay({ serviceId: 1, nonce, depositYocto: TOTAL }, { kind: 'mock', accountId: buyer.accountId }); // paid directly
    const res = await presentDelegate(await payDelegate(buyer, { nonce }), nonce, buyer.accountId);
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequiredResponse).error).toBe('invoice_used');
    expect(chain.relayed).toHaveLength(relayedBefore);
  });
});

describe('gasless rail: in flight, timeouts and failures (R58 §2, per-process memory)', () => {
  it('a second request while the relay for that invoice is in flight gets settlement_pending; relayPay runs once', async () => {
    let release: () => void = () => undefined;
    chain.script = { gate: new Promise<void>((resolve) => { release = resolve; }) };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });

    const first = presentDelegate(signedDelegate, nonce, buyer.accountId);
    await until(() => chain.relayed.length === relayedBefore + 1);
    const second = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(second.status).toBe(402);
    expect(second.headers.get('retry-after')).toBe('2');
    const body = (await second.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('settlement_pending');
    expect(body.accepts[0]!.extra.nonce).toBe(nonce); // the same invoice: retry it

    release();
    expect((await first).status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('a relay timeout is settlement_pending naming the relay tx, invoice kept; the retry is served without a second relayPay', async () => {
    chain.script = {
      land: true,
      error: (txHash) => new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test'),
    };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });

    const first = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(first.status).toBe(402);
    expect(first.headers.get('retry-after')).toBe('2');
    const body = (await first.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('settlement_pending');
    const relayTx = paymentTx(nonce);
    expect(body.transaction).toBe(relayTx);
    expect(body.accepts[0]!.extra.nonce).toBe(nonce);

    // The client retries the same payload: the payment landed, so it is served, not relayed again.
    chain.script = {};
    const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
    expect(decodeXPaymentResponse(retry.headers.get('x-payment-response') ?? '').transaction).toBe(relayTx);
    await until(() => chain.attestations.some((a) => a.nonce === nonce));
    expect(chain.attestations.find((a) => a.nonce === nonce)?.paymentTxHash).toBe(relayTx);
  });

  it('while a timed-out relay may still land, the invoice is never relayed twice', async () => {
    chain.script = {
      land: false,
      error: (txHash) => new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test'),
    };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await presentDelegate(signedDelegate, nonce, buyer.accountId);
      expect(res.status).toBe(402);
      const body = (await res.json()) as PaymentRequiredResponse;
      expect(body).toMatchObject({ error: 'settlement_pending', transaction: LOST_RELAY_TX });
    }
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('the retry of a timed-out relay that landed is served even once its delegate has expired; nothing is relayed again', async () => {
    chain.script = {
      land: true,
      error: (txHash) => new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test'),
    };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });
    expect((await presentDelegate(signedDelegate, nonce, buyer.accountId)).status).toBe(402); // settlement_pending

    chain.script = {};
    const height = chain.height;
    chain.height += 200; // the buyer comes back after its delegate's max_block_height
    try {
      const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
      expect(retry.status).toBe(200);
      expect(decodeXPaymentResponse(retry.headers.get('x-payment-response') ?? '').transaction).toBe(paymentTx(nonce));
      expect(chain.relayed).toHaveLength(relayedBefore + 1);
    } finally {
      chain.height = height;
    }
  });

  it("another account's well-signed delegate for a timed-out relay's invoice is invoice_used; the relay's sender is still served", async () => {
    chain.script = {
      land: true,
      error: (txHash) => new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test'),
    };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });
    expect((await presentDelegate(signedDelegate, nonce, buyer.accountId)).status).toBe(402); // settlement_pending

    chain.script = {};
    const mallory = await newBuyer();
    const theirs = await presentDelegate(await payDelegate(mallory, { nonce }), nonce, mallory.accountId);
    expect(theirs.status).toBe(402);
    expect(((await theirs.json()) as PaymentRequiredResponse).error).toBe('invoice_used');

    const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('past its max height, a timed-out relay whose delegate NEAR ran (the key reached its nonce) stays pending: never relayed twice', async () => {
    chain.script = {
      land: false,
      error: (txHash) => new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test'),
    };
    const buyer = await newBuyer(); // key nonce 41; the delegate's is 42
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    expect((await presentDelegate(await payDelegate(buyer, { nonce }), nonce, buyer.accountId)).status).toBe(402);

    // NEAR ran the delegate (its key's nonce moved to 42); the registry's receipt has not settled yet.
    chain.script = {};
    chain.keys.set(`${buyer.accountId} ${buyer.publicKey}`, { nonce: 42n, permission: 'FullAccess' });
    const height = chain.height;
    chain.height += 200;
    try {
      const fresh = await payDelegate(buyer, { nonce, delegateNonce: 43n, maxBlockHeight: BigInt(chain.height + 100) });
      const res = await presentDelegate(fresh, nonce, buyer.accountId);
      expect(res.status).toBe(402);
      expect((await res.json()) as PaymentRequiredResponse).toMatchObject({ error: 'settlement_pending', transaction: LOST_RELAY_TX });
      expect(chain.relayed).toHaveLength(relayedBefore + 1);
    } finally {
      chain.height = height;
    }
  });

  it('past its max height, a timed-out relay whose delegate never ran is forgotten: a new delegate for the invoice is relayed', async () => {
    chain.script = {
      land: false,
      error: (txHash) => new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test'),
    };
    const buyer = await newBuyer(); // key nonce 41 stays: the delegate never ran
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    expect((await presentDelegate(await payDelegate(buyer, { nonce }), nonce, buyer.accountId)).status).toBe(402);

    chain.script = {};
    const height = chain.height;
    chain.height += 200;
    try {
      const fresh = await payDelegate(buyer, { nonce, delegateNonce: 42n, maxBlockHeight: BigInt(chain.height + 100) });
      const res = await presentDelegate(fresh, nonce, buyer.accountId);
      expect(res.status).toBe(200);
      expect(chain.relayed).toHaveLength(relayedBefore + 2);
    } finally {
      chain.height = height;
    }
  });

  it('a definitive relay failure → 402 relay_failed with the chain code; the nonce is not burned', async () => {
    chain.script = { error: contractError('ERR_ESCROW_INSUFFICIENT', 'the escrow holds 1 yocto') };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });

    const failed = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(failed.status).toBe(402);
    const body = (await failed.json()) as PaymentRequiredResponse;
    expect(body).toMatchObject({ error: 'relay_failed', code: 'ERR_ESCROW_INSUFFICIENT' });
    expect(body.accepts[0]!.extra.nonce).not.toBe(nonce); // a fresh invoice
    expect(await chain.getPayment(nonce)).toBeNull();

    // Not burned: the invoice still pays.
    chain.script = {};
    const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 2);
  });
});
