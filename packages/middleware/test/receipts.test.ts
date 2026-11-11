import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TxTimeoutError } from '@agentgate/chain';
import { isNearTxHash, type AnySigner, type GatewayReceipt } from '@agentgate/shared';
import {
  createApp,
  MemoryAttestationQueue,
  ReceiptStore,
  RECEIPT_CAP,
  type AppInternals,
  type PendingAttestation,
} from '../src/index';
import {
  adminMap,
  bootGateway,
  payInvoice,
  proofHeaders,
  silentLogger,
  startUpstream,
  testConfig,
  until,
  type TestGateway,
  type TestUpstream,
} from './helpers';
import { FakeChainClient, contractError } from './fake-chain';

const NONCE = '424242';
const TX = (c: string): string => c.repeat(44);

/** A FakeChainClient whose recordAttestation waits until the test opens the gate. */
class GatedAttestChain extends FakeChainClient {
  private release: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  /** The attestation tx hashes the registry answered, in order. */
  readonly answered: string[] = [];

  open(): void {
    this.release();
  }

  override async recordAttestation(
    input: Parameters<FakeChainClient['recordAttestation']>[0],
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    await this.gate;
    const result = await super.recordAttestation(input, signer);
    this.answered.push(result.txHash);
    return result;
  }
}

async function getReceipt(gw: TestGateway, nonce: string): Promise<globalThis.Response> {
  return fetch(`${gw.baseUrl}/receipts/${nonce}`);
}

async function receiptOf(gw: TestGateway, nonce: string): Promise<GatewayReceipt> {
  const res = await getReceipt(gw, nonce);
  expect(res.status).toBe(200);
  return (await res.json()) as GatewayReceipt;
}

describe('ReceiptStore', () => {
  it('holds at most RECEIPT_CAP (1000) receipts and drops the oldest first', () => {
    expect(RECEIPT_CAP).toBe(1000);
    const store = new ReceiptStore(3);
    for (let n = 1; n <= 4; n += 1) {
      store.open({ nonce: String(n), serviceId: 1, paymentTxHash: TX('A') }, { status: 'pending' });
    }
    expect(store.size).toBe(3);
    expect(store.get('1')).toBeUndefined(); // oldest dropped
    expect(store.get('2')).toBeDefined();
    expect(store.get('4')).toBeDefined();
  });

  it('settles a pending receipt once and leaves a finished one alone', () => {
    const store = new ReceiptStore();
    store.open({ nonce: '1', serviceId: 2, paymentTxHash: TX('A') }, { status: 'pending' });
    store.settle('1', { status: 'recorded', txHash: TX('B') });
    store.settle('1', { status: 'failed' }); // too late: the first verdict stands
    expect(store.get('1')).toEqual({
      nonce: '1',
      serviceId: 2,
      paymentTxHash: TX('A'),
      attestation: { status: 'recorded', txHash: TX('B') },
    });
    store.settle('999', { status: 'failed' }); // unknown nonce: ignored
    expect(store.get('999')).toBeUndefined();
  });

  it('hands out copies, so a caller cannot change what the store holds', () => {
    const store = new ReceiptStore();
    store.open({ nonce: '1', serviceId: 2, paymentTxHash: TX('A') }, { status: 'pending' });
    const copy = store.get('1')!;
    copy.attestation.status = 'failed';
    expect(store.get('1')!.attestation.status).toBe('pending');
  });
});

