import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KeyPair,
  KeyPairSigner,
  PublicKey,
  actions,
  baseEncode,
  buildDelegateAction,
  decodeSignedTransaction,
  encodeSignedDelegate,
  encodeTransaction,
} from 'near-api-js';
import type { Transaction } from 'near-api-js';
import { ContractExecutionError, HostGuestPanicError, RpcError } from 'near-api-js/rpc-errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentGateError,
  REGISTRATION_DEPOSIT_YOCTO,
  chainErrorCode,
  loadConfig,
  nativeNearOption,
  nearToYocto,
} from '@agentgate/shared';
import type { AgentGateConfig, NearKeySigner, VerifyPaymentQuery } from '@agentgate/shared';
import {
  LiveNearClient,
  TxTimeoutError,
  buildEscrowPayDelegate,
  createChainClient,
  decodeSignedDelegate,
  loadNearSigner,
  mapContractPanic,
  payDelegateArgs,
  provisionAgentKey,
  verifyDelegateSignature,
} from '../src/index';
import { CALL_TIMEOUT_MS } from '../src/near-live';
import { RPC_READ_TIMEOUT_MS } from '../src/near-rpc';

// The NEAR RPC is a fake `fetch` answering with JSON-RPC envelopes from test/fixtures/near/
// (shapes per near-api-js 7.4.0 and the NEAR RPC docs; values synthetic). No network access.

// Fixtures are free-form JSON-RPC envelopes; tests edit them in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const RPC_URL = 'https://rpc.testnet.near.org';
const REGISTRY = 'neargate-registry.testnet';
const SELLER = 'seller.testnet';
const PAYOUT = 'seller-payout.testnet';
const GATEWAY = 'gateway.testnet';
const BUYER = 'buyer.testnet';
const NONCE = '4242';
const PRICE = nearToYocto('0.5');
const DEPOSIT = nearToYocto('0.502');
const GAS_30_TGAS = 30_000_000_000_000n;
const T0 = Date.UTC(2026, 10, 11, 9, 0, 0); // view-get-service.json created_at_ms
const PAID_AT = T0 + 3_600_000; // view-get-payment.json timestamp_ms

const FIXTURES = new URL('./fixtures/near/', import.meta.url);

/** A fresh copy of a fixture envelope. */
function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/** The JSON value a call_function fixture carries (its `result.result` bytes, decoded). */
function viewValue(name: string): Json {
  return JSON.parse(Buffer.from(fixture(name).result.result as number[]).toString('utf8'));
}

/** A call_function envelope for `value`, in the recorded fixture's shape. */
function callResult(value: unknown): Json {
  const envelope = fixture('view-null.json');
  envelope.result.result = Array.from(Buffer.from(JSON.stringify(value), 'utf8'));
  return envelope;
}

/** Base64 JSON args, as the RPC shows a FunctionCall action's `args`. */
function encodeArgs(args: unknown): string {
  return Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
}

/** A `tx` fixture with its transaction view edited. */
function txWith(name: string, edit: (tx: Json) => void): Json {
  const envelope = fixture(name);
  edit(envelope.result.transaction);
  return envelope;
}

/** The send_tx failure fixture with another contract panic in place of ERR_NONCE_USED. */
function sendTxPanic(panic: string): Json {
  const text = JSON.stringify(fixture('send-tx-failure-nonce-used.json')).replaceAll(
    'ERR_NONCE_USED: nonce already paid',
    panic,
  );
  return JSON.parse(text);
}

interface RpcCall {
  method: string;
  params: Json;
}

type Reply = Json | ((call: RpcCall) => Json | Response | Promise<Json | Response>);

interface SentTx {
  tx: Transaction;
  hash: string;
  signatureValid: boolean;
  waitUntil: string;
}

/**
 * A send_tx answer: a fixture name or envelope, an HTTP error status (`httpError`), no answer
 * ever (`hang`), or a connection that drops once the tx is out (`reset`).
 */
type SendTxReply = string | Json | { httpStatus: number; body: string } | 'hang' | 'reset';

/** send_tx answered with HTTP `status` (the body is a fixture name). */
function httpError(status: number, body: string): SendTxReply {
  return { httpStatus: status, body };
}

/** How Node's fetch fails when the connection drops: TypeError "fetch failed", the network code under it. */
function connectionReset(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
}

/** A fake NEAR JSON-RPC endpoint: routes by method (last registration wins) and records every call. */
class FakeRpc {
  readonly calls: RpcCall[] = [];
  readonly urls: string[] = [];
  readonly unmatched: RpcCall[] = [];
  readonly sent: SentTx[] = [];
  private readonly routes: Array<{ match: (call: RpcCall) => boolean; reply: Reply }> = [];

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.urls.push(String(input));
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Json };
    const call: RpcCall = { method: body.method, params: body.params };
    this.calls.push(call);
    const route = this.routes.find((r) => r.match(call));
    if (route === undefined) {
      this.unmatched.push(call);
      return json({ jsonrpc: '2.0', id: body.id, error: { name: 'UNMATCHED_BY_FAKE_RPC' } });
    }
    const out = typeof route.reply === 'function' ? await route.reply(call) : route.reply;
    if (out instanceof Response) return out;
    return json({ ...out, id: body.id });
  });

  on(match: (call: RpcCall) => boolean, reply: Reply): this {
    this.routes.unshift({ match, reply });
    return this;
  }

  method(name: string, reply: Reply): this {
    return this.on((call) => call.method === name, reply);
  }

  query(requestType: string, reply: Reply): this {
    return this.on((call) => call.method === 'query' && call.params.request_type === requestType, reply);
  }

  view(methodName: string, reply: Reply): this {
    return this.on(
      (call) =>
        call.method === 'query' && call.params.request_type === 'call_function' && call.params.method_name === methodName,
      reply,
    );
  }

  /**
   * send_tx: decodes and checks each signed tx (its hash re-derived from the signed bytes), then
   * answers with the next of `replies` (the last one repeats), the real tx hash swapped in.
   */
  sendTx(...replies: SendTxReply[]): this {
    const queue: SendTxReply[] = replies.length > 0 ? replies : ['send-tx-success.json'];
    let answered = 0;
    return this.method('send_tx', (call: RpcCall) => {
      const signed = decodeSignedTransaction(Buffer.from(String(call.params.signed_tx_base64), 'base64'));
      const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(signed.transaction)).digest());
      const signature = (signed.signature as unknown as { ed25519Signature: { data: number[] } }).ed25519Signature.data;
      const hash = baseEncode(digest);
      this.sent.push({
        tx: signed.transaction,
        hash,
        signatureValid: PublicKey.fromString(signed.transaction.publicKey.toString()).verify(
          digest,
          new Uint8Array(signature),
        ),
        waitUntil: String(call.params.wait_until),
      });
      const reply = queue[Math.min(answered++, queue.length - 1)];
      if (reply === 'hang') return new Promise<Response>(() => {});
      if (reply === 'reset') throw connectionReset();
      if (typeof reply === 'object' && reply !== null && typeof reply.httpStatus === 'number') {
        return json(fixture(String(reply.body)), reply.httpStatus);
      }
      const envelope = typeof reply === 'string' ? fixture(reply) : structuredClone(reply);
      if (envelope.result?.transaction !== undefined) {
        envelope.result.transaction.hash = hash;
        envelope.result.transaction_outcome.id = hash;
      }
      return envelope;
    });
  }

  callsTo(method: string): RpcCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  viewCalls(methodName: string): RpcCall[] {
    return this.calls.filter(
      (call) => call.method === 'query' && call.params.request_type === 'call_function' && call.params.method_name === methodName,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The JSON args of a call_function query. */
function decodeArgs(call: RpcCall): Json {
  return JSON.parse(Buffer.from(String(call.params.args_base64), 'base64').toString('utf8'));
}

function liveConfig(env: Record<string, string> = {}): AgentGateConfig {
  return loadConfig({
    AGENTGATE_MODE: 'live',
    AGENTGATE_ADMIN_TOKEN: 'strong-token-for-tests',
    REGISTRY_CONTRACT_ID: REGISTRY,
    ...env,
  });
}

/** A NEAR signer with a fresh random key: never a committed key. */
function nearSigner(accountId: string): { signer: NearKeySigner; publicKey: string; secretKey: string } {
  const keyPair = KeyPair.fromRandom('ed25519');
  const secretKey = keyPair.toString();
  return { signer: { kind: 'near', accountId, secretKey }, publicKey: keyPair.getPublicKey().toString(), secretKey };
}

async function rejection(promise: Promise<unknown>): Promise<AgentGateError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentGateError);
    return error as AgentGateError;
  }
  throw new Error('expected the call to reject');
}

function onlyFunctionCall(sent: SentTx): { methodName: string; args: Json; gas: bigint; deposit: bigint } {
  expect(sent.tx.actions).toHaveLength(1);
  const call = sent.tx.actions[0]?.functionCall;
  if (call === undefined) throw new Error('expected a FunctionCall action');
  return {
    methodName: call.methodName,
    args: JSON.parse(Buffer.from(call.args).toString('utf8')),
    gas: call.gas,
    deposit: call.deposit,
  };
}

let rpc: FakeRpc;
let client: LiveNearClient;

beforeEach(() => {
  rpc = new FakeRpc();
  rpc.method('status', fixture('status.json'));
  rpc.method('block', fixture('block-final.json'));
  rpc.query('view_access_key', fixture('view-access-key-full.json'));
  vi.stubGlobal('fetch', rpc.fetch);
  client = new LiveNearClient(liveConfig());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(rpc.unmatched).toEqual([]);
  expect(rpc.urls.every((url) => url === RPC_URL)).toBe(true);
});

