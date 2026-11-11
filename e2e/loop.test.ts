/**
 * e2e/loop.test.ts — the full mock-mode loop, in-process.
 *
 * Boots devnet + oracle (static fixture) + middleware on port 0 (parallel-safe,
 * no fixed ports), then walks the entire register → pay → attest economy:
 *
 *   faucet → wrap (on-chain register + gateway admin mapping)
 *   → unpaid GET = 402 with a valid PaymentRequiredResponse
 *   → underpay rejected (amount_too_low)
 *   → exact pay = 200 with the oracle JSON
 *   → replayed proof = 402 invoice_used
 *   → attestation recorded on-chain (poll ≤5s) → score (1,1)
 *   → activity feed holds all three event kinds
 *   plus: expired-invoice (TTL 100ms) and inactive-service tests.
 *
 * TODO(Task 5): mechanically ported; red until the devnet mirrors the registry
 * (Task 3: base58 tx hashes, `pay` keeps the storage fee) and the loop is re-asserted
 * on balances (seller +0.5 NEAR, buyer −0.502 NEAR).
 */
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient } from '@agentgate/chain';
import { createDemoAccounts, wrapService } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  decodeXPaymentResponse,
  encodeXPayment,
  isNearAccountId,
  loadConfig,
  X402_SCHEME,
  X402_VERSION,
  type AgentGateConfig,
  type AttestationRecord,
  type MockSigner,
  type PaymentRequiredResponse,
} from '@agentgate/shared';

const PRICE_YOCTO = '500000000000000000000000'; // 0.5 NEAR
/** Price + the 0.002 NEAR storage fee: what a NEAR invoice asks for. */
const MAX_AMOUNT_YOCTO = '502000000000000000000000';
const HASH_RE = /^[0-9a-f]{64}$/;

interface Running {
  port: number;
  close(): Promise<void>;
}

