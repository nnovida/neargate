/**
 * e2e/loop.test.ts — the full mock-mode loop, in-process.
 *
 * Boots devnet + oracle (static fixture) + middleware on port 0 (parallel-safe,
 * no fixed ports), then walks the entire register → pay → attest economy:
 *
 *   faucet → wrap (on-chain register + gateway admin mapping)
 *   → unpaid GET = 402 with the NEAR invoice (price + 0.002 NEAR storage via registry `pay`)
 *   → an under-deposited `pay` is rejected by the registry (ERR_DEPOSIT_TOO_LOW):
 *     no money moves and the gateway never serves
 *   → buy (client: 402 → pay → retry with proof) = 200 with the oracle JSON;
 *     seller +0.5 NEAR exactly, buyer −0.502 NEAR exactly
 *   → replayed proof = 402 invoice_used
 *   → attestation recorded on-chain (poll ≤5s) → score 1/1
 *   → activity feed holds all three event kinds
 *   → the owner buying its own service is served, but never attested: score stays 1/1
 *   plus: expired-invoice (TTL 100ms) and inactive-service tests.
 */
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChainHttpClient } from '@agentgate/chain';
import { buyService, createDemoAccounts, wrapService } from '@neargate/cli';
import { startServer as startDevnet } from '@agentgate/devnet';
import { startServer as startMiddleware } from '@agentgate/middleware';
import { startServer as startOracle } from '@agentgate/oracle';
import {
  PAYMENT_STORAGE_FEE_YOCTO,
  chainErrorCode,
  decodeXPaymentResponse,
  encodeXPayment,
  isNearAccountId,
  isNearTxHash,
  loadConfig,
  nearToYocto,
  X402_SCHEME,
  X402_VERSION,
  type AgentGateConfig,
  type AttestationRecord,
  type MockSigner,
  type PaymentRequiredResponse,
} from '@agentgate/shared';