describe('LiveNearClient construction', () => {
  it('reports near-<network> and the configured registry', () => {
    expect(client.network).toBe('near-testnet');
    expect(client.registryId).toBe(REGISTRY);
    expect(new LiveNearClient(liveConfig({ NEAR_NETWORK: 'mainnet', REGISTRY_CONTRACT_ID: 'neargate.near' })).network).toBe(
      'near-mainnet',
    );
  });

  it('throws CONFIG_INVALID for an empty registry contract id, before any RPC', () => {
    expect(() => new LiveNearClient({ ...liveConfig(), registryContractId: '' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringMatching(/REGISTRY_CONTRACT_ID/) }),
    );
    expect(() => createChainClient(liveConfig({ REGISTRY_CONTRACT_ID: '' }))).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(() => new LiveNearClient({ ...liveConfig(), registryContractId: 'Not A Registry' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(rpc.fetch).not.toHaveBeenCalled();
  });

  it('createChainClient gives a LiveNearClient in live mode', () => {
    expect(createChainClient(liveConfig())).toBeInstanceOf(LiveNearClient);
  });

  it('ping checks the RPC serves the configured chain', async () => {
    await expect(client.ping()).resolves.toBeUndefined();
    const mainnet = fixture('status.json');
    mainnet.result.chain_id = 'mainnet';
    rpc.method('status', mainnet);
    await expect(client.ping()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('LiveNearClient registry views', () => {
  it('getService maps the ServiceView: endpointUrl = base + /svc/<id>, priceYocto = the near option', async () => {
    rpc.view('get_service', fixture('view-get-service.json'));
    expect(await client.getService(1)).toStrictEqual({
      id: 1,
      name: 'USD/IDR Feed',
      description: 'Live USD/IDR mid rate, refreshed every minute',
      endpointUrl: 'https://gateway.example.org/svc/1',
      priceYocto: PRICE,
      paymentTarget: PAYOUT,
      owner: SELLER,
      attestor: GATEWAY,
      active: true,
      createdAt: T0,
      accepts: [
        { asset: 'usdc.fakes.testnet', amount: '500000', decimals: 6, symbol: 'USDC' },
        { asset: 'near', amount: PRICE, decimals: 24, symbol: 'NEAR' },
      ],
    });
    const [call] = rpc.viewCalls('get_service');
    expect(call?.params).toMatchObject({ account_id: REGISTRY, finality: 'final' });
    expect(decodeArgs(call!)).toEqual({ service_id: 1 });
  });

  it('getService is null for an unknown id and rejects a malformed id before any RPC', async () => {
    rpc.view('get_service', fixture('view-null.json'));
    expect(await client.getService(99)).toBeNull();
    const calls = rpc.calls.length;
    await expect(client.getService(0)).rejects.toMatchObject({ code: 'invalid_query', httpStatus: 400 });
    await expect(client.getService(1.5)).rejects.toMatchObject({ code: 'invalid_query' });
    expect(rpc.calls).toHaveLength(calls);
  });

  it('a service without a native NEAR price is not offered: getService null, listServices skips it', async () => {
    const usdcOnly = { ...viewValue('view-get-service.json'), id: 2, accepts: [{ asset: 'usdc.fakes.testnet', amount: '1', decimals: 6, symbol: 'USDC' }] };
    rpc.view('get_service', callResult(usdcOnly));
    expect(await client.getService(2)).toBeNull();
    rpc.view('services_count', callResult(2));
    rpc.view('list_services', callResult([viewValue('view-get-service.json'), usdcOnly]));
    expect((await client.listServices()).map((s) => s.id)).toEqual([1]);
  });

  it('listServices pages list_services 50 at a time up to services_count()', async () => {
    const base = viewValue('view-get-service.json');
    const all = Array.from({ length: 51 }, (_, i) => ({ ...base, id: i + 1, name: `svc ${i + 1}` }));
    rpc.view('services_count', callResult(51));
    rpc.view('list_services', (call: RpcCall) => {
      const { from_index: from, limit } = decodeArgs(call) as { from_index: number; limit: number };
      return callResult(all.slice(from - 1, from - 1 + Math.min(limit, 50)));
    });
    const services = await client.listServices();
    expect(services.map((s) => s.id)).toEqual(all.map((s) => s.id));
    expect(services[50]).toMatchObject({ name: 'svc 51', endpointUrl: 'https://gateway.example.org/svc/51' });
    expect(rpc.viewCalls('list_services').map(decodeArgs)).toEqual([
      { from_index: 1, limit: 50 },
      { from_index: 51, limit: 50 },
    ]);
    expect([...rpc.viewCalls('services_count'), ...rpc.viewCalls('list_services')].map((c) => c.params.finality)).toEqual(
      ['final', 'final', 'final'],
    );

    rpc.view('services_count', callResult(0));
    const before = rpc.viewCalls('list_services').length;
    expect(await client.listServices()).toEqual([]);
    expect(rpc.viewCalls('list_services')).toHaveLength(before);
  });

  it('getScore and listAttestations map the contract views', async () => {
    rpc.view('get_score', fixture('view-get-score.json'));
    rpc.view('get_attestations', fixture('view-get-attestations.json'));
    expect(await client.getScore(1)).toStrictEqual({ totalCalls: 3, successCalls: 2 });
    const payTx = fixture('tx-pay-final.json').result.transaction.hash as string;
    const all = await client.listAttestations(1);
    expect(all).toStrictEqual([
      { serviceId: 1, nonce: '4242', paymentTxHash: payTx, success: true, timestamp: PAID_AT + 60_000 },
      { serviceId: 1, nonce: '4141', paymentTxHash: expect.any(String), success: false, timestamp: T0 + 1_860_000 },
    ]);
    expect(await client.listAttestations(1, 1)).toStrictEqual([all[0]]);
    expect(decodeArgs(rpc.viewCalls('get_attestations')[0]!)).toEqual({ service_id: 1 });
    expect(rpc.viewCalls('get_score')[0]?.params.finality).toBe('final');
    await expect(client.listAttestations(1, 0)).rejects.toMatchObject({ code: 'invalid_limit', httpStatus: 400 });
  });

  it('listRecentActivity: txHash null, nonce and paymentTxHash from the contract, the feed detail strings', async () => {
    rpc.view('get_recent_activity', fixture('view-get-recent-activity.json'));
    const payTx = fixture('tx-pay-final.json').result.transaction.hash as string;
    const height = fixture('view-null.json').result.block_height as number;
    expect(await client.listRecentActivity()).toStrictEqual([
      {
        kind: 'attestation',
        serviceId: 1,
        account: GATEWAY,
        txHash: null,
        blockHeight: height - 10,
        success: true,
        nonce: NONCE,
        paymentTxHash: payTx,
        timestamp: PAID_AT + 60_000,
        detail: 'attested service #1 — success',
      },
      {
        kind: 'payment',
        serviceId: 1,
        account: BUYER,
        txHash: null,
        blockHeight: height - 40,
        amountYocto: PRICE,
        nonce: NONCE,
        timestamp: PAID_AT,
        detail: 'buyer.testnet paid 0.5 NEAR to service #1',
      },
      {
        kind: 'service_registered',
        serviceId: 1,
        account: SELLER,
        txHash: null,
        blockHeight: height - 3_000,
        timestamp: T0,
        detail: 'service #1 registered by seller.testnet',
      },
    ]);
    await client.listRecentActivity(500);
    expect(rpc.viewCalls('get_recent_activity').map(decodeArgs)).toEqual([{ limit: 50 }, { limit: 200 }]);
    expect(rpc.viewCalls('get_recent_activity')[0]?.params.finality).toBe('final');
    await expect(client.listRecentActivity(0)).rejects.toMatchObject({ code: 'invalid_limit' });
  });

  it('an attestation that failed reads "— failure"', async () => {
    const [attestation] = viewValue('view-get-recent-activity.json') as Json[];
    rpc.view('get_recent_activity', callResult([{ ...attestation, success: false }]));
    expect((await client.listRecentActivity(1))[0]).toMatchObject({ success: false, detail: 'attested service #1 — failure' });
  });

  it('listRecentActivity skips an entry of a kind this client does not know', async () => {
    const [attestation, payment] = viewValue('view-get-recent-activity.json') as Json[];
    rpc.view('get_recent_activity', callResult([{ ...attestation, kind: 'service_status' }, payment]));
    expect((await client.listRecentActivity()).map((event) => event.kind)).toEqual(['payment']);
  });

  it('decoders reject a view off the ABI: a u64 as a string, an amount as a number, a non-number services_count', async () => {
    rpc.view('get_service', callResult({ ...viewValue('view-get-service.json'), id: '1' }));
    await expect(client.getService(1)).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    rpc.view('get_payment', callResult({ ...viewValue('view-get-payment.json'), amount: Number(PRICE) }));
    await expect(client.getPayment(NONCE)).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    rpc.view('services_count', callResult('3'));
    await expect(client.listServices()).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    expect(rpc.viewCalls('list_services')).toHaveLength(0);
  });

  it('getPayment reads with optimistic finality; null when the registry has none', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    expect(await client.getPayment(NONCE)).toStrictEqual({
      nonce: NONCE,
      serviceId: 1,
      payer: BUYER,
      amountYocto: PRICE,
      timestamp: PAID_AT,
      blockHeight: (fixture('view-null.json').result.block_height as number) - 40,
      selfPaid: false,
      attested: false,
    });
    const [call] = rpc.viewCalls('get_payment');
    expect(call?.params.finality).toBe('optimistic');
    expect(decodeArgs(call!)).toEqual({ nonce: NONCE });

    rpc.view('get_payment', fixture('view-null.json'));
    expect(await client.getPayment('777')).toBeNull();
    const calls = rpc.calls.length;
    expect(await client.getPayment('not-a-nonce')).toBeNull(); // the registry only stores 1–20 digit nonces
    expect(rpc.calls).toHaveLength(calls);
    await expect(client.getPayment('')).rejects.toMatchObject({ code: 'invalid_query' });
  });

  it('getBalance reads view_account; an account that does not exist holds 0', async () => {
    rpc.query('view_account', fixture('view-account.json'));
    expect(await client.getBalance(BUYER)).toBe('12345678901234567890123456');
    expect(rpc.callsTo('query').at(-1)?.params).toMatchObject({ request_type: 'view_account', account_id: BUYER, finality: 'final' });
    rpc.query('view_account', fixture('error-unknown-account.json'));
    expect(await client.getBalance('ghost.testnet')).toBe('0');
  });

  it('escrowOf reads the escrow_of view with optimistic finality and returns the yocto string', async () => {
    rpc.view('escrow_of', fixture('view-escrow-of.json'));
    expect(await client.escrowOf(BUYER)).toBe('498000000000000000000000');
    const [call] = rpc.viewCalls('escrow_of');
    // optimistic, like get_payment: a deposit counts as soon as its tx executes
    expect(call?.params).toMatchObject({ account_id: REGISTRY, finality: 'optimistic' });
    expect(decodeArgs(call!)).toEqual({ account_id: BUYER });
    rpc.view('escrow_of', callResult('0')); // an account that never deposited
    expect(await client.escrowOf('ghost.testnet')).toBe('0');
  });

  it('escrowOf rejects a view off the ABI (a number, a negative, a leading zero) and a malformed id before any RPC', async () => {
    for (const odd of [498, '-1', '007', '1.5', null, { escrow: '1' }]) {
      rpc.view('escrow_of', callResult(odd));
      await expect(client.escrowOf(BUYER)).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    }
    const calls = rpc.calls.length;
    const err = await rejection(client.escrowOf('Not An Account'));
    expect(err).toMatchObject({ code: 'ERR_INVALID_ACCOUNT_ID', httpStatus: 400 });
    expect(err.message).toMatch(/^ERR_INVALID_ACCOUNT_ID: accountId is not a valid NEAR account id/);
    expect(rpc.calls).toHaveLength(calls);
  });

  it('accountExists: true via view_account, false on UNKNOWN_ACCOUNT, other RPC errors throw', async () => {
    rpc.query('view_account', fixture('view-account.json'));
    expect(await client.accountExists(PAYOUT)).toBe(true);
    rpc.query('view_account', fixture('error-unknown-account.json'));
    expect(await client.accountExists('ghost.testnet')).toBe(false);
    rpc.query('view_account', fixture('error-internal.json'));
    await expect(client.accountExists(PAYOUT)).rejects.toMatchObject({ code: 'RPC_ERROR', httpStatus: 502 });
  });

  it('isFullAccessKey: true only for permission FullAccess', async () => {
    const key = nearSigner(SELLER).publicKey;
    expect(await client.isFullAccessKey(SELLER, key)).toBe(true);
    expect(rpc.callsTo('query').at(-1)?.params).toMatchObject({
      request_type: 'view_access_key',
      account_id: SELLER,
      public_key: key,
      finality: 'final',
    });
    rpc.query('view_access_key', fixture('view-access-key-function-call.json'));
    expect(await client.isFullAccessKey(SELLER, key)).toBe(false);
    rpc.query('view_access_key', fixture('view-access-key-unknown.json'));
    expect(await client.isFullAccessKey(SELLER, key)).toBe(false);
    rpc.query('view_access_key', fixture('error-unknown-account.json'));
    expect(await client.isFullAccessKey('ghost.testnet', key)).toBe(false);
    const calls = rpc.calls.length;
    expect(await client.isFullAccessKey(SELLER, 'ed25519:not-a-key')).toBe(false);
    expect(rpc.calls).toHaveLength(calls);
  });

  it('isFullAccessKey fails closed: a permission it does not know is RPC_BAD_RESPONSE, never a quiet answer', async () => {
    const key = nearSigner(SELLER).publicKey;
    for (const permission of ['SomethingElse', 42, undefined]) {
      const odd = fixture('view-access-key-full.json');
      odd.result.permission = permission;
      rpc.query('view_access_key', odd);
      await expect(client.isFullAccessKey(SELLER, key)).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    }
  });

  it('rejects malformed account ids with ERR_INVALID_ACCOUNT_ID before any RPC', async () => {
    for (const promise of [
      client.getBalance('Not An Account'),
      client.accountExists('a'),
      client.isFullAccessKey('UPPER.testnet', nearSigner(SELLER).publicKey),
    ]) {
      const err = await rejection(promise);
      expect(err).toMatchObject({ code: 'ERR_INVALID_ACCOUNT_ID', httpStatus: 400 });
      expect(err.message).toMatch(/^ERR_INVALID_ACCOUNT_ID: accountId is not a valid NEAR account id/);
    }
    expect(rpc.fetch).not.toHaveBeenCalled();
  });

  it('a registry account without the contract surfaces NOT_DEPLOYED', async () => {
    rpc.view('get_service', fixture('error-no-contract-code.json'));
    await expect(client.getService(1)).rejects.toMatchObject({ code: 'NOT_DEPLOYED', httpStatus: 503 });
    const noRegistryAccount = fixture('error-unknown-account.json');
    noRegistryAccount.error.cause.info.requested_account_id = REGISTRY;
    rpc.view('get_service', noRegistryAccount);
    await expect(client.getService(1)).rejects.toMatchObject({ code: 'NOT_DEPLOYED', httpStatus: 503 });
  });

  it('a view that panics keeps the contract code (legacy result.error shape)', async () => {
    rpc.view('get_score', fixture('view-error-guest-panic.json'));
    const err = await rejection(client.getScore(1));
    expect(err).toMatchObject({ code: 'ERR_SERVICE_NOT_FOUND', message: 'ERR_SERVICE_NOT_FOUND: no such service' });
  });

  it('transport failures are RPC_ERROR and never echo the RPC URL', async () => {
    rpc.view('get_service', () => new Response('upstream down', { status: 502 }));
    const err = await rejection(client.getService(1));
    expect(err).toMatchObject({ code: 'RPC_ERROR', httpStatus: 502 });
    expect(err.message).not.toContain('rpc.testnet.near.org');
  });

  it('a view answered with HTTP 408 stays RPC_TIMEOUT once near-api-js stops retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rpc.view('get_service', () => json(fixture('error-timeout.json'), 408));
    const pending = rejection(client.getService(1));
    await vi.advanceTimersByTimeAsync(5_000); // 4 attempts, 0.5 + 1 + 2 s apart
    expect(await pending).toMatchObject({ code: 'RPC_TIMEOUT', httpStatus: 504 });
    expect(rpc.viewCalls('get_service')).toHaveLength(4);
  });

  it('a read the RPC never answers fails with RPC_TIMEOUT', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rpc.view('get_service', () => new Promise<Response>(() => {}));
    const pending = rejection(client.getService(1));
    await vi.advanceTimersByTimeAsync(RPC_READ_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ code: 'RPC_TIMEOUT', httpStatus: 504 });
  });
});

describe('LiveNearClient.verifyPayment', () => {
  const payTx = (): string => fixture('tx-pay-final.json').result.transaction.hash as string;
  const query = (over: Partial<VerifyPaymentQuery> = {}): VerifyPaymentQuery => ({
    nonce: NONCE,
    serviceId: 1,
    minAmountYocto: PRICE,
    maxAgeMs: 300_000,
    txHash: payTx(),
    payer: BUYER,
    ...over,
  });
  const payment = (over: Json = {}): Json => callResult({ ...viewValue('view-get-payment.json'), ...over });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PAID_AT + 60_000);
  });

  it('verify ok returns payer, amount, selfPaid once the tx is a successful pay of this nonce', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    rpc.method('tx', fixture('tx-pay-final.json'));
    expect(await client.verifyPayment(query())).toStrictEqual({
      ok: true,
      amountYocto: PRICE,
      payer: BUYER,
      timestamp: PAID_AT,
      selfPaid: false,
    });
    expect(rpc.viewCalls('get_payment')[0]?.params.finality).toBe('optimistic');
    expect(rpc.callsTo('tx')[0]?.params).toEqual({ tx_hash: payTx(), sender_account_id: BUYER, wait_until: 'NONE' });

    rpc.view('get_payment', payment({ self_paid: true }));
    expect(await client.verifyPayment(query())).toMatchObject({ ok: true, selfPaid: true });
  });

  it('verify returns pending when the pay tx is in flight or executed but the payment is not yet visible', async () => {
    rpc.view('get_payment', fixture('view-null.json'));
    rpc.method('tx', fixture('tx-pay-started.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
    rpc.method('tx', fixture('tx-pay-final.json')); // executed, but this view has not caught up yet
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
  });

  it('a status-only tx reply: NONE (no record of the tx yet) is not_found, INCLUDED is pending', async () => {
    rpc.view('get_payment', fixture('view-null.json'));
    rpc.method('tx', fixture('tx-none.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'not_found' });
    const included = fixture('tx-none.json');
    included.result.final_execution_status = 'INCLUDED';
    rpc.method('tx', included);
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
  });

  it('with no payer in the query, the tx is looked up under the payer the registry recorded', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    rpc.method('tx', fixture('tx-pay-final.json'));
    expect(await client.verifyPayment(query({ payer: undefined }))).toMatchObject({ ok: true, payer: BUYER });
    expect(rpc.callsTo('tx')[0]?.params).toEqual({ tx_hash: payTx(), sender_account_id: BUYER, wait_until: 'NONE' });
  });

  it('a tx with several actions passes when one is the matching pay; tx_mismatch when its pay names another nonce', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    const transfer = { Transfer: { deposit: '1' } };
    rpc.method('tx', txWith('tx-pay-final.json', (tx) => {
      tx.actions = [transfer, tx.actions[0]];
    }));
    expect(await client.verifyPayment(query())).toMatchObject({ ok: true, payer: BUYER });
    rpc.method('tx', txWith('tx-pay-final.json', (tx) => {
      const pay = tx.actions[0];
      tx.actions = [transfer, { FunctionCall: { ...pay.FunctionCall, args: encodeArgs({ service_id: 1, nonce: '9999' }) } }];
    }));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
  });

  it('a successful pay_from_escrow tx verifies exactly like a pay tx (same receiver, signer, args rule)', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    rpc.method('tx', fixture('tx-pay-from-escrow-final.json'));
    expect(await client.verifyPayment(query())).toStrictEqual({
      ok: true,
      amountYocto: PRICE,
      payer: BUYER,
      timestamp: PAID_AT,
      selfPaid: false,
    });
    // still in flight → pending; not yet visible to the view → pending; failed → tx_mismatch
    rpc.method('tx', fixture('tx-pay-started.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
    rpc.view('get_payment', fixture('view-null.json'));
    rpc.method('tx', fixture('tx-pay-from-escrow-final.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
  });

  it('pay_from_escrow keeps the args rule: another nonce or service, the wrong signer or receiver is tx_mismatch', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    const variants: Array<(tx: Json) => void> = [
      (tx) => {
        tx.actions[0].FunctionCall.args = encodeArgs({ service_id: 1, nonce: '9999' });
      },
      (tx) => {
        tx.actions[0].FunctionCall.args = encodeArgs({ service_id: 2, nonce: NONCE });
      },
      (tx) => {
        tx.signer_id = 'mallory.testnet';
      },
      (tx) => {
        tx.receiver_id = 'other-registry.testnet';
      },
    ];
    for (const edit of variants) {
      rpc.method('tx', txWith('tx-pay-from-escrow-final.json', edit));
      expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
    }
    // and no other registry method passes for a payment, however its args look
    for (const method of ['deposit_escrow', 'withdraw_escrow', 'pay_from_escrows', 'Pay', 'record_attestation']) {
      rpc.method('tx', txWith('tx-pay-from-escrow-final.json', (tx) => {
        tx.actions[0].FunctionCall.method_name = method;
      }));
      expect(await client.verifyPayment(query()), method).toEqual({ ok: false, reason: 'tx_mismatch' });
    }
    // a failed pay_from_escrow (not a failed `pay`) is no payment either
    rpc.method('tx', txWith('tx-pay-failed.json', (tx) => {
      tx.actions[0].FunctionCall.method_name = 'pay_from_escrow';
    }));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
  });

  it('verify returns not_found when tx unknown', async () => {
    rpc.view('get_payment', fixture('view-null.json'));
    rpc.method('tx', fixture('error-unknown-transaction.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('not_found without a tx to wait on, or when the pay tx failed', async () => {
    rpc.view('get_payment', fixture('view-null.json'));
    expect(await client.verifyPayment(query({ txHash: undefined }))).toEqual({ ok: false, reason: 'not_found' });
    expect(rpc.callsTo('tx')).toHaveLength(0);
    rpc.method('tx', fixture('tx-pay-failed.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('verify rejects tx whose pay args do not match (tx_mismatch)', async () => {
    const otherNonce = txWith('tx-pay-final.json', (tx) => {
      tx.actions[0].FunctionCall.args = encodeArgs({ service_id: 1, nonce: '9999' });
    });
    rpc.method('tx', otherNonce);
    rpc.view('get_payment', fixture('view-get-payment.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
    rpc.view('get_payment', fixture('view-null.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
  });

  it('tx_mismatch when the tx is not this payer paying this service on this registry', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    const variants: Array<(tx: Json) => void> = [
      (tx) => {
        tx.signer_id = 'mallory.testnet';
      },
      (tx) => {
        tx.receiver_id = 'other-registry.testnet';
      },
      (tx) => {
        tx.actions[0].FunctionCall.method_name = 'record_attestation';
      },
      (tx) => {
        tx.actions[0].FunctionCall.args = encodeArgs({ service_id: 2, nonce: NONCE });
      },
      (tx) => {
        tx.actions = ['CreateAccount'];
      },
    ];
    for (const edit of variants) {
      rpc.method('tx', txWith('tx-pay-final.json', edit));
      expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
    }
    // the presented payer is not the one the registry recorded
    expect(await client.verifyPayment(query({ payer: 'mallory.testnet' }))).toEqual({ ok: false, reason: 'tx_mismatch' });
    // the presented tx failed (e.g. a second pay of an already-paid nonce)
    rpc.method('tx', fixture('tx-pay-failed.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'tx_mismatch' });
  });

  it('pending while the registry holds the payment but the RPC cannot show the tx yet', async () => {
    rpc.view('get_payment', fixture('view-get-payment.json'));
    rpc.method('tx', fixture('error-unknown-transaction.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
    rpc.method('tx', fixture('tx-pay-started.json'));
    expect(await client.verifyPayment(query())).toEqual({ ok: false, reason: 'pending' });
  });

  it('checks wrong_service, then amount_too_low, then expired, then already_attested (registry record first)', async () => {
    const cases: Array<[Json, Partial<VerifyPaymentQuery>, string]> = [
      [{ service_id: 2, amount: '1', timestamp_ms: 0, attested: true }, {}, 'wrong_service'],
      [{ amount: '1', timestamp_ms: 0, attested: true }, {}, 'amount_too_low'],
      [{ timestamp_ms: 0, attested: true }, {}, 'expired'],
      [{ attested: true }, {}, 'already_attested'],
    ];
    for (const [over, q, reason] of cases) {
      rpc.view('get_payment', payment(over));
      expect(await client.verifyPayment(query(q))).toEqual({ ok: false, reason });
    }
    expect(rpc.callsTo('tx')).toHaveLength(0);
  });

  it('rejects malformed queries before any RPC', async () => {
    const bad: Array<[Partial<VerifyPaymentQuery>, string]> = [
      [{ nonce: 'abc' }, 'invalid_query'],
      [{ serviceId: 0 }, 'invalid_query'],
      [{ minAmountYocto: '1.5' }, 'invalid_query'],
      [{ maxAgeMs: -1 }, 'invalid_query'],
      [{ txHash: 'not-a-tx-hash' }, 'invalid_query'],
      [{ payer: 'Mallory' }, 'ERR_INVALID_ACCOUNT_ID'],
    ];
    for (const [over, code] of bad) {
      await expect(client.verifyPayment(query(over))).rejects.toMatchObject({ code, httpStatus: 400 });
    }
    expect(rpc.fetch).not.toHaveBeenCalled();
  });
});

describe('LiveNearClient change calls', () => {
  it('pay signs pay(service_id, nonce) to the registry with the deposit and 30 TGas, and returns the tx hash', async () => {
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    const result = await client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, buyer.signer);

    expect(rpc.sent).toHaveLength(1);
    const sent = rpc.sent[0]!;
    expect(result).toEqual({ txHash: sent.hash });
    expect(sent.signatureValid).toBe(true);
    expect(sent.waitUntil).toBe('EXECUTED_OPTIMISTIC');
    expect(sent.tx.signerId).toBe(BUYER);
    expect(sent.tx.receiverId).toBe(REGISTRY);
    expect(sent.tx.publicKey.toString()).toBe(buyer.publicKey);
    expect(sent.tx.nonce).toBe(BigInt(fixture('view-access-key-full.json').result.nonce) + 1n);
    expect(baseEncode(Uint8Array.from(sent.tx.blockHash))).toBe(fixture('block-final.json').result.header.hash);
    expect(onlyFunctionCall(sent)).toEqual({
      methodName: 'pay',
      args: { service_id: 1, nonce: NONCE },
      gas: GAS_30_TGAS,
      deposit: BigInt(DEPOSIT),
    });
    // the chain id is checked before anything is signed; the nonce comes from the signer's own key
    expect(rpc.calls[0]?.method).toBe('status');
    expect(rpc.calls.at(-1)?.method).toBe('send_tx');
    expect(rpc.callsTo('query')[0]?.params).toMatchObject({ request_type: 'view_access_key', account_id: BUYER, public_key: buyer.publicKey });
  });

  it('registerService attaches REGISTRATION_DEPOSIT_YOCTO, sends the native option, waits FINAL, returns the id', async () => {
    rpc.sendTx('send-tx-register-success.json');
    const seller = nearSigner(SELLER);
    const result = await client.registerService(
      {
        name: 'USD/IDR Feed',
        description: 'Live USD/IDR mid rate',
        gatewayBaseUrl: 'https://gateway.example.org',
        priceYocto: PRICE,
        paymentTarget: PAYOUT,
        attestor: GATEWAY,
      },
      seller.signer,
    );
    const sent = rpc.sent[0]!;
    expect(result).toEqual({ serviceId: 7, txHash: sent.hash });
    expect(sent.waitUntil).toBe('FINAL');
    expect(sent.tx.signerId).toBe(SELLER);
    expect(onlyFunctionCall(sent)).toEqual({
      methodName: 'register_service',
      args: {
        name: 'USD/IDR Feed',
        description: 'Live USD/IDR mid rate',
        gateway_base_url: 'https://gateway.example.org',
        accepts: [nativeNearOption(PRICE)],
        payment_target: PAYOUT,
        attestor: GATEWAY,
      },
      gas: GAS_30_TGAS,
      deposit: BigInt(REGISTRATION_DEPOSIT_YOCTO),
    });
  });

  it('recordAttestation and setActive send no deposit and 30 TGas', async () => {
    rpc.sendTx();
    const gateway = nearSigner(GATEWAY);
    const payTx = fixture('tx-pay-final.json').result.transaction.hash as string;
    await client.recordAttestation({ serviceId: 1, nonce: NONCE, paymentTxHash: payTx, success: true }, gateway.signer);
    await client.setActive(1, false, nearSigner(SELLER).signer);
    const [attest, pause] = rpc.sent;
    expect(onlyFunctionCall(attest!)).toEqual({
      methodName: 'record_attestation',
      args: { service_id: 1, nonce: NONCE, payment_tx_hash: payTx, success: true },
      gas: GAS_30_TGAS,
      deposit: 0n,
    });
    expect(attest!.waitUntil).toBe('EXECUTED_OPTIMISTIC');
    expect(onlyFunctionCall(pause!)).toEqual({
      methodName: 'set_active',
      args: { service_id: 1, active: false },
      gas: GAS_30_TGAS,
      deposit: 0n,
    });
    expect(pause!.waitUntil).toBe('FINAL');
  });

  it('a contract panic keeps its ERR_* code verbatim: pay → ERR_NONCE_USED', async () => {
    rpc.sendTx('send-tx-failure-nonce-used.json');
    const err = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    expect(err.code).toBe('ERR_NONCE_USED');
    expect(err.message).toMatch(/^ERR_NONCE_USED: nonce already paid/);
    expect(err.message).toContain(rpc.sent[0]!.hash); // the failed tx, to look up
    expect(err.httpStatus).toBe(400);
    expect(chainErrorCode(err)).toBe('ERR_NONCE_USED');
  });

  it('attesting an already-attested payment surfaces ERR_ALREADY_ATTESTED', async () => {
    rpc.sendTx(sendTxPanic('ERR_ALREADY_ATTESTED: this payment is already attested'));
    const err = await rejection(
      client.recordAttestation({ serviceId: 1, nonce: NONCE, paymentTxHash: 'tx', success: true }, nearSigner(GATEWAY).signer),
    );
    expect(err).toMatchObject({ code: 'ERR_ALREADY_ATTESTED', httpStatus: 400 });
    expect(err.message).toMatch(/^ERR_ALREADY_ATTESTED: this payment is already attested/);
    expect(chainErrorCode(err)).toBe('ERR_ALREADY_ATTESTED');
  });

  it('NEAR rejecting an unfunded tx surfaces ERR_INSUFFICIENT_BALANCE', async () => {
    rpc.sendTx('error-not-enough-balance.json');
    const err = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    expect(err).toMatchObject({ code: 'ERR_INSUFFICIENT_BALANCE', httpStatus: 400 });
    expect(err.message).toBe(
      'ERR_INSUFFICIENT_BALANCE: buyer.testnet has 100000000000000000000000 yocto, the transaction needs 502310000000000000000000 yocto (deposit + gas)',
    );
  });

  it('send_tx answered with HTTP 408 is TX_TIMEOUT naming the signed tx, which may still land', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rpc.sendTx(httpError(408, 'error-timeout.json'));
    const pending = rejection(client.setActive(1, true, nearSigner(SELLER).signer));
    await vi.advanceTimersByTimeAsync(5_000); // near-api-js re-sends on 408: 4 attempts, 0.5 + 1 + 2 s apart
    const err = await pending;
    // every attempt carried the same signed bytes: one tx, never a second one
    expect(rpc.sent).toHaveLength(4);
    const hash = rpc.sent[0]!.hash;
    expect(new Set(rpc.sent.map((sent) => sent.hash))).toEqual(new Set([hash]));
    expect(err).toBeInstanceOf(TxTimeoutError);
    expect(err).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: hash });
    expect(err.message).toBe(
      `the NEAR RPC stopped waiting for the set_active call: tx ${hash} may still land; ` +
        `check https://testnet.nearblocks.io/txns/${hash} before retrying`,
    );
  });

  it('a TIMEOUT_ERROR body from send_tx is TX_TIMEOUT naming the tx as well', async () => {
    rpc.sendTx('error-timeout.json');
    const err = await rejection(client.setActive(1, true, nearSigner(SELLER).signer));
    expect(err).toBeInstanceOf(TxTimeoutError);
    expect(err).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: rpc.sent[0]!.hash });
  });

  it('a 408 before anything is signed stays RPC_TIMEOUT: nothing was sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rpc.query('view_access_key', () => json(fixture('error-timeout.json'), 408));
    rpc.sendTx();
    const pending = rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ code: 'RPC_TIMEOUT', httpStatus: 504 });
    expect(rpc.sent).toHaveLength(0);
  });

  it("once its tx is signed, any answer short of NEAR's verdict on it is TX_TIMEOUT naming that tx (R45)", async () => {
    const buyer = nearSigner(BUYER).signer;
    const cases: Array<[SendTxReply, string]> = [
      // near-api-js's own 502 error names the RPC URL; the lead never does
      [httpError(502, 'error-internal.json'), 'the NEAR RPC failed (HTTP 502) after the pay tx was sent'],
      [httpError(429, 'error-internal.json'), 'the NEAR RPC failed (HTTP 429) after the pay tx was sent'],
      ['reset', 'the NEAR RPC connection failed (ECONNRESET) after the pay tx was sent'],
      ['error-request-routed.json', 'the NEAR RPC forwarded the pay tx to another node without waiting for its outcome'],
      ['error-internal.json', 'the NEAR RPC failed (node is overloaded) after the pay tx was sent'],
      [{ jsonrpc: '2.0' }, 'the NEAR RPC gave no usable answer after the pay tx was sent'],
      [{ jsonrpc: '2.0', result: { final_execution_status: 'INCLUDED' } }, "the NEAR RPC answered the pay call without the tx's outcome"],
    ];
    for (const [i, [reply, lead]] of cases.entries()) {
      rpc.sendTx(reply);
      const err = await rejection(client.pay({ serviceId: 1, nonce: String(5000 + i), depositYocto: DEPOSIT }, buyer));
      const hash = rpc.sent.at(-1)!.hash;
      expect(err).toBeInstanceOf(TxTimeoutError);
      expect(err).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: hash });
      expect(err.message).toBe(`${lead}: tx ${hash} may still land; check https://testnet.nearblocks.io/txns/${hash} before retrying`);
    }
    expect(rpc.sent).toHaveLength(cases.length); // one tx per call, none sent twice
  });

  it("NEAR's verdict on a signed tx keeps its code: rejected (InvalidTx), or landed and failed (R45)", async () => {
    const buyer = nearSigner(BUYER);
    const invalidTx = (kind: Json): Json => {
      const envelope = fixture('error-not-enough-balance.json');
      envelope.error.data.TxExecutionError.InvalidTxError = kind;
      return envelope;
    };
    const noDetail = fixture('error-not-enough-balance.json');
    delete noDetail.error.data; // INVALID_TRANSACTION alone
    const failed = (kind: Json): Json => {
      const envelope = fixture('send-tx-failure-nonce-used.json');
      envelope.result.status = { Failure: { ActionError: { index: 0, kind } } };
      return envelope;
    };
    const cases: Array<[SendTxReply, string, RegExp]> = [
      // rejected: the tx will not land
      ['error-not-enough-balance.json', 'ERR_INSUFFICIENT_BALANCE', /^ERR_INSUFFICIENT_BALANCE: buyer\.testnet has /],
      [invalidTx('Expired'), 'TX_FAILED', /^NEAR rejected the pay call: /],
      [invalidTx('InvalidSignature'), 'TX_FAILED', /^NEAR rejected the pay call: /],
      [
        invalidTx({ InvalidAccessKeyError: { AccessKeyNotFound: { account_id: BUYER, public_key: buyer.publicKey } } }),
        'SIGNER_KEY_NOT_FOUND',
        /is not an access key of buyer\.testnet/,
      ],
      [noDetail, 'TX_FAILED', /^NEAR rejected the pay call: Invalid transaction$/],
      // landed and failed
      ['send-tx-failure-nonce-used.json', 'ERR_NONCE_USED', /^ERR_NONCE_USED: nonce already paid/],
      [failed({ FunctionCallError: { MethodResolveError: 'MethodNotFound' } }), 'NOT_DEPLOYED', /is not a deployed neargate-registry/],
    ];
    for (const [i, [reply, code, message]] of cases.entries()) {
      rpc.sendTx(reply);
      const err = await rejection(client.pay({ serviceId: 1, nonce: String(6000 + i), depositYocto: DEPOSIT }, buyer.signer));
      expect(err).not.toBeInstanceOf(TxTimeoutError);
      expect(err.code).toBe(code);
      expect(err.message).toMatch(message);
    }
    expect(rpc.sent).toHaveLength(cases.length);
  });

  it('the same 502 or dropped connection before the tx is signed is RPC_ERROR: nothing was sent (R45)', async () => {
    rpc.sendTx();
    rpc.query('view_access_key', () => new Response('upstream down', { status: 502 }));
    const badGateway = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    expect(badGateway).toMatchObject({ code: 'RPC_ERROR', httpStatus: 502, message: 'the NEAR RPC answered HTTP 502 to the pay call' });
    rpc.query('view_access_key', () => {
      throw connectionReset();
    });
    const dropped = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    expect(dropped).toMatchObject({ code: 'RPC_ERROR', httpStatus: 502, message: 'the NEAR RPC was unreachable for the pay call (ECONNRESET)' });
    expect(rpc.sent).toHaveLength(0);
  });

  it('past its 120 s bound a call is TX_TIMEOUT once its tx is signed, RPC_TIMEOUT before, and never sends later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rpc.sendTx('hang');
    const signedThenStuck = rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 1);
    const late = await signedThenStuck;
    expect(late).toBeInstanceOf(TxTimeoutError);
    expect(late).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: rpc.sent[0]!.hash });

    let releaseBlock = (): void => {};
    rpc.method('block', () => new Promise<Json>((resolve) => {
      releaseBlock = () => resolve(fixture('block-final.json'));
    }));
    const neverSigned = rejection(client.pay({ serviceId: 1, nonce: '4243', depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 1);
    const early = await neverSigned;
    expect(early).toMatchObject({ code: 'RPC_TIMEOUT', httpStatus: 504 });
    expect(early.message).toMatch(/nothing was sent/);
    releaseBlock(); // the given-up call carries on in the background: it must not sign or send
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rpc.sent).toHaveLength(1);
  });

  it('an InvalidNonce rejection is re-signed with a fresh nonce and goes through', async () => {
    const stale = BigInt(fixture('view-access-key-full.json').result.nonce);
    const moved = fixture('view-access-key-full.json');
    moved.result.nonce = Number(stale + 5n); // another client used the key meanwhile
    rpc.query('view_access_key', () => (rpc.sent.length === 0 ? fixture('view-access-key-full.json') : moved));
    rpc.sendTx('error-invalid-nonce.json', 'send-tx-success.json');
    const result = await client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer);
    expect(rpc.sent.map((sent) => sent.tx.nonce)).toEqual([stale + 1n, stale + 6n]);
    expect(rpc.sent.every((sent) => sent.signatureValid)).toBe(true);
    expect(result).toEqual({ txHash: rpc.sent[1]!.hash });
    expect(rpc.callsTo('query').filter((call) => call.params.request_type === 'view_access_key')).toHaveLength(2);
  });

  it('NEAR refusing a tx that leaves an account short of its storage stake is ERR_INSUFFICIENT_BALANCE (R16)', async () => {
    rpc.sendTx('error-lack-balance-for-state.json');
    const err = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    expect(err).toMatchObject({ code: 'ERR_INSUFFICIENT_BALANCE', httpStatus: 400 });
    expect(err.message).toBe(
      'ERR_INSUFFICIENT_BALANCE: buyer.testnet cannot cover its storage after this transaction (1820000000000000000000 yocto required)',
    );
    expect(chainErrorCode(err)).toBe('ERR_INSUFFICIENT_BALANCE');

    // the same failure inside an executed tx (an ActionError) also names that tx
    const failed = fixture('send-tx-failure-nonce-used.json');
    failed.result.status = {
      Failure: { ActionError: { index: 0, kind: { LackBalanceForState: { account_id: BUYER, amount: '1820000000000000000000' } } } },
    };
    rpc.sendTx(failed);
    const inTx = await rejection(client.pay({ serviceId: 1, nonce: '4243', depositYocto: DEPOSIT }, nearSigner(BUYER).signer));
    expect(inTx).toMatchObject({ code: 'ERR_INSUFFICIENT_BALANCE', httpStatus: 400 });
    expect(inTx.message).toMatch(/^ERR_INSUFFICIENT_BALANCE: buyer\.testnet cannot cover its storage/);
    expect(inTx.message).toContain(`(tx ${rpc.sent.at(-1)!.hash})`);
  });

  it('a key that is not on the signer account is SIGNER_KEY_NOT_FOUND; nothing is sent', async () => {
    rpc.query('view_access_key', fixture('view-access-key-unknown.json'));
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    const err = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, buyer.signer));
    expect(err).toMatchObject({ code: 'SIGNER_KEY_NOT_FOUND', httpStatus: 400 });
    expect(err.message).toContain(buyer.publicKey);
    expect(err.message).toContain(BUYER);
    rpc.query('view_access_key', fixture('error-unknown-account.json'));
    await expect(
      client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner('ghost.testnet').signer),
    ).rejects.toMatchObject({ code: 'SIGNER_ACCOUNT_NOT_FOUND', httpStatus: 400 });
    expect(rpc.sent).toHaveLength(0);
  });

  it('refuses to sign when the RPC serves another chain', async () => {
    const mainnet = fixture('status.json');
    mainnet.result.chain_id = 'mainnet';
    rpc.method('status', mainnet);
    rpc.sendTx();
    await expect(
      client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, nearSigner(BUYER).signer),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(rpc.callsTo('send_tx')).toHaveLength(0);
    expect(rpc.callsTo('query')).toHaveLength(0);
  });

  it('rejects bad signers and arguments before any RPC (ERR_INVALID_ACCOUNT_ID for account ids)', async () => {
    const seller = nearSigner(SELLER).signer;
    const input = {
      name: 'svc',
      description: '',
      gatewayBaseUrl: 'https://gateway.example.org',
      priceYocto: PRICE,
      paymentTarget: PAYOUT,
      attestor: GATEWAY,
    };
    const cases: Array<[Promise<unknown>, string, RegExp?]> = [
      [client.registerService({ ...input, paymentTarget: 'Payout!' }, seller), 'ERR_INVALID_ACCOUNT_ID', /^ERR_INVALID_ACCOUNT_ID: paymentTarget /],
      [client.registerService({ ...input, attestor: '' }, seller), 'ERR_INVALID_ACCOUNT_ID', /^ERR_INVALID_ACCOUNT_ID: attestor /],
      [client.registerService({ ...input, priceYocto: '-1' }, seller), 'INVALID_AMOUNT'],
      [client.registerService(input, { ...seller, accountId: 'Seller' }), 'ERR_INVALID_ACCOUNT_ID', /^ERR_INVALID_ACCOUNT_ID: signer /],
      [client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, { kind: 'mock', accountId: 'buyer.mock' }), 'invalid_signer'],
      [client.pay({ serviceId: 1, nonce: NONCE, depositYocto: '0.5' }, seller), 'invalid_query'],
      [client.pay({ serviceId: -1, nonce: NONCE, depositYocto: DEPOSIT }, seller), 'invalid_query'],
      [client.recordAttestation({ serviceId: 0, nonce: NONCE, paymentTxHash: 'x', success: true }, seller), 'invalid_query'],
      [client.setActive(1, true, { kind: 'near', accountId: 'x' }), 'ERR_INVALID_ACCOUNT_ID'],
    ];
    for (const [promise, code, message] of cases) {
      const err = await rejection(promise);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(400);
      if (message !== undefined) expect(err.message).toMatch(message);
    }
    expect(rpc.fetch).not.toHaveBeenCalled();
  });

  it('never puts the secret key in an error', async () => {
    const paying = nearSigner(BUYER);
    rpc.sendTx('send-tx-failure-nonce-used.json');
    const contractErr = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, paying.signer));
    const unknownKey = nearSigner(BUYER);
    rpc.query('view_access_key', fixture('view-access-key-unknown.json'));
    const keyErr = await rejection(client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, unknownKey.signer));
    expect([contractErr.code, keyErr.code]).toEqual(['ERR_NONCE_USED', 'SIGNER_KEY_NOT_FOUND']);
    for (const [err, key] of [[contractErr, paying], [keyErr, unknownKey]] as const) {
      const secret = key.secretKey.slice('ed25519:'.length);
      expect(err.message).not.toContain(secret);
      expect(String(err.stack)).not.toContain(secret);
      expect(JSON.stringify(err)).not.toContain(secret);
    }
  });

  it('one key signs consecutive nonces: its access key is read once', async () => {
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    await client.pay({ serviceId: 1, nonce: NONCE, depositYocto: DEPOSIT }, buyer.signer);
    await client.pay({ serviceId: 1, nonce: '4243', depositYocto: DEPOSIT }, buyer.signer);
    const [first, second] = rpc.sent;
    expect(second!.tx.nonce).toBe(first!.tx.nonce + 1n);
    expect(rpc.callsTo('query').filter((c) => c.params.request_type === 'view_access_key')).toHaveLength(1);
    expect(rpc.callsTo('status')).toHaveLength(1);
  });
});

