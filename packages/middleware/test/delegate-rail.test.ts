import { KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from 'near-api-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TxTimeoutError, buildEscrowPayDelegate, decodeSignedDelegate, payDelegateArgs } from '@agentgate/chain';
import {
  AgentGateError,
  PAYMENT_STORAGE_FEE_YOCTO,
  addYocto,
  decodeXPaymentResponse,
  encodeXPayment,
  type AccessKeyInfo,
  type AnySigner,
  type Logger,
  type PaymentRequiredResponse,
  type VerifyPaymentQuery,
  type VerifyResult,
  type Yocto,
} from '@agentgate/shared';
import { MemoryInvoiceStore, createApp } from '../src/index';
import { createDelegateRail, type DelegateRail } from '../src/delegate-rail';
import {
  adminMap,
  bootGateway,
  silentLogger,
  sleep,
  startUpstream,
  testConfig,
  until,
  type TestGateway,
  type TestUpstream,
} from './helpers';
import { FakeChainClient, contractError } from './fake-chain';

// The gasless rail (Task 10c, ruling R58): the gateway relays the buyer's signed NEP-366
// `pay_from_escrow` delegate. Delegates are real ones, built and signed with near-api-js; the chain
// is a fake whose relay settles the payment the way the registry would, and spends the delegate's
// nonce the way nearcore does.

const GATEWAY = 'gateway.mock';
const REGISTRY = 'registry.mock';
const PRICE = '500000000000000000000000'; // 0.5 NEAR
const TOTAL = addYocto(PRICE, PAYMENT_STORAGE_FEE_YOCTO); // what the escrow pays: price + 0.002 NEAR
const RELAY_GAS = 30_000_000_000_000n;
/** Some tx hash for a relay that timed out without landing. */
const LOST_RELAY_TX = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';
/** The gateway's own key, as a relayer-side error would name it. */
const GATEWAY_KEY = 'ed25519:8mVbzM2kC3bJmFCpEy2BeW8zhfVnFT9tdPKjE7ZKvTfH';

interface RelayScript {
  /** Rejects the relay with this error (a function gets the landed relay's tx hash). */
  error?: Error | ((txHash: string) => Error);
  /** Settles the payment on chain first (default: when no error is scripted). */
  land?: boolean;
  /** Whether NEAR ran the delegate, which spends its nonce (default: it landed, or its call failed with the registry's code). */
  spend?: boolean;
  /** The relay waits for this before doing anything. */
  gate?: Promise<void>;
  /** Runs once the relay is done on chain, before it answers (gets its tx hash). */
  afterRelay?: (txHash: string) => void | Promise<void>;
}

/** A failure of the delegate's own call (the registry ran and refused it): NEAR spent the delegate's nonce. */
function isRegistryFailure(error: RelayScript['error']): boolean {
  if (!(error instanceof AgentGateError)) return false;
  return error.code === 'CONTRACT_ERROR' || (/^ERR_/.test(error.code) && error.code !== 'ERR_INSUFFICIENT_BALANCE');
}

/** The fake registry, plus the reads the delegate rail makes and a relay that settles the payment. */
class RelayChain extends FakeChainClient {
  height = 1_000;
  /** The RPC's view of each access key, by `<account> <public key>` (both finalities, unless `optimisticKeys` says otherwise). */
  readonly keys = new Map<string, AccessKeyInfo>();
  /** The optimistic view where it differs from `keys`: a block that is not final yet. */
  readonly optimisticKeys = new Map<string, AccessKeyInfo>();
  /** What NEAR itself holds as each key's nonce once a delegate ran (the views can lag it). */
  readonly spentNonces = new Map<string, bigint>();
  /** The finality of every access key read, in order. */
  readonly keyReads: Array<'final' | 'optimistic'> = [];
  readonly escrows = new Map<string, Yocto>();
  readonly relayed: Array<{ signedDelegate: string; relayer: AnySigner }> = [];
  /** The next registry reads reject with these errors, in order (a read the RPC fails). */
  readonly readFailures: Error[] = [];
  script: RelayScript = {};

  override verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    const failure = this.readFailures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    return super.verifyPayment(q);
  }

  override blockHeight(): Promise<number> {
    return Promise.resolve(this.height);
  }

  override accessKey(accountId: string, publicKey: string, finality: 'final' | 'optimistic' = 'final'): Promise<AccessKeyInfo | null> {
    this.keyReads.push(finality);
    const id = `${accountId} ${publicKey}`;
    const key = (finality === 'optimistic' ? this.optimisticKeys.get(id) : undefined) ?? this.keys.get(id);
    return Promise.resolve(key ?? null);
  }

  override escrowOf(accountId: string): Promise<Yocto> {
    return Promise.resolve(this.escrows.get(accountId) ?? '0');
  }

  override async relayPay(signedDelegate: string, relayer: AnySigner): Promise<{ txHash: string }> {
    this.relayed.push({ signedDelegate, relayer });
    const { error, land = error === undefined, gate, afterRelay } = this.script;
    if (gate !== undefined) await gate;
    const delegate = decodeSignedDelegate(signedDelegate);
    const call = delegate?.actions[0];
    if (delegate === null || call?.kind !== 'functionCall') throw new Error('RelayChain: not a pay delegate');
    // NEAR's own nonce check (DelegateActionInvalidNonce): nothing runs, nothing is spent.
    const id = `${delegate.senderId} ${delegate.publicKey}`;
    const held = this.spentNonces.get(id) ?? this.keys.get(id)?.nonce;
    if (held !== undefined && delegate.nonce <= held) {
      throw new AgentGateError('DELEGATE_REJECTED', `NEAR rejected the relayed delegate: Invalid delegate nonce (ak: ${held}, delegate: ${delegate.nonce})`, 400);
    }
    if (this.script.spend ?? (land || isRegistryFailure(error))) {
      this.spentNonces.set(id, delegate.nonce);
      const key = this.keys.get(id);
      if (key !== undefined) this.keys.set(id, { ...key, nonce: delegate.nonce });
    }
    let txHash = LOST_RELAY_TX;
    if (land) {
      // pay_from_escrow(service_id, nonce) as the delegate's sender: the escrow pays price + fee.
      const args = JSON.parse(Buffer.from(call.args).toString('utf8')) as { service_id: number; nonce: string };
      ({ txHash } = await this.pay(
        { serviceId: args.service_id, nonce: args.nonce, depositYocto: TOTAL },
        { kind: 'mock', accountId: delegate.senderId },
      ));
    }
    if (afterRelay !== undefined) await afterRelay(txHash);
    if (error !== undefined) throw typeof error === 'function' ? error(txHash) : error;
    return { txHash };
  }
}