const PRICE_YOCTO = nearToYocto('0.5');
/** Price + the 0.002 NEAR storage fee: what a NEAR invoice asks for. */
const MAX_AMOUNT_YOCTO = nearToYocto('0.502');
/** A well-formed tx hash no `pay` ever produced. */
const UNKNOWN_TX = 'Eky1UaWkroENJrfa2yjf8PR7pFbznerFT7UDpUBuodUd';

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
  let paidTxHash: string;
  let paidNonce: string;

  const balanceOf = async (accountId: string): Promise<bigint> => BigInt(await chain.getBalance(accountId));

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
    expect(isNearTxHash(wrapped.txHash)).toBe(true);
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

  it('unpaid GET → 402 with the NEAR invoice: price + storage fee through the registry `pay`', async () => {
    const res = await fetch(publicUrl);
    expect(res.status).toBe(402);

    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.x402Version).toBe(X402_VERSION);
    expect(body.error).toBe('X-PAYMENT header is required');
    expect(body.accepts).toHaveLength(1);

    const req = body.accepts[0]!;
    expect(req.scheme).toBe(X402_SCHEME);
    expect(req.network).toBe('near-mock');
    expect(req.asset).toBe('NEAR');
    expect(req.description).toBe('RWA FX & Gold Oracle');
    expect(req.maxAmountRequired).toBe(MAX_AMOUNT_YOCTO);
    expect(req.payTo).toBe(chain.registryId);
    expect(req.extra).toMatchObject({
      serviceId,
      settlement: 'neargate-registry-pay',
      contractId: chain.registryId,
      method: 'pay',
      priceYocto: PRICE_YOCTO,
      storageFeeYocto: PAYMENT_STORAGE_FEE_YOCTO,
      seller: paymentTarget,
      caip2: 'near:mock',
    });
    expect(req.extra.nonce).toMatch(/^\d{1,20}$/);
    expect(req.extra.expiresAtMs).toBeGreaterThan(Date.now());

    challenge = body;
  });

  it('an under-deposited pay is rejected by the registry (ERR_DEPOSIT_TOO_LOW): no money moves, nothing is served', async () => {
    const nonce = challenge.accepts[0]!.extra.nonce;
    const short = (BigInt(MAX_AMOUNT_YOCTO) - 1n).toString(); // 1 yocto below maxAmountRequired
    const buyerBefore = await balanceOf(buyer.accountId);
    const sellerBefore = await balanceOf(seller.accountId);

    const err = await chain.pay({ serviceId, nonce, depositYocto: short }, buyer).catch((e: unknown) => e);
    expect(chainErrorCode(err)).toBe('ERR_DEPOSIT_TOO_LOW');

    expect(await balanceOf(buyer.accountId)).toBe(buyerBefore);
    expect(await balanceOf(seller.accountId)).toBe(sellerBefore);
    expect(await chain.getPayment(nonce)).toBeNull();

    // Presenting a proof for that nonce gets a fresh invoice, never the data.
    const res = await fetch(publicUrl, {
      headers: {
        'X-PAYMENT': encodeXPayment({
          x402Version: X402_VERSION,
          scheme: X402_SCHEME,
          network: chain.network,
          payload: { kind: 'tx', transaction: UNKNOWN_TX, nonce, payer: buyer.accountId },
        }),
      },
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('not_found');
    expect(body.accepts[0]!.extra.nonce).not.toBe(nonce);
  });

  it('buy: 402 → pay → proof = 200 oracle JSON; seller +0.5 NEAR, buyer −0.502 NEAR exactly', async () => {
    const buyerBefore = await balanceOf(buyer.accountId);
    const sellerBefore = await balanceOf(seller.accountId);
    const registryBefore = await balanceOf(chain.registryId);

    const { result } = await buyService({ chain, signer: buyer, id: serviceId });

    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    expect(result.priceYocto).toBe(PRICE_YOCTO);
    expect(result.depositYocto).toBe(MAX_AMOUNT_YOCTO);
    // Static fixture values (ORACLE_STATIC) prove the bytes came from the oracle.
    const feed = result.body as {
      pairs: { usd_idr: { value: number }; xau_usd: { value: number } };
      attribution: string;
    };
    expect(feed.pairs.usd_idr.value).toBe(16250.5);
    expect(feed.pairs.xau_usd.value).toBe(3310.25);
    expect(feed.attribution).toBe('static-fixture');
    expect(result.settlement).toMatchObject({ success: true, transaction: result.txHash, network: chain.network });

    expect((await balanceOf(seller.accountId)) - sellerBefore).toBe(BigInt(PRICE_YOCTO));
    expect(buyerBefore - (await balanceOf(buyer.accountId))).toBe(BigInt(MAX_AMOUNT_YOCTO));
    expect((await balanceOf(chain.registryId)) - registryBefore).toBe(BigInt(PAYMENT_STORAGE_FEE_YOCTO));

    expect(isNearTxHash(result.txHash)).toBe(true);
    paidTxHash = result.txHash!;
    paidNonce = result.requirements!.extra.nonce;
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
    expect(payment, 'payment event for the paid call').toBeDefined();
    expect(payment!.amountYocto).toBe(PRICE_YOCTO); // the price forwarded to the seller
    expect(payment!.nonce).toBe(paidNonce);

    const attestation = events.find(
      (e) => e.kind === 'attestation' && e.paymentTxHash === paidTxHash,
    );
    expect(attestation, 'attestation event for the paid call').toBeDefined();
    expect(attestation!.success).toBe(true);
  });

  it('the owner buying its own service is served but never attested: the score stays 1/1', async () => {
    const ownerBefore = await balanceOf(seller.accountId);

    const { result } = await buyService({ chain, signer: seller, id: serviceId });

    expect(result.status).toBe(200);
    expect(result.paid).toBe(true);
    const nonce = result.requirements!.extra.nonce;
    const payment = await chain.getPayment(nonce);
    expect(payment).toMatchObject({ payer: seller.accountId, selfPaid: true, attested: false });
    // The owner is also the payment target: only the storage fee leaves its wallet.
    expect(ownerBefore - (await balanceOf(seller.accountId))).toBe(BigInt(PAYMENT_STORAGE_FEE_YOCTO));

    // Give a (wrongly) scheduled attestation more than its first retry window to land.
    await sleep(750);
    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 1, successCalls: 1 });
    const attestations = await chain.listAttestations(serviceId, 50);
    expect(attestations.some((a) => a.paymentTxHash === result.txHash)).toBe(false);
    expect((await chain.getPayment(nonce))!.attested).toBe(false);
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