describe('LiveNearClient escrow change calls', () => {
  const ESCROW_DEPOSIT = nearToYocto('1');

  it('depositEscrow signs deposit_escrow() with the amount attached and 30 TGas, and returns the tx hash', async () => {
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    const result = await client.depositEscrow(ESCROW_DEPOSIT, buyer.signer);
    const sent = rpc.sent[0]!;
    expect(result).toEqual({ txHash: sent.hash });
    expect(sent.signatureValid).toBe(true);
    expect(sent.waitUntil).toBe('EXECUTED_OPTIMISTIC');
    expect(sent.tx.signerId).toBe(BUYER);
    expect(sent.tx.receiverId).toBe(REGISTRY);
    expect(onlyFunctionCall(sent)).toEqual({
      methodName: 'deposit_escrow',
      args: {},
      gas: GAS_30_TGAS,
      deposit: BigInt(ESCROW_DEPOSIT),
    });
  });

  it('withdrawEscrow signs withdraw_escrow(amount) with exactly 1 yocto attached and 30 TGas', async () => {
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    const amount = nearToYocto('0.25');
    const result = await client.withdrawEscrow(amount, buyer.signer);
    const sent = rpc.sent[0]!;
    expect(result).toEqual({ txHash: sent.hash });
    expect(sent.waitUntil).toBe('EXECUTED_OPTIMISTIC');
    expect(onlyFunctionCall(sent)).toEqual({
      methodName: 'withdraw_escrow',
      args: { amount }, // a U128: a decimal string
      gas: GAS_30_TGAS,
      deposit: 1n,
    });
  });

  it('payFromEscrow signs pay_from_escrow(service_id, nonce) with 0 attached and 30 TGas, as a function-call key', async () => {
    rpc.query('view_access_key', fixture('view-access-key-agent.json'));
    rpc.sendTx();
    const agent = nearSigner(BUYER);
    const result = await client.payFromEscrow({ serviceId: 1, nonce: NONCE }, agent.signer);
    const sent = rpc.sent[0]!;
    expect(result).toEqual({ txHash: sent.hash });
    expect(sent.signatureValid).toBe(true);
    expect(sent.waitUntil).toBe('EXECUTED_OPTIMISTIC');
    expect(sent.tx.signerId).toBe(BUYER);
    expect(sent.tx.receiverId).toBe(REGISTRY); // the one receiver a restricted key may call
    expect(sent.tx.publicKey.toString()).toBe(agent.publicKey);
    expect(sent.tx.nonce).toBe(BigInt(fixture('view-access-key-agent.json').result.nonce) + 1n);
    expect(onlyFunctionCall(sent)).toEqual({
      methodName: 'pay_from_escrow',
      args: { service_id: 1, nonce: NONCE },
      gas: GAS_30_TGAS,
      deposit: 0n, // a function-call key cannot attach a deposit
    });
  });

  it('the escrow panics keep their ERR_* code and text verbatim (Task 10a ABI)', async () => {
    const buyer = nearSigner(BUYER).signer;
    const cases: Array<[() => Promise<unknown>, string, string]> = [
      [
        () => client.depositEscrow('2000000000000000000000', buyer),
        'ERR_DEPOSIT_TOO_LOW',
        'ERR_DEPOSIT_TOO_LOW: the first deposit must be more than 2000000000000000000000 yocto (0.002 NEAR escrow storage fee)',
      ],
      [() => client.depositEscrow('1', buyer), 'ERR_DEPOSIT_TOO_LOW', 'ERR_DEPOSIT_TOO_LOW: attach a deposit'],
      [
        () => client.withdrawEscrow('5', buyer),
        'ERR_ESCROW_INSUFFICIENT',
        'ERR_ESCROW_INSUFFICIENT: the amount must be between 1 and the escrow balance, 3 yocto',
      ],
      [
        () => client.payFromEscrow({ serviceId: 1, nonce: NONCE }, buyer),
        'ERR_ESCROW_INSUFFICIENT',
        'ERR_ESCROW_INSUFFICIENT: the escrow holds 7 yocto, the payment needs 502000000000000000000000 (price + storage fee)',
      ],
      [
        () => client.withdrawEscrow('1', buyer),
        'ERR_ONE_YOCTO_REQUIRED',
        'ERR_ONE_YOCTO_REQUIRED: attach exactly 1 yocto (only a full-access key can withdraw)',
      ],
      [
        () => client.payFromEscrow({ serviceId: 1, nonce: NONCE }, buyer),
        'ERR_DEPOSIT_NOT_ALLOWED',
        'ERR_DEPOSIT_NOT_ALLOWED: pay_from_escrow takes no deposit, it spends the escrow',
      ],
    ];
    for (const [run, code, text] of cases) {
      rpc.sendTx(sendTxPanic(text));
      const err = await rejection(run());
      expect(err).toMatchObject({ code, httpStatus: 400 });
      expect(err.message.startsWith(text)).toBe(true);
      expect(chainErrorCode(err)).toBe(code);
    }
  });

  it('an agent key asked to withdraw is rejected by NEAR before execution: TX_FAILED with NEAR\'s reason, nothing else', async () => {
    rpc.query('view_access_key', fixture('view-access-key-agent.json'));
    rpc.sendTx('error-deposit-with-function-call.json');
    const err = await rejection(client.withdrawEscrow('1', nearSigner(BUYER).signer));
    expect(err).toMatchObject({ code: 'TX_FAILED', httpStatus: 502 });
    expect(err.message).toBe('NEAR rejected the withdraw_escrow call: Deposit is not allowed with function call');
    expect(rpc.sent).toHaveLength(1);
  });

  it('once signed, an unknown outcome is TX_TIMEOUT naming the tx for each escrow call (R45)', async () => {
    const buyer = nearSigner(BUYER).signer;
    const runs: Array<[string, () => Promise<unknown>]> = [
      ['deposit_escrow', () => client.depositEscrow(ESCROW_DEPOSIT, buyer)],
      ['withdraw_escrow', () => client.withdrawEscrow('1', buyer)],
      ['pay_from_escrow', () => client.payFromEscrow({ serviceId: 1, nonce: NONCE }, buyer)],
    ];
    for (const [method, run] of runs) {
      rpc.sendTx('error-timeout.json');
      const err = await rejection(run());
      const hash = rpc.sent.at(-1)!.hash;
      expect(err).toBeInstanceOf(TxTimeoutError);
      expect(err).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: hash });
      expect(err.message).toContain(`the ${method} call`);
    }
    expect(rpc.sent).toHaveLength(runs.length);
  });

  it('rejects bad signers and arguments before any RPC', async () => {
    const buyer = nearSigner(BUYER).signer;
    const cases: Array<[Promise<unknown>, string, RegExp?]> = [
      [client.depositEscrow('1.5', buyer), 'invalid_query'],
      [client.depositEscrow('-1', buyer), 'invalid_query'],
      [client.withdrawEscrow('0.5', buyer), 'invalid_query'],
      [client.withdrawEscrow('abc', buyer), 'invalid_query'],
      [client.payFromEscrow({ serviceId: 0, nonce: NONCE }, buyer), 'invalid_query'],
      [client.depositEscrow(ESCROW_DEPOSIT, { kind: 'mock', accountId: 'buyer.mock' }), 'invalid_signer'],
      [client.withdrawEscrow('1', { kind: 'mock', accountId: 'buyer.mock' }), 'invalid_signer'],
      [client.payFromEscrow({ serviceId: 1, nonce: NONCE }, { kind: 'mock', accountId: 'buyer.mock' }), 'invalid_signer'],
      [client.depositEscrow(ESCROW_DEPOSIT, { ...buyer, accountId: 'Buyer' }), 'ERR_INVALID_ACCOUNT_ID', /^ERR_INVALID_ACCOUNT_ID: signer /],
    ];
    for (const [promise, code, message] of cases) {
      const err = await rejection(promise);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(400);
      if (message !== undefined) expect(err.message).toMatch(message);
    }
    expect(rpc.fetch).not.toHaveBeenCalled();
  });

  it('never puts the secret key in an escrow error', async () => {
    const paying = nearSigner(BUYER);
    rpc.sendTx(sendTxPanic('ERR_ESCROW_INSUFFICIENT: the escrow holds 0 yocto, the payment needs 502000000000000000000000 (price + storage fee)'));
    const err = await rejection(client.payFromEscrow({ serviceId: 1, nonce: NONCE }, paying.signer));
    const secret = paying.secretKey.slice('ed25519:'.length);
    expect(err.code).toBe('ERR_ESCROW_INSUFFICIENT');
    for (const text of [err.message, String(err.stack), JSON.stringify(err)]) expect(text).not.toContain(secret);
  });
});