/** The invoice store, whose next `markUsed` calls can fail (a store that is down). */
class FlakyInvoiceStore extends MemoryInvoiceStore {
  failMarkUsed = 0;

  override markUsed(nonce: string): Promise<boolean> {
    if (this.failMarkUsed > 0) {
      this.failMarkUsed -= 1;
      return Promise.reject(new Error('the invoice store is down'));
    }
    return super.markUsed(nonce);
  }
}

interface BuyerKey {
  accountId: string;
  signer: KeyPairSigner;
  publicKey: string;
}

let gw: TestGateway | undefined;
let upstream: TestUpstream;
let chain: RelayChain;
let store: FlakyInvoiceStore | undefined;
let accounts = 0;

/** A fresh buyer account on `on`, holding a fresh key (full access unless `permission` says otherwise) and a funded escrow. */
async function newBuyer(over: Partial<AccessKeyInfo> & { escrow?: Yocto } = {}, on: RelayChain = chain): Promise<BuyerKey> {
  accounts += 1;
  const accountId = `buyer-${accounts}.mock`;
  const keyPair = KeyPair.fromRandom('ed25519');
  const publicKey = keyPair.getPublicKey().toString();
  on.keys.set(`${accountId} ${publicKey}`, { nonce: over.nonce ?? 41n, permission: over.permission ?? 'FullAccess' });
  on.escrows.set(accountId, over.escrow ?? '10000000000000000000000000'); // 10 NEAR
  return { accountId, signer: new KeyPairSigner(keyPair), publicKey };
}

/** The running gateway's base URL (each describe block boots its own: `freshGateway`). */
function baseUrl(): string {
  if (gw === undefined) throw new Error('no gateway booted for this block');
  return gw.baseUrl;
}

/** A fresh 402 invoice for service `serviceId`. */
async function invoice(serviceId = 1): Promise<{ nonce: string }> {
  const res = await fetch(`${baseUrl()}/svc/${serviceId}`);
  expect(res.status).toBe(402);
  const body = (await res.json()) as PaymentRequiredResponse;
  return { nonce: body.accepts[0]!.extra.nonce };
}