function tmpUpstreamsFile(tag: string): string {
  return path.join(
    os.tmpdir(),
    `agentgate-e2e-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('full mock-mode loop (e2e)', () => {
  // Defaults only — never coupled to the host environment.
  const baseConfig: AgentGateConfig = loadConfig({});
  const upstreamsMain = tmpUpstreamsFile('main');
  const upstreamsShortTtl = tmpUpstreamsFile('short-ttl');

  let devnet: Running;
  let oracle: Running;
  let middleware: Running;
  let cfg: AgentGateConfig;
  let chain: MockChainHttpClient;
  let buyer: MockSigner;
  let seller: MockSigner;
  let gateway: string;
  let oracleFeedUrl: string;

  // Set by the wrap step, consumed by every later test.
  let serviceId: number;
  let registerTxHash: string;
  let publicUrl: string;
  let paymentTarget: string;

  // Handed from test to test (the loop is inherently sequential).
  let challenge: PaymentRequiredResponse; // from the unpaid GET
  let freshAfterUnderpay: PaymentRequiredResponse; // fresh invoice issued with the underpay rejection
  let paidTxHash: string;
  let paidNonce: string;

  beforeAll(async () => {
    devnet = await startDevnet({ port: 0, config: baseConfig });
    const devnetUrl = `http://127.0.0.1:${devnet.port}`;
    cfg = { ...baseConfig, devnetUrl, oracleStatic: true };

    oracle = await startOracle({ port: 0, config: cfg });
    oracleFeedUrl = `http://127.0.0.1:${oracle.port}/feed`;

    chain = new MockChainHttpClient(devnetUrl);
    middleware = await startMiddleware({
      port: 0,
      config: cfg,
      chain,
      upstreamsFile: upstreamsMain,
      attestationRetryDelayMs: 250,
    });
    gateway = `http://127.0.0.1:${middleware.port}`;

    const accounts = await createDemoAccounts({ devnetUrl });
    buyer = { kind: 'mock', accountId: accounts.buyer.accountId };
    seller = { kind: 'mock', accountId: accounts.seller.accountId };
  });

  afterAll(async () => {
    await middleware?.close().catch(() => undefined);
    await oracle?.close().catch(() => undefined);
    await devnet?.close().catch(() => undefined);
    await rm(upstreamsMain, { force: true }).catch(() => undefined);
    await rm(upstreamsShortTtl, { force: true }).catch(() => undefined);
  });

  it('wraps the oracle: on-chain registration + gateway admin mapping', async () => {
    const wrapped = await wrapService({
      upstreamUrl: oracleFeedUrl,
      priceNear: '0.5',
      name: 'RWA FX & Gold Oracle',
      description: 'USD/IDR exchange rate and gold (XAU/USD) spot price feed',
      gateway,
      chain,
      signer: seller,
      adminToken: cfg.adminToken,
    });

    expect(wrapped.adminOk).toBe(true);
    expect(wrapped.serviceId).toBeGreaterThanOrEqual(1);
    expect(wrapped.txHash).toMatch(HASH_RE);
    expect(wrapped.publicUrl).toBe(`${gateway}/svc/${wrapped.serviceId}`);

    serviceId = wrapped.serviceId;
    registerTxHash = wrapped.txHash;
    publicUrl = wrapped.publicUrl;

    // The on-chain record computes endpointUrl = <gateway>/svc/<id>.
    const record = await chain.getService(serviceId);
    expect(record).not.toBeNull();
    expect(record!.endpointUrl).toBe(publicUrl);
    expect(record!.priceYocto).toBe(PRICE_YOCTO);
    expect(record!.active).toBe(true);
    paymentTarget = record!.paymentTarget;
    expect(isNearAccountId(paymentTarget)).toBe(true);
    expect(paymentTarget).toBe(seller.accountId);
  });

  it('unpaid GET → 402 with a valid PaymentRequiredResponse body', async () => {
    const res = await fetch(publicUrl);
    expect(res.status).toBe(402);

    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.x402Version).toBe(X402_VERSION);
    expect(body.error).toBe('X-PAYMENT header is required');
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts.length).toBeGreaterThanOrEqual(1);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const req = body.accepts[0]!;
    expect(req.network).toBe('mock');
    expect(req.extra.serviceId).toBe(serviceId);
    expect(req.description).toBe('RWA FX & Gold Oracle');
    expect(req.maxAmountRequired).toBe(MAX_AMOUNT_YOCTO);
    expect(req.payTo).toBe(chain.registryId);
    expect(req.extra.seller).toBe(paymentTarget);
    expect(req.extra.nonce).toMatch(/^\d{1,20}$/);
    expect(req.extra.expiresAtMs).toBeGreaterThan(Date.now());
    expect(req.scheme).toBe(X402_SCHEME);

    challenge = body;
  });

  it('underpaid payment → 402 amount_too_low with a fresh invoice', async () => {
    // 1 yocto short of the price, but with the correct invoice nonce.
    const nonce = challenge.accepts[0]!.extra.nonce;
    const { txHash } = await chain.pay(
      { serviceId, nonce, depositYocto: '499999999999999999999999' },
      buyer,
    );

    const xPayment = encodeXPayment({
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: chain.network,
      payload: { kind: 'tx', transaction: txHash, nonce, payer: buyer.accountId },
    });
    const res = await fetch(publicUrl, {
      headers: { 'X-PAYMENT': xPayment },
    });
    expect(res.status).toBe(402);

    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('amount_too_low');
    // Rejections come with a FRESH invoice so the buyer can recover.
    expect(body.accepts[0]!.extra.nonce).not.toBe(challenge.accepts[0]!.extra.nonce);
    expect(body.accepts[0]!.maxAmountRequired).toBe(MAX_AMOUNT_YOCTO);

    freshAfterUnderpay = body;
  });

  it('exact payment → 200 with the oracle JSON proxied through the gateway', async () => {
    const nonce = freshAfterUnderpay.accepts[0]!.extra.nonce;
    const { txHash } = await chain.pay(
      { serviceId, nonce, depositYocto: MAX_AMOUNT_YOCTO },
      buyer,
    );

    const xPayment = encodeXPayment({
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: chain.network,
      payload: { kind: 'tx', transaction: txHash, nonce, payer: buyer.accountId },
    });
    const res = await fetch(publicUrl, {
      headers: { 'X-PAYMENT': xPayment },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    // Static fixture values (ORACLE_STATIC) prove the bytes came from the oracle.
    const feed = (await res.json()) as {
      pairs: { usd_idr: { value: number }; xau_usd: { value: number } };
      attribution: string;
    };
    expect(feed.pairs.usd_idr.value).toBe(16250.5);
    expect(feed.pairs.xau_usd.value).toBe(3310.25);
    expect(feed.attribution).toBe('static-fixture');

    // Settlement header must be present and carry the correct proof metadata.
    const xPaymentResponse = res.headers.get('x-payment-response');
    expect(xPaymentResponse, 'x-payment-response header should be present').not.toBeNull();
    const settlement = decodeXPaymentResponse(xPaymentResponse!);
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toBe(txHash);
    expect(settlement.network).toBe(chain.network);

    paidTxHash = txHash;
    paidNonce = nonce;
  });

  it('replaying the same proof → 402 invoice_used', async () => {
    const xPayment = encodeXPayment({
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: chain.network,
      payload: { kind: 'tx', transaction: paidTxHash, nonce: paidNonce, payer: buyer.accountId },
    });
    const res = await fetch(publicUrl, {
      headers: { 'X-PAYMENT': xPayment },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('invoice_used');
  });

  it('the gateway records a success attestation on-chain within 5s', async () => {
    const deadline = Date.now() + 5_000;
    let found: AttestationRecord | undefined;
    for (;;) {
      const attestations = await chain.listAttestations(serviceId, 50);
      found = attestations.find((a) => a.paymentTxHash === paidTxHash);
      if (found !== undefined || Date.now() >= deadline) break;
      await sleep(200);
    }
    expect(found, 'attestation for the payment tx hash').toBeDefined();
    expect(found!.success).toBe(true);
    expect(found!.nonce).toBe(paidNonce);
  });

  it('the service score is exactly (totalCalls 1, successCalls 1)', async () => {
    const score = await chain.getScore(serviceId);
    expect(score).toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('the activity feed contains registration, payment and attestation events', async () => {
    const events = await chain.listRecentActivity(100);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('service_registered')).toBe(true);
    expect(kinds.has('payment')).toBe(true);
    expect(kinds.has('attestation')).toBe(true);

    const registered = events.find(
      (e) => e.kind === 'service_registered' && e.txHash === registerTxHash,
    );
    expect(registered, 'registration event for the wrap tx').toBeDefined();

    const payment = events.find((e) => e.kind === 'payment' && e.txHash === paidTxHash);
    expect(payment, 'payment event for the exact-pay tx').toBeDefined();
    expect(payment!.amountYocto).toBe(MAX_AMOUNT_YOCTO);
    expect(payment!.nonce).toBe(paidNonce);

    const attestation = events.find(
      (e) => e.kind === 'attestation' && e.serviceId === serviceId && e.success === true,
    );
    expect(attestation, 'attestation event for the paid call').toBeDefined();
  });

  it('expired invoice (TTL 100ms) → 402 invoice_expired even with a valid payment', async () => {
    // Dedicated gateway instance with a 100ms invoice TTL, same chain + oracle.
    const shortTtl = await startMiddleware({
      port: 0,
      config: { ...cfg, invoiceTtlMs: 100 },
      chain,
      upstreamsFile: upstreamsShortTtl,
    });
    try {
      const shortGateway = `http://127.0.0.1:${shortTtl.port}`;
      const mapRes = await fetch(`${shortGateway}/admin/services`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ serviceId, upstreamUrl: oracleFeedUrl }),
      });
      expect(mapRes.status).toBe(204);

      const challengeRes = await fetch(`${shortGateway}/svc/${serviceId}`);
      expect(challengeRes.status).toBe(402);
      const invoice = (await challengeRes.json()) as PaymentRequiredResponse;

      // Pay correctly… but present the proof only after the invoice has expired.
      const invoiceNonce = invoice.accepts[0]!.extra.nonce;
      const { txHash } = await chain.pay(
        { serviceId, nonce: invoiceNonce, depositYocto: MAX_AMOUNT_YOCTO },
        buyer,
      );
      await sleep(250); // > 100ms TTL (the store keeps expired invoices around long enough)

      const xPayment = encodeXPayment({
        x402Version: X402_VERSION,
        scheme: X402_SCHEME,
        network: chain.network,
        payload: { kind: 'tx', transaction: txHash, nonce: invoiceNonce, payer: buyer.accountId },
      });
      const res = await fetch(`${shortGateway}/svc/${serviceId}`, {
        headers: { 'X-PAYMENT': xPayment },
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as PaymentRequiredResponse;
      expect(body.error).toBe('invoice_expired');
    } finally {
      await shortTtl.close();
    }
  });

  it('inactive service → 403 service_inactive before any invoice is issued', async () => {
    const second = await wrapService({
      upstreamUrl: oracleFeedUrl,
      priceNear: '0.25',
      name: 'Soon-to-be-paused Oracle',
      description: 'gets deactivated by its owner',
      gateway,
      chain,
      signer: seller,
      adminToken: cfg.adminToken,
    });
    expect(second.adminOk).toBe(true);

    await chain.setActive(second.serviceId, false, seller);

    const res = await fetch(`${gateway}/svc/${second.serviceId}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'service_inactive' });
  });
});