describe('LiveNearClient.addAgentKey and provisionAgentKey (restricted agent keys, R48)', () => {
  const ALLOWANCE = nearToYocto('0.25');
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'neargate-agent-live-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  function onlyAddKey(sent: SentTx) {
    expect(sent.tx.actions).toHaveLength(1);
    const add = sent.tx.actions[0]?.addKey;
    if (add === undefined) throw new Error('expected an AddKey action');
    // a decoded tx carries its public key as a plain {ed25519Key} object
    return { publicKey: PublicKey.from(add.publicKey as never).toString(), accessKey: add.accessKey };
  }

  it('addAgentKey sends one AddKey to the signer\'s own account: a function-call key for pay_from_escrow only, waits FINAL', async () => {
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    const agentKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const result = await client.addAgentKey({ publicKey: agentKey, allowanceYocto: ALLOWANCE }, buyer.signer);

    const sent = rpc.sent[0]!;
    expect(result).toEqual({ txHash: sent.hash });
    expect(sent.signatureValid).toBe(true);
    expect(sent.waitUntil).toBe('FINAL'); // the agent reads its key with `final` finality at once
    expect(sent.tx.signerId).toBe(BUYER);
    expect(sent.tx.receiverId).toBe(BUYER); // an AddKey goes to the account that gains the key
    expect(sent.tx.publicKey.toString()).toBe(buyer.publicKey); // signed by the account's own full-access key
    const add = onlyAddKey(sent);
    expect(add.publicKey).toBe(agentKey);
    expect(add.accessKey.permission.fullAccess).toBeUndefined();
    expect(add.accessKey.permission.functionCall).toEqual({
      receiverId: REGISTRY,
      methodNames: ['pay_from_escrow'],
      allowance: BigInt(ALLOWANCE),
    });
  });

  it('addAgentKey checks the signer, the key and the allowance before any RPC', async () => {
    const buyer = nearSigner(BUYER).signer;
    const key = KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const cases: Array<[Promise<unknown>, string]> = [
      [client.addAgentKey({ publicKey: key, allowanceYocto: ALLOWANCE }, { kind: 'mock', accountId: 'buyer.mock' }), 'invalid_signer'],
      [client.addAgentKey({ publicKey: key, allowanceYocto: ALLOWANCE }, { ...buyer, accountId: 'Buyer' }), 'ERR_INVALID_ACCOUNT_ID'],
      [client.addAgentKey({ publicKey: key, allowanceYocto: '0' }, buyer), 'INVALID_AMOUNT'],
      [client.addAgentKey({ publicKey: 'ed25519:nope', allowanceYocto: ALLOWANCE }, buyer), 'INVALID_INPUT'],
    ];
    for (const [promise, code] of cases) expect((await rejection(promise)).code).toBe(code);
    expect(rpc.fetch).not.toHaveBeenCalled();
  });

  it('the whole flow offline: the key file\'s public key is added on chain, then that file signs a pay_from_escrow as a function-call key', async () => {
    rpc.sendTx();
    const buyer = nearSigner(BUYER);
    const provisioned = await provisionAgentKey({
      client,
      signer: buyer.signer,
      allowanceYocto: ALLOWANCE,
      network: 'testnet',
    });
    expect(provisioned.keyPath).toBe(join(home, '.near-credentials', 'testnet', 'buyer.testnet.neargate-agent.json'));
    const file = JSON.parse(await readFile(provisioned.keyPath, 'utf8')) as Record<string, string>;
    const secret = file['private_key']!.slice('ed25519:'.length);
    const [addSent] = rpc.sent;
    expect(onlyAddKey(addSent!).publicKey).toBe(file['public_key']);
    expect(provisioned).toEqual({ accountId: BUYER, publicKey: file['public_key'], keyPath: provisioned.keyPath, txHash: addSent!.hash });
    // the secret is nowhere on the wire: not in the signed tx, not in any RPC request
    expect(JSON.stringify(rpc.calls)).not.toContain(secret);

    // the agent: the same file as `--key-file`, its access key a function-call key on the registry
    rpc.query('view_access_key', fixture('view-access-key-agent.json'));
    const agent = await loadNearSigner({ accountId: BUYER, keyPath: provisioned.keyPath, network: 'testnet' });
    await client.payFromEscrow({ serviceId: 1, nonce: NONCE }, agent.signer);
    const paySent = rpc.sent[1]!;
    expect(paySent.tx.publicKey.toString()).toBe(file['public_key']);
    expect(paySent.signatureValid).toBe(true);
    expect(onlyFunctionCall(paySent)).toMatchObject({ methodName: 'pay_from_escrow', deposit: 0n });
  });

  it('a NEAR failure of the AddKey keeps its code and leaves no key file behind', async () => {
    rpc.sendTx('error-not-enough-balance.json');
    const err = await rejection(
      provisionAgentKey({ client, signer: nearSigner(BUYER).signer, allowanceYocto: ALLOWANCE, network: 'testnet' }),
    );
    expect(err.code).toBe('ERR_INSUFFICIENT_BALANCE');
    await expect(stat(join(home, '.near-credentials', 'testnet', 'buyer.testnet.neargate-agent.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('an unknown outcome is TX_TIMEOUT (R45): the key file is KEPT at 0600, the error names its path and the public key, never the secret', async () => {
    rpc.sendTx('error-timeout.json');
    const keyFile = join(home, '.near-credentials', 'testnet', 'buyer.testnet.neargate-agent.json');
    const err = await rejection(
      provisionAgentKey({ client, signer: nearSigner(BUYER).signer, allowanceYocto: ALLOWANCE, network: 'testnet' }),
    );
    const hash = rpc.sent[0]!.hash;
    expect(err).toBeInstanceOf(TxTimeoutError);
    expect(err).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: hash });
    // the file is still there, still private, and holds the key the AddKey may yet add
    if (process.platform !== 'win32') expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const file = JSON.parse(await readFile(keyFile, 'utf8')) as Record<string, string>;
    expect(onlyAddKey(rpc.sent[0]!).publicKey).toBe(file['public_key']);
    // the message: the timeout's own advice (check the tx), then where the key is and what to do
    expect(err.message).toContain('the agent AddKey call');
    expect(err.message).toContain(`tx ${hash} may still land; check https://testnet.nearblocks.io/txns/${hash} before retrying`);
    expect(err.message).toContain(`public key ${file['public_key']}`);
    expect(err.message).toContain(`key file ${keyFile}`);
    expect(err.message).toContain('If that transaction failed, delete the file before retrying');
    const secret = file['private_key']!.slice('ed25519:'.length);
    for (const text of [err.message, String(err.stack), JSON.stringify(err)]) expect(text).not.toContain(secret);
    expect(JSON.stringify(rpc.calls)).not.toContain(secret);
  });

  it('while that key file is kept, a retry is refused (AGENT_KEY_EXISTS) instead of overwriting it', async () => {
    rpc.sendTx('error-timeout.json');
    const buyer = nearSigner(BUYER).signer;
    await rejection(provisionAgentKey({ client, signer: buyer, allowanceYocto: ALLOWANCE, network: 'testnet' }));
    const sent = rpc.sent.length;
    const again = await rejection(provisionAgentKey({ client, signer: buyer, allowanceYocto: ALLOWANCE, network: 'testnet' }));
    expect(again.code).toBe('AGENT_KEY_EXISTS');
    expect(rpc.sent).toHaveLength(sent); // nothing more was sent
  });
});