/** The buyer's signed delegate for invoice `nonce`, as the client builds it (each field overridable). */
function payDelegate(
  buyer: BuyerKey,
  over: { nonce: string; serviceId?: number; senderId?: string; delegateNonce?: bigint; maxBlockHeight?: bigint; on?: RelayChain },
): Promise<string> {
  return buildEscrowPayDelegate(buyer.signer, {
    registryId: REGISTRY,
    senderId: over.senderId ?? buyer.accountId,
    serviceId: over.serviceId ?? 1,
    nonce: over.nonce,
    delegateNonce: over.delegateNonce ?? 42n,
    maxBlockHeight: over.maxBlockHeight ?? BigInt((over.on ?? chain).height + 100),
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
  return fetch(`${baseUrl()}/svc/1`, { headers: delegateHeaders(signedDelegate, nonce, payer) });
}

/** Presents the delegate and expects a 402: its body. */
async function refusal(signedDelegate: string, nonce: string, payer: string): Promise<PaymentRequiredResponse> {
  const res = await presentDelegate(signedDelegate, nonce, payer);
  expect(res.status).toBe(402);
  return (await res.json()) as PaymentRequiredResponse;
}

/** The tx hash of the payment the (fake) registry holds for `nonce`. */
function paymentTx(nonce: string, on: RelayChain = chain): string | undefined {
  return [...on.payments.values()].find((p) => p.nonce === nonce)?.txHash;
}

function timeout(txHash: string): TxTimeoutError {
  return new TxTimeoutError('the NEAR RPC stopped waiting for the relay call', txHash, 'https://explorer.test');
}

/**
 * A fresh gateway (relayer on) over the shared chain, with service 1 mapped. Each describe block
 * gets its own, so no block runs into another's /svc rate limit (60 a minute per client).
 */
async function freshGateway(): Promise<void> {
  if (gw !== undefined) await gw.close();
  store?.close();
  store = new FlakyInvoiceStore();
  gw = await bootGateway({ config: testConfig({ relayerEnabled: true, gatewayAccountId: GATEWAY }), fake: chain, invoiceStore: store });
  expect((await adminMap(gw, 1, `${upstream.url}/data`)).status).toBe(204);
}

beforeAll(async () => {
  chain = new RelayChain();
  upstream = await startUpstream();
  chain.addService({ id: 1, name: 'Gasless Feed', priceYocto: PRICE });
  chain.addService({ id: 2, name: 'Other Feed', priceYocto: PRICE });
});

afterAll(async () => {
  await gw?.close();
  await upstream.close();
  store?.close();
});

beforeEach(() => {
  chain.script = {};
  chain.readFailures.length = 0;
  chain.optimisticKeys.clear();
  if (store !== undefined) store.failMarkUsed = 0;
});

describe('gasless rail: the offer (Task 10c)', () => {
  beforeAll(freshGateway);

  it('the 402 names the relayer (the gateway account) and the one method it relays', async () => {
    const res = await fetch(`${baseUrl()}/svc/1`);
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
  beforeAll(freshGateway);

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
  beforeAll(freshGateway);

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
      expect((await refusal(signedDelegate, nonce, payer)).error).toBe(error);
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
    expect((await refusal(await payDelegate(poor, { nonce }), nonce, poor.accountId)).error).toBe('escrow_insufficient');
    expect(chain.relayed).toHaveLength(relayedBefore);
  });

  it('an invoice the registry already shows paid is never relayed again: invoice_used', async () => {
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    await chain.pay({ serviceId: 1, nonce, depositYocto: TOTAL }, { kind: 'mock', accountId: buyer.accountId }); // paid directly
    expect((await refusal(await payDelegate(buyer, { nonce }), nonce, buyer.accountId)).error).toBe('invoice_used');
    expect(chain.relayed).toHaveLength(relayedBefore);
  });
});

describe('gasless rail: in flight, timeouts and failures (R58 §2, per-process memory)', () => {
  beforeAll(freshGateway);

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
    chain.script = { land: true, error: timeout };
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
    chain.script = { land: false, error: timeout };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await refusal(signedDelegate, nonce, buyer.accountId)).toMatchObject({ error: 'settlement_pending', transaction: LOST_RELAY_TX });
    }
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('the retry of a timed-out relay that landed is served even once its delegate has expired; nothing is relayed again', async () => {
    chain.script = { land: true, error: timeout };
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
    chain.script = { land: true, error: timeout };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });
    expect((await presentDelegate(signedDelegate, nonce, buyer.accountId)).status).toBe(402); // settlement_pending

    chain.script = {};
    const mallory = await newBuyer();
    expect((await refusal(await payDelegate(mallory, { nonce }), nonce, mallory.accountId)).error).toBe('invoice_used');

    const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('past its max height, a timed-out relay whose delegate NEAR ran (the key reached its nonce) stays pending: never relayed twice', async () => {
    chain.script = { land: false, error: timeout };
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
      expect(await refusal(fresh, nonce, buyer.accountId)).toMatchObject({ error: 'settlement_pending', transaction: LOST_RELAY_TX });
      expect(chain.relayed).toHaveLength(relayedBefore + 1);
    } finally {
      chain.height = height;
    }
  });

  it('past its max height, a timed-out relay whose key is gone may have run: it stays pending, never relayed twice', async () => {
    chain.script = { land: false, error: timeout };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    expect((await presentDelegate(await payDelegate(buyer, { nonce }), nonce, buyer.accountId)).status).toBe(402);

    // The key is gone (deleted after NEAR may have run the delegate): its nonce proves nothing either way.
    chain.script = {};
    chain.keys.delete(`${buyer.accountId} ${buyer.publicKey}`);
    const height = chain.height;
    chain.height += 200;
    try {
      const fresh = await payDelegate(buyer, { nonce, delegateNonce: 43n, maxBlockHeight: BigInt(chain.height + 100) });
      expect(await refusal(fresh, nonce, buyer.accountId)).toMatchObject({ error: 'settlement_pending', transaction: LOST_RELAY_TX });
      expect(chain.relayed).toHaveLength(relayedBefore + 1);
    } finally {
      chain.height = height;
    }
  });

  it('past its max height, a timed-out relay whose delegate never ran is forgotten: a new delegate for the invoice is relayed', async () => {
    chain.script = { land: false, error: timeout };
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

    const body = await refusal(await payDelegate(buyer, { nonce }), nonce, buyer.accountId);
    expect(body).toMatchObject({ error: 'relay_failed', code: 'ERR_ESCROW_INSUFFICIENT' });
    expect(body.accepts[0]!.extra.nonce).not.toBe(nonce); // a fresh invoice
    expect(await chain.getPayment(nonce)).toBeNull();

    // Not burned: the invoice still pays, with a new delegate (NEAR spent the first one's nonce, 42).
    chain.script = {};
    const retry = await presentDelegate(await payDelegate(buyer, { nonce, delegateNonce: 43n }), nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 2);
  });
});