describe('GET /receipts/:nonce', () => {
  const open: { gw: TestGateway; up: TestUpstream }[] = [];

  async function boot(
    opts: Parameters<typeof bootGateway>[0] = {},
  ): Promise<{ gw: TestGateway; up: TestUpstream }> {
    const gw = await bootGateway(opts);
    const up = await startUpstream();
    gw.fake.addService({ id: 1 });
    await adminMap(gw, 1, `${up.url}/data`);
    const pair = { gw, up };
    open.push(pair);
    return pair;
  }

  afterEach(async () => {
    for (const { gw, up } of open.splice(0)) {
      await gw.close();
      await up.close();
    }
  });

  it('a paid, served call is pending while the attestation is in flight, then recorded with its tx hash', async () => {
    const fake = new GatedAttestChain();
    const { gw } = await boot({ fake });
    const proof = await payInvoice(gw, 1);
    const served = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    expect(served.status).toBe(200);

    // The receipt exists as soon as the buyer is served, before the attestation lands.
    const pending = await getReceipt(gw, proof.nonce);
    expect(pending.status).toBe(200);
    expect(pending.headers.get('cache-control')).toBe('no-store');
    expect(await pending.json()).toEqual({
      nonce: proof.nonce,
      serviceId: 1,
      paymentTxHash: proof.txHash,
      attestation: { status: 'pending' },
    });

    fake.open();
    await until(() => fake.answered.length === 1);
    const receipt = await pollUntilSettled(gw, proof.nonce);
    expect(receipt).toEqual({
      nonce: proof.nonce,
      serviceId: 1,
      paymentTxHash: proof.txHash,
      attestation: { status: 'recorded', txHash: fake.answered[0] },
    });
    expect(isNearTxHash(receipt.attestation.txHash)).toBe(true);
  });

  it('answers 404 for a nonce it never saw and for anything that is not a nonce', async () => {
    const { gw } = await boot();
    for (const nonce of [NONCE, 'abc', '1'.repeat(21), '0x1f']) {
      const res = await getReceipt(gw, nonce);
      expect(res.status, nonce).toBe(404);
      // A 404 can become a 200 a moment later (the receipt is opened as the buyer is served): never cache it.
      expect(res.headers.get('cache-control'), nonce).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'receipt_not_found' });
    }
  });

  it('keeps no receipt for an invoice that was issued but never paid, or a proof that was refused', async () => {
    const { gw } = await boot();
    const challenge = await fetch(`${gw.baseUrl}/svc/1`);
    const nonce = (
      (await challenge.json()) as { accepts: { extra: { nonce: string } }[] }
    ).accepts[0]!.extra.nonce;
    expect((await getReceipt(gw, nonce)).status).toBe(404);

    // A proof for a payment the registry does not hold is refused before anything is served.
    const refused = await fetch(`${gw.baseUrl}/svc/1`, {
      headers: proofHeaders({ txHash: TX('F'), nonce, network: gw.fake.network }),
    });
    expect(refused.status).toBe(402);
    expect((await getReceipt(gw, nonce)).status).toBe(404);
  });

  it('reports only what the registry already shows publicly: no payer, no price, no upstream', async () => {
    const { gw, up } = await boot();
    const proof = await payInvoice(gw, 1);
    await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    const res = await getReceipt(gw, proof.nonce);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'attestation',
      'nonce',
      'paymentTxHash',
      'serviceId',
    ]);
    expect(text).not.toContain(proof.payer);
    expect(text).not.toContain(up.url);
  });

  it('a failed upstream response is still attested (success=false): recorded', async () => {
    const { gw, up } = await boot();
    gw.fake.addService({ id: 2 });
    await adminMap(gw, 2, `${up.url}/fail`);
    const proof = await payInvoice(gw, 2);
    const res = await fetch(`${gw.baseUrl}/svc/2`, { headers: proofHeaders(proof) });
    expect(res.status).toBe(500);
    await until(() => gw.fake.attestations.length === 1);
    expect(gw.fake.attestations[0]).toMatchObject({ nonce: proof.nonce, success: false });
    const receipt = await pollUntilSettled(gw, proof.nonce);
    expect(receipt.attestation.status).toBe('recorded');
    expect(receipt.attestation.txHash).toBeDefined();
  });

  it('a call the gateway could not deliver (upstream unreachable) is skipped_upstream_failed, never attested', async () => {
    const { gw } = await boot();
    gw.fake.addService({ id: 3 });
    const dead = await startUpstream();
    const deadUrl = dead.url;
    await dead.close(); // nothing listens here any more
    await adminMap(gw, 3, `${deadUrl}/data`);
    const proof = await payInvoice(gw, 3);
    const res = await fetch(`${gw.baseUrl}/svc/3`, { headers: proofHeaders(proof) });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const receipt = await receiptOf(gw, proof.nonce);
    expect(receipt).toEqual({
      nonce: proof.nonce,
      serviceId: 3,
      paymentTxHash: proof.txHash,
      attestation: { status: 'skipped_upstream_failed' },
    });
    expect(gw.fake.attestationCalls).toBe(0);
  });

  it("a call the service owner paid for is served but skipped_self_paid, and the gateway never tries to attest it", async () => {
    const { gw } = await boot();
    const owner = gw.fake.services.get(1)!.owner;
    const proof = await payInvoice(gw, 1, { payer: owner });
    const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders({ ...proof, payer: owner }) });
    expect(res.status).toBe(200);
    const receipt = await receiptOf(gw, proof.nonce);
    expect(receipt.attestation).toEqual({ status: 'skipped_self_paid' });
    expect(gw.fake.attestationCalls).toBe(0);
  });

  it('every attempt failing ends as failed (no tx hash)', async () => {
    // The retry waits 300 ms, so the receipt is still pending right after the first attempt failed.
    const { gw } = await boot({ attestationRetryDelayMs: 300, attestationMaxAttempts: 2 });
    gw.fake.failAttestations = 99;
    const proof = await payInvoice(gw, 1);
    expect((await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) })).status).toBe(200);
    expect((await receiptOf(gw, proof.nonce)).attestation.status).toBe('pending');
    await until(() => gw.fake.attestationCalls === 2);
    const receipt = await pollUntilSettled(gw, proof.nonce);
    expect(receipt.attestation).toEqual({ status: 'failed' });
  });

  it('a payment someone else already attested (ERR_ALREADY_ATTESTED) is recorded, with no tx hash to name', async () => {
    const { gw } = await boot();
    gw.fake.attestationFailure = contractError('ERR_ALREADY_ATTESTED', 'this payment is already attested');
    const proof = await payInvoice(gw, 1);
    expect((await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) })).status).toBe(200);
    const receipt = await pollUntilSettled(gw, proof.nonce);
    expect(receipt.attestation).toEqual({ status: 'recorded' });
  });

  it('an attestation that timed out and then finds the payment already attested names the tx that timed out', async () => {
    const fake = new ScriptedAttestChain();
    fake.script.push(
      () => Promise.reject(new TxTimeoutError('the NEAR RPC timed out after the attestation tx was sent', TX('D'), 'https://explorer.test')),
      () => Promise.reject(contractError('ERR_ALREADY_ATTESTED', 'this payment is already attested')),
    );
    const { gw } = await boot({ fake, attestationRetryDelayMs: 20 });
    const proof = await payInvoice(gw, 1);
    expect((await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) })).status).toBe(200);
    const receipt = await pollUntilSettled(gw, proof.nonce);
    expect(receipt.attestation).toEqual({ status: 'recorded', txHash: TX('D') });
    expect(fake.calls).toBe(2);
  });

  it('a plain failure before ERR_ALREADY_ATTESTED names no tx (nothing was sent)', async () => {
    const fake = new ScriptedAttestChain();
    fake.script.push(
      () => Promise.reject(new Error('the NEAR RPC is unreachable')),
      () => Promise.reject(contractError('ERR_ALREADY_ATTESTED', 'this payment is already attested')),
    );
    const { gw } = await boot({ fake, attestationRetryDelayMs: 20 });
    const proof = await payInvoice(gw, 1);
    expect((await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) })).status).toBe(200);
    expect((await pollUntilSettled(gw, proof.nonce)).attestation).toEqual({ status: 'recorded' });
  });

  it('a queue that cannot enqueue settles the receipt failed instead of leaving it pending', async () => {
    class BrokenQueue extends MemoryAttestationQueue {
      override enqueue(_item: PendingAttestation): Promise<void> {
        return Promise.reject(new Error('disk full'));
      }
    }
    const { gw, up, stop } = await bootWithQueue(new BrokenQueue());
    try {
      const proof = await payInvoice(gw, 1);
      const served = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(served.status).toBe(200); // the buyer is served regardless
      const receipt = await pollUntilSettled(gw, proof.nonce);
      expect(receipt.attestation).toEqual({ status: 'failed' });
      expect(gw.fake.attestationCalls).toBe(0);
    } finally {
      await stop();
      await up.close();
    }
  });

  it('an attestation replayed after a restart gets its receipt back', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agentgate-rcpt-'));
    const queuePath = path.join(dir, 'attestations.json');
    const fake = new FakeChainClient();
    fake.addService({ id: 1 });
    const up = await startUpstream();
    try {
      const gw1 = await bootGateway({
        fake,
        attestationQueuePath: queuePath,
        attestationRetryDelayMs: 20,
        attestationMaxAttempts: 2,
      });
      await adminMap(gw1, 1, `${up.url}/data`);
      fake.failAttestations = 99;
      const proof = await payInvoice(gw1, 1);
      expect((await fetch(`${gw1.baseUrl}/svc/1`, { headers: proofHeaders(proof) })).status).toBe(200);
      await until(() => fake.attestationCalls === 2);
      expect((await pollUntilSettled(gw1, proof.nonce)).attestation.status).toBe('failed');
      await gw1.close();

      fake.failAttestations = 0;
      const gw2 = await bootGateway({ fake, attestationQueuePath: queuePath, attestationRetryDelayMs: 20 });
      try {
        await until(() => fake.attestations.length === 1);
        const receipt = await pollUntilSettled(gw2, proof.nonce);
        expect(receipt.serviceId).toBe(1);
        expect(receipt.paymentTxHash).toBe(proof.txHash);
        expect(receipt.attestation.status).toBe('recorded');
      } finally {
        await gw2.close();
      }
    } finally {
      await up.close();
    }
  });

  it('is rate limited like the other public routes: 60 requests a minute per IP', async () => {
    const { gw } = await boot({ config: testConfig() });
    let limited = 0;
    for (let i = 0; i < 61; i += 1) {
      const res = await getReceipt(gw, NONCE);
      if (res.status === 429) limited += 1;
      await res.arrayBuffer();
    }
    expect(limited).toBe(1);
  });
});