describe('mapContractPanic', () => {
  // Every panic code the neargate-registry contract (D2) uses, with its panic text.
  const D2_PANICS = [
    'ERR_NOT_AUTHORIZED: only the service owner may do this',
    'ERR_SERVICE_NOT_FOUND: no such service',
    'ERR_SERVICE_INACTIVE: the service is switched off',
    'ERR_EMPTY_NAME: the service name must not be blank',
    'ERR_FIELD_TOO_LONG: name is longer than 64 bytes',
    'ERR_INVALID_PRICE: accepts must hold between 1 and 4 options',
    'ERR_DEPOSIT_TOO_LOW: attach at least 120000000000000000000000 yocto (0.12 NEAR)',
    'ERR_STORAGE_EXCEEDED: the call needs 3 yocto of storage, more than its budget',
    'ERR_INVALID_NONCE: the nonce must be 1 to 20 decimal digits',
    'ERR_NONCE_USED: nonce already paid',
    'ERR_NO_NATIVE_PRICE: no "near" option',
    'ERR_PAYMENT_NOT_FOUND: no payment with this nonce',
    'ERR_PAYMENT_WRONG_SERVICE: the payment belongs to another service',
    'ERR_ALREADY_ATTESTED: this payment is already attested',
    'ERR_SELF_PAYMENT: the owner or payment target paid; it cannot be attested',
  ];

  it('maps a FunctionCallError containing ERR_NONCE_USED to an ERR_NONCE_USED AgentGateError', () => {
    // near-api-js turns {FunctionCallError: {ExecutionError: "..."}} into a ContractExecutionError with that text.
    const err = mapContractPanic(
      new ContractExecutionError('Smart contract panicked: ERR_NONCE_USED: nonce already paid', 'block', -1),
    );
    expect(err).toBeInstanceOf(AgentGateError);
    expect(err).toMatchObject({ code: 'ERR_NONCE_USED', message: 'ERR_NONCE_USED: nonce already paid', httpStatus: 400 });
  });

  it('keeps every D2 code verbatim, from each shape a panic reaches the client in', () => {
    for (const panic of D2_PANICS) {
      const code = panic.slice(0, panic.indexOf(':'));
      const debugEscaped = panic.replaceAll('"', '\\"');
      for (const source of [
        new ContractExecutionError(`Smart contract panicked: ${panic}`, 'block', -1),
        new HostGuestPanicError(panic, 'block', 1),
        new RpcError(`wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: "${debugEscaped}" }))`),
      ]) {
        const err = mapContractPanic(source);
        expect(err.code).toBe(code);
        expect(err.message).toBe(panic);
        expect(chainErrorCode(err)).toBe(code);
      }
    }
  });

  it('a failure without an ERR_* code is CONTRACT_ERROR, never a contract code', () => {
    for (const source of [
      new ContractExecutionError('Smart contract panicked: Failed to deserialize input from JSON.', 'block', -1),
      new ContractExecutionError('Exceeded the prepaid gas.', 'block', -1),
      new Error('ERR_NONCE_USED looks like a code but is not a contract panic'),
    ]) {
      const err = mapContractPanic(source);
      expect(err.code).toBe('CONTRACT_ERROR');
      expect(chainErrorCode(err)).toBeNull();
    }
  });
});