describe('gasless rail: a paid buyer is never stranded by a read after the relay (fix round 1, item 1)', () => {
  beforeAll(freshGateway);

  it('the relay lands but the registry read after it fails: 402 settlement_pending naming the relay tx, never a 5xx; the retry is served, relayPay runs once', async () => {
    for (const code of ['RPC_TIMEOUT', 'RPC_ERROR', 'RPC_BAD_RESPONSE']) {
      const buyer = await newBuyer();
      const relayedBefore = chain.relayed.length;
      const { nonce } = await invoice();
      const signedDelegate = await payDelegate(buyer, { nonce });
      chain.script = {
        afterRelay: () => {
          chain.readFailures.push(new AgentGateError(code, `the NEAR RPC failed the get_payment view (${code})`, 502));
        },
      };

      const body = await refusal(signedDelegate, nonce, buyer.accountId);
      const relayTx = paymentTx(nonce);
      expect(relayTx, code).toBeDefined();
      expect(body, code).toMatchObject({ error: 'settlement_pending', transaction: relayTx });
      expect(body.accepts[0]!.extra.nonce, code).toBe(nonce); // the same invoice

      chain.script = {};
      const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
      expect(retry.status, code).toBe(200);
      expect(decodeXPaymentResponse(retry.headers.get('x-payment-response') ?? '').transaction, code).toBe(relayTx);
      expect(chain.relayed, code).toHaveLength(relayedBefore + 1);
    }
  });

  it('the registry view lags the relay (not_found, or still pending): settlement_pending naming the relay tx, then served; relayPay runs once', async () => {
    // not_found: the relay answered, its payment is not in the view yet.
    let buyer = await newBuyer();
    let relayedBefore = chain.relayed.length;
    let { nonce } = await invoice();
    let signedDelegate = await payDelegate(buyer, { nonce });
    chain.script = { land: false, spend: true };
    expect(await refusal(signedDelegate, nonce, buyer.accountId)).toMatchObject({ error: 'settlement_pending', transaction: LOST_RELAY_TX });
    chain.script = {};
    await chain.pay({ serviceId: 1, nonce, depositYocto: TOTAL }, { kind: 'mock', accountId: buyer.accountId }); // the view catches up
    let retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(decodeXPaymentResponse(retry.headers.get('x-payment-response') ?? '').transaction).toBe(LOST_RELAY_TX);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);

    // pending: the view shows the payment still settling once.
    buyer = await newBuyer();
    relayedBefore = chain.relayed.length;
    ({ nonce } = await invoice());
    signedDelegate = await payDelegate(buyer, { nonce });
    chain.script = { afterRelay: (txHash) => chain.setPending(txHash, 1) };
    expect(await refusal(signedDelegate, nonce, buyer.accountId)).toMatchObject({ error: 'settlement_pending', transaction: paymentTx(nonce) });
    chain.script = {};
    retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it("the registry's record after a relay names another payer: 402 tx_mismatch with a fresh invoice", async () => {
    const buyer = await newBuyer();
    const { nonce } = await invoice();
    chain.script = {
      land: false,
      spend: true,
      afterRelay: async () => {
        await chain.pay({ serviceId: 1, nonce, depositYocto: TOTAL }, { kind: 'mock', accountId: 'someone-else.mock' });
      },
    };
    const body = await refusal(await payDelegate(buyer, { nonce }), nonce, buyer.accountId);
    expect(body.error).toBe('tx_mismatch');
    expect(body.accepts[0]!.extra.nonce).not.toBe(nonce);
  });

  it('a registry read that throws before the relay releases the invoice: the retry is relayed and served', async () => {
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });
    chain.readFailures.push(new AgentGateError('RPC_ERROR', 'the NEAR RPC was unreachable for the get_payment view', 502));
    const failed = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(failed.status).toBe(502); // nothing was relayed: the gateway's own failure
    expect(chain.relayed).toHaveLength(relayedBefore);

    const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200); // not settlement_pending: the lock was released
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('the relay is remembered until the nonce is burned: a burn that fails leaves the retry served, not invoice_used', async () => {
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });
    store!.failMarkUsed = 1;
    expect((await presentDelegate(signedDelegate, nonce, buyer.accountId)).status).toBe(500);

    const retry = await presentDelegate(signedDelegate, nonce, buyer.accountId);
    expect(retry.status).toBe(200);
    expect(decodeXPaymentResponse(retry.headers.get('x-payment-response') ?? '').transaction).toBe(paymentTx(nonce));
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });
});