/** Polls GET /receipts/:nonce until the attestation is no longer pending (5 s). */
async function pollUntilSettled(gw: TestGateway, nonce: string): Promise<GatewayReceipt> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await getReceipt(gw, nonce);
    if (res.status === 200) {
      const receipt = (await res.json()) as GatewayReceipt;
      if (receipt.attestation.status !== 'pending') return receipt;
    } else {
      await res.arrayBuffer();
    }
    if (Date.now() > deadline) throw new Error(`receipt ${nonce} still pending after 5 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** recordAttestation answers a script of outcomes first (one per call), then behaves like the fake. */
class ScriptedAttestChain extends FakeChainClient {
  readonly script: Array<() => Promise<{ txHash: string }>> = [];
  calls = 0;

  override recordAttestation(
    input: Parameters<FakeChainClient['recordAttestation']>[0],
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    this.calls += 1;
    const step = this.script.shift();
    return step === undefined ? super.recordAttestation(input, signer) : step();
  }
}

/** A gateway built straight from createApp so the test can inject its own attestation queue. */
async function bootWithQueue(
  queue: MemoryAttestationQueue,
): Promise<{ gw: TestGateway; up: TestUpstream; stop(): Promise<void> }> {
  const fake = new FakeChainClient();
  fake.addService({ id: 1 });
  const up = await startUpstream();
  const config = testConfig();
  const upstreamsFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'agentgate-rcpt-')), 'upstreams.json');
  const app = createApp({ config, chain: fake, logger: silentLogger, upstreamsFile, attestationQueue: queue });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const gw: TestGateway = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    fake,
    config,
    upstreamsFile,
    close: () => Promise.resolve(),
  };
  await adminMap(gw, 1, `${up.url}/data`);
  return {
    gw,
    up,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await (app.locals['agentgate'] as AppInternals).dispose();
    },
  };
}