describe('LiveNearClient gasless rail: blockHeight, accessKey, signPayDelegate, relayPay (Task 10c, R58)', () => {
  const HEIGHT = 221_004_517; // block-final.json
  const AGENT_KEY_NONCE = 186_000_000_000_012n; // view-access-key-agent.json

  /** The buyer's agent key signs the delegate for invoice NONCE of service 1, as the client does. */
  async function agentDelegate(): Promise<{ b64: string; publicKey: string }> {
    rpc.query('view_access_key', fixture('view-access-key-agent.json'));
    const agent = nearSigner(BUYER);
    const b64 = await client.signPayDelegate({ serviceId: 1, nonce: NONCE }, agent.signer);
    rpc.query('view_access_key', fixture('view-access-key-full.json')); // the gateway's own key, for the relay
    return { b64, publicKey: agent.publicKey };
  }

  it("blockHeight is the final block's height", async () => {
    expect(await client.blockHeight()).toBe(HEIGHT);
    expect(rpc.callsTo('block').at(-1)?.params).toMatchObject({ finality: 'final' });
  });

  it('blockHeight is RPC_BAD_RESPONSE when the block carries no usable height', async () => {
    for (const height of [-1, '221004517', undefined]) {
      const odd = fixture('block-final.json');
      odd.result.header.height = height;
      rpc.method('block', odd);
      await expect(client.blockHeight()).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    }
  });

  it('accessKey: the nonce and permission of a full-access or a function-call key, null when there is none', async () => {
    const key = nearSigner(BUYER).publicKey;
    expect(await client.accessKey(BUYER, key)).toEqual({ nonce: 186_000_000_000_085n, permission: 'FullAccess' });
    expect(rpc.callsTo('query').at(-1)?.params).toMatchObject({
      request_type: 'view_access_key',
      account_id: BUYER,
      public_key: key,
      finality: 'final',
    });
    rpc.query('view_access_key', fixture('view-access-key-agent.json'));
    expect(await client.accessKey(BUYER, key)).toEqual({
      nonce: AGENT_KEY_NONCE,
      permission: { receiverId: REGISTRY, methodNames: ['pay_from_escrow'], allowance: '100000000000000000000000' },
    });
    const unlimited = fixture('view-access-key-agent.json');
    unlimited.result.permission.FunctionCall.allowance = null;
    unlimited.result.permission.FunctionCall.method_names = [];
    rpc.query('view_access_key', unlimited);
    expect(await client.accessKey(BUYER, key)).toEqual({
      nonce: AGENT_KEY_NONCE,
      permission: { receiverId: REGISTRY, methodNames: [], allowance: null },
    });
    rpc.query('view_access_key', fixture('view-access-key-unknown.json'));
    expect(await client.accessKey(BUYER, key)).toBeNull();
    rpc.query('view_access_key', fixture('error-unknown-account.json'));
    expect(await client.accessKey('ghost.testnet', key)).toBeNull();
    const calls = rpc.calls.length;
    expect(await client.accessKey(BUYER, 'ed25519:not-a-key')).toBeNull(); // no account holds it: no RPC
    expect(rpc.calls).toHaveLength(calls);
  });

  it('accessKey fails closed: a permission or nonce it cannot read is RPC_BAD_RESPONSE, never a quiet answer', async () => {
    const key = nearSigner(BUYER).publicKey;
    const odd: Json[] = [];
    for (const permission of ['SomethingElse', 42, { FunctionCall: { receiver_id: REGISTRY } }, { GasKey: {} }]) {
      const envelope = fixture('view-access-key-agent.json');
      envelope.result.permission = permission;
      odd.push(envelope);
    }
    const noNonce = fixture('view-access-key-full.json');
    delete noNonce.result.nonce;
    odd.push(noNonce);
    for (const envelope of odd) {
      rpc.query('view_access_key', envelope);
      await expect(client.accessKey(BUYER, key)).rejects.toMatchObject({ code: 'RPC_BAD_RESPONSE', httpStatus: 502 });
    }
  });

  it('signPayDelegate signs zero-deposit pay_from_escrow(service_id, nonce) with the key: key nonce + 1, height + 100, 30 TGas; nothing is sent', async () => {
    const { b64, publicKey } = await agentDelegate();
    const decoded = decodeSignedDelegate(b64);
    expect(decoded).toMatchObject({
      senderId: BUYER,
      receiverId: REGISTRY,
      nonce: AGENT_KEY_NONCE + 1n,
      maxBlockHeight: BigInt(HEIGHT + 100),
      publicKey,
    });
    expect(decoded?.actions).toHaveLength(1);
    expect(decoded?.actions[0]).toMatchObject({ kind: 'functionCall', methodName: 'pay_from_escrow', gas: GAS_30_TGAS, deposit: 0n });
    const call = decoded?.actions[0];
    if (call?.kind !== 'functionCall') throw new Error('expected a FunctionCall');
    expect(Buffer.from(call.args).toString('utf8')).toBe(payDelegateArgs(1, NONCE));
    expect(verifyDelegateSignature(decoded!)).toBe(true);
    // The key's nonce was read for the signing key itself, and nothing went out.
    expect(
      rpc.callsTo('query').some((c) => c.params.request_type === 'view_access_key' && c.params.public_key === publicKey),
    ).toBe(true);
    expect(rpc.callsTo('send_tx')).toEqual([]);
  });

  it('signPayDelegate: a key the account does not hold is SIGNER_KEY_NOT_FOUND, before anything is signed', async () => {
    rpc.query('view_access_key', fixture('view-access-key-unknown.json'));
    const stranger = nearSigner(BUYER);
    const err = await rejection(client.signPayDelegate({ serviceId: 1, nonce: NONCE }, stranger.signer));
    expect(err).toMatchObject({ code: 'SIGNER_KEY_NOT_FOUND', httpStatus: 400 });
    expect(err.message).toBe(`${stranger.publicKey} is not an access key of ${BUYER} on near-testnet`);
    await expect(client.signPayDelegate({ serviceId: 0, nonce: NONCE }, stranger.signer)).rejects.toMatchObject({
      code: 'invalid_query',
    });
    await expect(
      client.signPayDelegate({ serviceId: 1, nonce: NONCE }, { kind: 'mock', accountId: BUYER }),
    ).rejects.toMatchObject({ code: 'invalid_signer' });
  });

  it("relayPay sends one tx from the relayer to the delegate's sender carrying exactly the signed delegate; waits EXECUTED_OPTIMISTIC", async () => {
    const { b64 } = await agentDelegate();
    rpc.sendTx('tx-relay-ok.json');
    const gateway = nearSigner(GATEWAY);
    const result = await client.relayPay(b64, gateway.signer);
    expect(rpc.sent).toHaveLength(1);
    const sent = rpc.sent[0]!;
    expect(result).toEqual({ txHash: sent.hash });
    expect(sent.signatureValid).toBe(true);
    expect(sent.waitUntil).toBe('EXECUTED_OPTIMISTIC');
    expect(sent.tx.signerId).toBe(GATEWAY); // the relayer pays the gas
    expect(sent.tx.publicKey.toString()).toBe(gateway.publicKey);
    expect(sent.tx.receiverId).toBe(BUYER); // NEP-366: the outer tx goes to the delegate's sender
    expect(sent.tx.actions).toHaveLength(1);
    const relayed = sent.tx.actions[0]?.signedDelegate;
    if (relayed === undefined) throw new Error('expected a SignedDelegate action');
    expect(Buffer.from(encodeSignedDelegate(relayed)).toString('base64')).toBe(b64); // byte for byte what the buyer signed
  });

  it('relayPay: the inner pay_from_escrow failing under a successful outer tx keeps its ERR_* code and names the relay tx', async () => {
    const { b64 } = await agentDelegate();
    rpc.sendTx('tx-relay-inner-failed.json');
    const err = await rejection(client.relayPay(b64, nearSigner(GATEWAY).signer));
    const hash = rpc.sent[0]!.hash;
    expect(err).toMatchObject({ code: 'ERR_ESCROW_INSUFFICIENT', httpStatus: 400 });
    expect(err.message).toBe(
      'ERR_ESCROW_INSUFFICIENT: the escrow holds 1000000000000000000000 yocto, the payment needs ' +
        `502000000000000000000000 (price + storage fee) (tx ${hash})`,
    );
  });

  it('relayPay: NEAR refusing the delegate itself (a used nonce) is TX_FAILED naming the relay tx', async () => {
    const { b64 } = await agentDelegate();
    const refused = fixture('tx-relay-ok.json');
    refused.result.receipts_outcome[0].outcome.status = {
      Failure: { ActionError: { index: 0, kind: { DelegateActionInvalidNonce: { ak_nonce: 13, delegate_nonce: 13 } } } },
    };
    rpc.sendTx(refused);
    const err = await rejection(client.relayPay(b64, nearSigner(GATEWAY).signer));
    expect(err).toMatchObject({ code: 'TX_FAILED', httpStatus: 502 });
    expect(err.message).toMatch(/DelegateActionInvalidNonce/);
    expect(err.message).toContain(`(tx ${rpc.sent[0]!.hash})`);
  });

  it("relayPay: an outcome without the registry's receipt, or a timeout, is TX_TIMEOUT naming the relay tx (it may still land)", async () => {
    const { b64 } = await agentDelegate();
    const partial = fixture('tx-relay-ok.json');
    partial.result.receipts_outcome.splice(1, 1); // the registry's pay_from_escrow receipt
    rpc.sendTx(partial);
    const unseen = await rejection(client.relayPay(b64, nearSigner(GATEWAY).signer));
    expect(unseen).toBeInstanceOf(TxTimeoutError);
    expect(unseen).toMatchObject({ code: 'TX_TIMEOUT', httpStatus: 504, txHash: rpc.sent[0]!.hash });

    rpc.sendTx('error-timeout.json');
    const timedOut = await rejection(client.relayPay(b64, nearSigner(GATEWAY).signer));
    expect(timedOut).toBeInstanceOf(TxTimeoutError);
    expect(timedOut).toMatchObject({ code: 'TX_TIMEOUT', txHash: rpc.sent.at(-1)!.hash });
  });

  it('relayPay refuses, before any RPC, anything but a zero-deposit pay_from_escrow delegate to this registry', async () => {
    const agent = KeyPair.fromRandom('ed25519');
    const signer = new KeyPairSigner(agent);
    const parts = { senderId: BUYER, serviceId: 1, nonce: NONCE, delegateNonce: AGENT_KEY_NONCE + 1n, maxBlockHeight: BigInt(HEIGHT + 100) };
    const otherRegistry = await buildEscrowPayDelegate(signer, { ...parts, registryId: 'other-registry.testnet' });
    const withDeposit = await signer.signDelegateAction(
      buildDelegateAction({
        senderId: BUYER,
        receiverId: REGISTRY,
        actions: [actions.functionCall('pay_from_escrow', Buffer.from(payDelegateArgs(1, NONCE)), GAS_30_TGAS, 1n)],
        nonce: AGENT_KEY_NONCE + 1n,
        maxBlockHeight: BigInt(HEIGHT + 100),
        publicKey: agent.getPublicKey(),
      }),
    );
    const deposit = Buffer.from(encodeSignedDelegate(withDeposit.signedDelegate)).toString('base64');
    for (const b64 of ['', 'not base64!', Buffer.from('borsh SignedDelegate bytes').toString('base64'), otherRegistry, deposit]) {
      await expect(client.relayPay(b64, nearSigner(GATEWAY).signer)).rejects.toMatchObject({ code: 'invalid_query', httpStatus: 400 });
    }
    const good = await buildEscrowPayDelegate(signer, { ...parts, registryId: REGISTRY });
    await expect(client.relayPay(good, { kind: 'mock', accountId: GATEWAY })).rejects.toMatchObject({ code: 'invalid_signer' });
    expect(rpc.fetch).not.toHaveBeenCalled();
  });
});