describe('gasless rail: delegate nonces (fix round 1, item 2)', () => {
  beforeAll(freshGateway);

  it('the stale_nonce check reads the key at optimistic finality (a nonce spent in a block that is not final yet); its authority at final', async () => {
    const buyer = await newBuyer(); // final view: nonce 41
    const id = `${buyer.accountId} ${buyer.publicKey}`;
    chain.optimisticKeys.set(id, { nonce: 42n, permission: 'FullAccess' }); // a relay elsewhere just used 42
    chain.spentNonces.set(id, 42n);
    const relayedBefore = chain.relayed.length;
    const readsBefore = chain.keyReads.length;
    const { nonce } = await invoice();
    expect((await refusal(await payDelegate(buyer, { nonce }), nonce, buyer.accountId)).error).toBe('stale_nonce');
    expect(chain.relayed).toHaveLength(relayedBefore);
    expect(chain.keyReads.slice(readsBefore)).toEqual(['final', 'optimistic']);
  });

  it('two invoices signed with the same delegate nonce while the first relay is in flight: the second is stale_nonce, relayPay runs once', async () => {
    let release: () => void = () => undefined;
    chain.script = { gate: new Promise<void>((resolve) => { release = resolve; }) };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const a = await invoice();
    const b = await invoice();
    const first = presentDelegate(await payDelegate(buyer, { nonce: a.nonce }), a.nonce, buyer.accountId);
    await until(() => chain.relayed.length === relayedBefore + 1);
    const releaseLater = setTimeout(release, 1_000); // never hang on a second relay waiting on the same gate
    try {
      const second = await refusal(await payDelegate(buyer, { nonce: b.nonce }), b.nonce, buyer.accountId);
      expect(second.error).toBe('stale_nonce');
      expect(second.accepts[0]!.extra.nonce).not.toBe(b.nonce);
    } finally {
      release();
      clearTimeout(releaseLater);
    }
    expect((await first).status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it("two invoices signed with the same delegate nonce after the first relay landed, while the RPC's view of the key lags: stale_nonce, relayPay runs once", async () => {
    const buyer = await newBuyer();
    const id = `${buyer.accountId} ${buyer.publicKey}`;
    const relayedBefore = chain.relayed.length;
    const a = await invoice();
    expect((await presentDelegate(await payDelegate(buyer, { nonce: a.nonce }), a.nonce, buyer.accountId)).status).toBe(200);
    chain.keys.set(id, { nonce: 41n, permission: 'FullAccess' }); // the view has not caught up with the relay yet

    const b = await invoice();
    expect((await refusal(await payDelegate(buyer, { nonce: b.nonce }), b.nonce, buyer.accountId)).error).toBe('stale_nonce');
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });

  it('two back-to-back buys with the same key, each signed above the key nonce it read: distinct nonces, both served', async () => {
    const buyer = await newBuyer();
    const id = `${buyer.accountId} ${buyer.publicKey}`;
    const relayedBefore = chain.relayed.length;
    const nonces: bigint[] = [];
    for (let buy = 0; buy < 2; buy += 1) {
      const { nonce } = await invoice();
      const read = await chain.accessKey(buyer.accountId, buyer.publicKey, 'optimistic'); // as the client reads it
      const delegateNonce = read!.nonce + 1n;
      nonces.push(delegateNonce);
      expect((await presentDelegate(await payDelegate(buyer, { nonce, delegateNonce }), nonce, buyer.accountId)).status).toBe(200);
    }
    expect(nonces).toEqual([42n, 43n]);
    expect(chain.keys.get(id)?.nonce).toBe(43n); // NEAR spent both
    expect(chain.relayed).toHaveLength(relayedBefore + 2);
  });

  it('once the relayed delegate can no longer land, the key nonce on chain decides alone: a lost relay does not block the key', async () => {
    chain.script = { land: false, error: timeout };
    const buyer = await newBuyer(); // key nonce 41 stays: the timed-out delegate (42) never runs
    const relayedBefore = chain.relayed.length;
    const a = await invoice();
    expect((await presentDelegate(await payDelegate(buyer, { nonce: a.nonce }), a.nonce, buyer.accountId)).status).toBe(402);

    chain.script = {};
    const b = await invoice();
    // While the lost relay of 42 may still land, another delegate with 42 is never relayed.
    expect((await refusal(await payDelegate(buyer, { nonce: b.nonce }), b.nonce, buyer.accountId)).error).toBe('stale_nonce');
    const height = chain.height;
    chain.height += 200; // past the lost delegate's max height: it never ran, and never will
    try {
      const c = await invoice();
      const res = await presentDelegate(await payDelegate(buyer, { nonce: c.nonce, maxBlockHeight: BigInt(chain.height + 100) }), c.nonce, buyer.accountId);
      expect(res.status).toBe(200);
      expect(chain.relayed).toHaveLength(relayedBefore + 2);
    } finally {
      chain.height = height;
    }
  });

  it('a relay NEAR never ran (a relayer-side failure) takes no nonce: the same delegate is relayed again and served', async () => {
    chain.script = { error: new AgentGateError('SIGNER_ACCOUNT_NOT_FOUND', `the signer account ${GATEWAY} does not exist on near-mock`, 400) };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    const signedDelegate = await payDelegate(buyer, { nonce });
    expect(await refusal(signedDelegate, nonce, buyer.accountId)).toMatchObject({ error: 'relay_failed', code: 'RELAYER_ERROR' });

    chain.script = {};
    expect((await presentDelegate(signedDelegate, nonce, buyer.accountId)).status).toBe(200);
    expect(chain.relayed).toHaveLength(relayedBefore + 2);
  });
});

describe('gasless rail: the retry path serves only the remembered relay (fix round 1, item 4)', () => {
  beforeAll(freshGateway);

  it("a forged-sender delegate (the payer's account, another key) for a tx-rail-paid invoice is invoice_used, even while a relay is remembered", async () => {
    chain.script = { land: false, error: timeout };
    const buyer = await newBuyer();
    const relayedBefore = chain.relayed.length;
    const { nonce } = await invoice();
    expect((await presentDelegate(await payDelegate(buyer, { nonce }), nonce, buyer.accountId)).status).toBe(402); // remembered

    // The buyer then pays the invoice itself on the tx rail; mallory signs a delegate in the buyer's name.
    chain.script = {};
    await chain.pay({ serviceId: 1, nonce, depositYocto: TOTAL }, { kind: 'mock', accountId: buyer.accountId });
    const mallory = await newBuyer();
    const forged = await payDelegate(mallory, { nonce, senderId: buyer.accountId });
    const seenBefore = upstream.seen.length;
    expect((await refusal(forged, nonce, buyer.accountId)).error).toBe('invoice_used');
    expect(upstream.seen).toHaveLength(seenBefore); // never served
    expect(chain.relayed).toHaveLength(relayedBefore + 1);
  });
});

describe('gasless rail: who a relay failure is blamed on (fix round 1, item 5)', () => {
  beforeAll(freshGateway);

  it("relayer-side failures reach the buyer as relay_failed RELAYER_ERROR, never the gateway's key or account; NEAR's and the registry's verdicts keep their code", async () => {
    const cases: Array<[Error, string]> = [
      [new AgentGateError('SIGNER_KEY_NOT_FOUND', `${GATEWAY_KEY} is not an access key of ${GATEWAY} on near-mock`, 400), 'RELAYER_ERROR'],
      [new AgentGateError('SIGNER_ACCOUNT_NOT_FOUND', `the signer account ${GATEWAY} does not exist on near-mock`, 400), 'RELAYER_ERROR'],
      [new AgentGateError('ERR_INSUFFICIENT_BALANCE', `ERR_INSUFFICIENT_BALANCE: ${GATEWAY} has 1 yocto, the transaction needs 9 yocto (deposit + gas)`, 400), 'RELAYER_ERROR'],
      [new AgentGateError('TX_FAILED', 'NEAR rejected the pay_from_escrow relay call: Transaction has expired', 502), 'RELAYER_ERROR'],
      [new AgentGateError('RPC_ERROR', 'the NEAR RPC was unreachable for the pay_from_escrow relay call', 502), 'RELAYER_ERROR'],
      [new Error('socket hang up'), 'RELAYER_ERROR'],
      [new AgentGateError('DELEGATE_REJECTED', 'NEAR rejected the relayed delegate: Delegate action has expired', 400), 'DELEGATE_REJECTED'],
      [contractError('ERR_SERVICE_INACTIVE', 'the service is switched off'), 'ERR_SERVICE_INACTIVE'],
      [new AgentGateError('CONTRACT_ERROR', 'the registry contract failed: Exceeded the prepaid gas.', 502), 'CONTRACT_ERROR'],
    ];
    for (const [error, code] of cases) {
      chain.script = { error };
      const buyer = await newBuyer();
      const { nonce } = await invoice();
      const body = await refusal(await payDelegate(buyer, { nonce }), nonce, buyer.accountId);
      expect(body, error.message).toMatchObject({ error: 'relay_failed', code });
      expect(JSON.stringify(body), error.message).not.toContain(GATEWAY_KEY);
    }
  });
});

describe('gasless rail: memory and logs (fix round 1, items 7 and 8)', () => {
  const SERVICE = { id: 1, name: 'Gasless Feed', priceYocto: PRICE };
  let railChain: RelayChain;
  let logs: Array<{ level: string; msg: string; fields: Record<string, unknown> }>;
  let rail: DelegateRail;
  let invoices = 9_000;

  function capture(): Logger {
    const log = (level: string) => (msg: string, fields: Record<string, unknown> = {}): void => {
      logs.push({ level, msg, fields });
    };
    const logger: Logger = { name: 'rail', level: 'debug', debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), child: () => logger };
    return logger;
  }

  beforeEach(() => {
    railChain = new RelayChain();
    railChain.addService(SERVICE);
    logs = [];
    rail = createDelegateRail({ chain: railChain, relayer: { kind: 'mock', accountId: GATEWAY }, maxAgeMs: 300_000, logger: capture() });
  });

  async function settle(buyer: BuyerKey, nonce: string, signedDelegate?: string) {
    const service = (await railChain.getService(1))!;
    return rail.settle({ service, nonce, signedDelegate: signedDelegate ?? (await payDelegate(buyer, { nonce, on: railChain })), payer: buyer.accountId });
  }

  it('a paid relay stays remembered until the invoice is served: served(nonce) forgets it', async () => {
    const buyer = await newBuyer({}, railChain);
    invoices += 1;
    const nonce = String(invoices);
    expect(await settle(buyer, nonce)).toMatchObject({ kind: 'paid', payer: buyer.accountId });
    expect(rail.remembered(nonce)).toMatchObject({ txHash: paymentTx(nonce, railChain) });
    rail.served(nonce);
    expect(rail.remembered(nonce)).toBeUndefined();
  });

  it('a relay its registry record can never serve is forgotten once its delegate can no longer land', async () => {
    railChain.script = { land: true, error: timeout };
    const buyer = await newBuyer({}, railChain);
    invoices += 1;
    const nonce = String(invoices);
    const signedDelegate = await payDelegate(buyer, { nonce, on: railChain });
    expect(await settle(buyer, nonce, signedDelegate)).toMatchObject({ kind: 'pending' });
    // Someone attested the payment meanwhile: the record is no longer one the gateway can serve.
    const payment = [...railChain.payments.values()].find((p) => p.nonce === nonce)!;
    payment.attested = true;

    railChain.script = {};
    expect(await settle(buyer, nonce, signedDelegate)).toEqual({ kind: 'refused', error: 'invoice_used' });
    expect(rail.remembered(nonce)).toBeDefined(); // its delegate may still land
    railChain.height += 200;
    expect(await settle(buyer, nonce, signedDelegate)).toEqual({ kind: 'refused', error: 'invoice_used' });
    expect(rail.remembered(nonce)).toBeUndefined();
  });

  it('a failed relay is logged with its code and a clipped message, its keys redacted; never the delegate', async () => {
    const detail = `${GATEWAY_KEY} is not an access key of ${GATEWAY} on near-mock; ${'x'.repeat(1_000)}`;
    railChain.script = { error: new AgentGateError('SIGNER_KEY_NOT_FOUND', detail, 400) };
    const buyer = await newBuyer({}, railChain);
    invoices += 1;
    const nonce = String(invoices);
    const signedDelegate = await payDelegate(buyer, { nonce, on: railChain });
    expect(await settle(buyer, nonce, signedDelegate)).toEqual({ kind: 'refused', error: 'relay_failed', code: 'RELAYER_ERROR' });

    const entry = logs.find((l) => l.msg === 'relay_failed');
    expect(entry?.level).toBe('warn');
    expect(entry?.fields).toMatchObject({ serviceId: 1, nonce, code: 'SIGNER_KEY_NOT_FOUND' });
    const message = String(entry?.fields['message']);
    expect(message).toContain(`is not an access key of ${GATEWAY}`);
    expect(message.length).toBeLessThanOrEqual(301);
    const everything = JSON.stringify(logs);
    expect(everything).not.toContain(GATEWAY_KEY);
    expect(everything).not.toContain(buyer.publicKey);
    expect(everything).not.toContain(signedDelegate);
  });

  it('a registry read that fails after the relay is logged and keeps the relay remembered', async () => {
    const buyer = await newBuyer({}, railChain);
    invoices += 1;
    const nonce = String(invoices);
    railChain.script = {
      afterRelay: () => {
        railChain.readFailures.push(new AgentGateError('RPC_TIMEOUT', 'the NEAR RPC timed out on the get_payment view', 504));
      },
    };
    const outcome = await settle(buyer, nonce);
    expect(outcome).toEqual({ kind: 'pending', transaction: paymentTx(nonce, railChain) });
    expect(rail.remembered(nonce)).toMatchObject({ txHash: paymentTx(nonce, railChain) });
    expect(logs.find((l) => l.msg === 'relay_record_unread')?.fields).toMatchObject({ nonce, code: 'RPC_TIMEOUT' });
    await sleep(0);
  });
});
