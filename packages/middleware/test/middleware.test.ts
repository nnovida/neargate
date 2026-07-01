import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateError, decodeXPaymentResponse, encodeXPayment, type PaymentRequiredResponse } from '@agentgate/shared';
import { createApp } from '../src/index';
import {
  adminMap,
  bootGateway,
  payInvoice,
  proofHeaders,
  silentLogger,
  sleep,
  startUpstream,
  testConfig,
  until,
  type TestGateway,
  type TestUpstream,
} from './helpers';
import { FakeChainClient } from './fake-chain';

describe('paywall flow (mock mode)', () => {
  let gw: TestGateway;
  let upstream: TestUpstream;

  beforeAll(async () => {
    gw = await bootGateway();
    upstream = await startUpstream();
    gw.fake.addService({ id: 1, name: 'Gold Spot Feed', priceMotes: '500000000' });
    gw.fake.addService({ id: 2, name: 'Broken Feed' });
    gw.fake.addService({ id: 3, name: 'Echo Feed' });
    gw.fake.addService({ id: 4, name: 'Sleeping Feed', active: false });
    gw.fake.addService({ id: 5, name: 'Unmapped Feed' });
    expect((await adminMap(gw, 1, `${upstream.url}/data`)).status).toBe(204);
    expect((await adminMap(gw, 2, `${upstream.url}/fail`)).status).toBe(204);
    expect((await adminMap(gw, 3, `${upstream.url}/echo`)).status).toBe(204);
    expect((await adminMap(gw, 4, `${upstream.url}/data`)).status).toBe(204);
  });

  afterAll(async () => {
    await gw.close();
    await upstream.close();
  });

  it('GET /healthz reports ok + network', async () => {
    const res = await fetch(`${gw.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, network: 'mock' });
  });

  it('unpaid request gets a 402 challenge with a valid x402 PaymentRequiredResponse', async () => {
    const before = Date.now();
    const res = await fetch(`${gw.baseUrl}/svc/1`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe('X-PAYMENT header is required');
    const req = body.accepts[0]!;
    expect(req.scheme).toBe('exact');
    expect(req.asset).toBe('CSPR');
    expect(req.network).toBe(gw.fake.network);
    expect(req.description).toBe('Gold Spot Feed');
    expect(req.maxAmountRequired).toBe('500000000');
    expect(req.payTo).toMatch(/^account-hash-[0-9a-f]{64}$/);
    expect(req.resource).toContain('/svc/1');
    expect(req.maxTimeoutSeconds).toBe(Math.floor(gw.config.invoiceTtlMs / 1000));
    expect(req.extra.nonce).toMatch(/^\d+$/);
    expect(BigInt(req.extra.nonce) < 2n ** 64n).toBe(true);
    expect(req.extra.expiresAtMs).toBeGreaterThanOrEqual(before + gw.config.invoiceTtlMs - 1000);
    expect(req.extra.settlement).toBe('casper-native-transfer');
    // no X-AgentGate-* headers anymore
    expect(res.headers.get('x-agentgate-price')).toBeNull();
  });

  it('POST is paywalled too', async () => {
    const res = await fetch(`${gw.baseUrl}/svc/3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ping: true }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.accepts[0]!.extra.serviceId).toBe(3);
  });

  it('unknown service → 404, non-numeric id → 404, inactive → 403, unmapped → 503', async () => {
    expect((await fetch(`${gw.baseUrl}/svc/999`)).status).toBe(404);
    expect((await fetch(`${gw.baseUrl}/svc/abc`)).status).toBe(404);
    const inactive = await fetch(`${gw.baseUrl}/svc/4`);
    expect(inactive.status).toBe(403);
    expect(await inactive.json()).toEqual({ error: 'service_inactive' });
    const unmapped = await fetch(`${gw.baseUrl}/svc/5`);
    expect(unmapped.status).toBe(503);
    expect(await unmapped.json()).toEqual({ error: 'service_unavailable' });
  });

  it('happy paid flow: pay → 200 with upstream JSON + query forwarding + X-PAYMENT-RESPONSE → attestation success=true', async () => {
    const attestationsBefore = gw.fake.attestations.length;
    const proof = await payInvoice(gw, 1);
    const res = await fetch(`${gw.baseUrl}/svc/1?symbol=XAU&fmt=json`, {
      headers: proofHeaders(proof),
    });
    expect(res.status).toBe(200);
    const resp = res.headers.get('x-payment-response');
    expect(resp).not.toBeNull();
    const settlement = decodeXPaymentResponse(resp!);
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toBe(proof.deployHash);
    expect(settlement.network).toBe(gw.fake.network);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ hello: 'world', query: { symbol: 'XAU', fmt: 'json' } });

    await until(() => gw.fake.attestations.length === attestationsBefore + 1);
    const attestation = gw.fake.attestations[attestationsBefore];
    expect(attestation).toMatchObject({
      serviceId: 1,
      paymentDeployHash: proof.deployHash,
      success: true,
    });
  });

  it('JSON body is forwarded on paid POST', async () => {
    const proof = await payInvoice(gw, 3);
    const res = await fetch(`${gw.baseUrl}/svc/3`, {
      method: 'POST',
      headers: { ...proofHeaders(proof), 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'price of gold?', n: 7 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echo: { question: 'price of gold?', n: 7 } });
  });

  it('payment proof header is never forwarded to the upstream', () => {
    const forwarded = upstream.seen.filter(
      (r) => 'x-payment' in r.headers,
    );
    expect(forwarded).toEqual([]);
  });

  it('replayed proof is rejected with invoice_used + a fresh invoice', async () => {
    const proof = await payInvoice(gw, 1);
    const first = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    expect(first.status).toBe(200);
    const replay = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    expect(replay.status).toBe(402);
    const body = (await replay.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('invoice_used');
    expect(body.accepts[0]!.extra.nonce).not.toBe(proof.nonce); // fresh invoice issued
    expect(body.x402Version).toBe(1);
  });

  it('unknown nonce → 402 unknown_nonce; no x-payment header → fresh challenge; malformed x-payment → invalid_payment_header', async () => {
    const proof = await payInvoice(gw, 1);

    // valid x-payment but transferId matches no invoice → unknown_nonce
    const wrongNonce = await fetch(`${gw.baseUrl}/svc/1`, {
      headers: proofHeaders({ deployHash: proof.deployHash, nonce: '12345', network: proof.network }),
    });
    expect(wrongNonce.status).toBe(402);
    expect(((await wrongNonce.json()) as PaymentRequiredResponse).error).toBe('unknown_nonce');

    // no x-payment header → fresh challenge (not unknown_nonce)
    const noHeader = await fetch(`${gw.baseUrl}/svc/1`);
    expect(noHeader.status).toBe(402);
    expect(((await noHeader.json()) as PaymentRequiredResponse).error).toBe('X-PAYMENT header is required');

    // malformed x-payment → never 5xx, always re-challenges
    const malformed = await fetch(`${gw.baseUrl}/svc/1`, {
      headers: { 'x-payment': 'not-base64' },
    });
    expect(malformed.status).toBe(402);
    expect(((await malformed.json()) as PaymentRequiredResponse).error).toBe('invalid_payment_header');
  });

  it('network-mismatched X-PAYMENT → 402 invalid_payment_header', async () => {
    // First obtain a valid nonce via a fresh challenge so only the network differs.
    const challenge = await fetch(`${gw.baseUrl}/svc/1`);
    const challengeBody = (await challenge.json()) as PaymentRequiredResponse;
    const nonce = challengeBody.accepts[0]!.extra.nonce;
    // Build a syntactically valid proof but with a different network.
    const wrongNetworkProof = encodeXPayment({
      x402Version: 1,
      scheme: 'exact',
      network: 'some-other-net',
      payload: { transaction: 'a'.repeat(64), transferId: nonce },
    });
    const res = await fetch(`${gw.baseUrl}/svc/1`, {
      headers: { 'x-payment': wrongNetworkProof },
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequiredResponse).error).toBe('invalid_payment_header');
  });

  it("an invoice for one service can't be spent on another (unknown_nonce)", async () => {
    const proof = await payInvoice(gw, 1);
    const res = await fetch(`${gw.baseUrl}/svc/3`, { headers: proofHeaders(proof) });
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequiredResponse).error).toBe('unknown_nonce');
  });

  it('underpayment → 402 with verifyTransfer reason amount_too_low', async () => {
    const proof = await payInvoice(gw, 1, { amountMotes: '499999999' });
    const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredResponse;
    expect(body.error).toBe('amount_too_low');
    expect(body.accepts[0]!.extra.nonce).not.toBe(proof.nonce);
  });

  it('unknown deploy hash → 402 not_found', async () => {
    const challenge = await fetch(`${gw.baseUrl}/svc/1`);
    const body = (await challenge.json()) as PaymentRequiredResponse;
    const nonce = body.accepts[0]!.extra.nonce;
    const network = body.accepts[0]!.network;
    const res = await fetch(`${gw.baseUrl}/svc/1`, {
      headers: proofHeaders({ deployHash: 'f'.repeat(64), nonce, network }),
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequiredResponse).error).toBe('not_found');
  });

  it('pending payment → 402 Retry-After:2 with the SAME nonce, then succeeds', async () => {
    const proof = await payInvoice(gw, 1, { pendingReads: 1 });
    const pending = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    expect(pending.status).toBe(402);
    expect(pending.headers.get('retry-after')).toBe('2'); // seconds, standard header
    const pendingBody = (await pending.json()) as PaymentRequiredResponse;
    expect(pendingBody.error).toBe('settlement_pending');
    expect(pendingBody.accepts[0]!.extra.nonce).toBe(proof.nonce); // invoice stays alive

    const retry = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
    expect(retry.status).toBe(200);
  });

  it('upstream 500 passes through and attestation records success=false', async () => {
    const before = gw.fake.attestations.length;
    const proof = await payInvoice(gw, 2);
    const res = await fetch(`${gw.baseUrl}/svc/2`, { headers: proofHeaders(proof) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' }); // upstream body passthrough
    await until(() => gw.fake.attestations.length === before + 1);
    expect(gw.fake.attestations[before]).toMatchObject({
      serviceId: 2,
      paymentDeployHash: proof.deployHash,
      success: false,
    });
  });

  it('GET /svc/:id/meta is public and includes score + trust tier', async () => {
    const res = await fetch(`${gw.baseUrl}/svc/1/meta`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      service: { id: number; name: string; endpointUrl: string };
      score: { totalCalls: number; successCalls: number };
      trustTier: string;
    };
    expect(body.service.id).toBe(1);
    expect(body.service.name).toBe('Gold Spot Feed');
    expect(body.score.totalCalls).toBeGreaterThanOrEqual(0);
    expect(['new', 'reliable', 'trusted']).toContain(body.trustTier);
    expect(JSON.stringify(body)).not.toContain(upstream.url); // never the upstream
    expect((await fetch(`${gw.baseUrl}/svc/999/meta`)).status).toBe(404);
  });

  it('oversized inbound JSON → 413, malformed JSON → 400', async () => {
    const big = await fetch(`${gw.baseUrl}/svc/3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(300 * 1024) }),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'payload_too_large' });

    const bad = await fetch(`${gw.baseUrl}/svc/3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_json' });
  });
});

describe('expired invoices', () => {
  it('a proof presented after INVOICE_TTL_MS → 402 invoice_expired + fresh invoice', async () => {
    const gw = await bootGateway({ config: testConfig({ invoiceTtlMs: 60 }) });
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 1 });
      await adminMap(gw, 1, `${upstream.url}/data`);
      const proof = await payInvoice(gw, 1);
      await sleep(120);
      const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(res.status).toBe(402);
      const body = (await res.json()) as PaymentRequiredResponse;
      expect(body.error).toBe('invoice_expired');
      expect(body.accepts[0]!.extra.nonce).not.toBe(proof.nonce);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});

describe('proxy hardening', () => {
  it('unreachable upstream → 502 with constant error code, no upstream URL leaked, no attestation (F4)', async () => {
    const gw = await bootGateway();
    try {
      gw.fake.addService({ id: 1 });
      // 127.0.0.1:1 — allowed in mock mode, but nothing listens there.
      await adminMap(gw, 1, 'http://127.0.0.1:1/secret-path');
      const proof = await payInvoice(gw, 1);
      const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'upstream_unreachable' });
      expect(text).not.toContain('127.0.0.1:1');
      expect(text).not.toContain('secret-path');
      // F4: a gateway-level failure (upstream unreachable) is the seller's backend
      // being down, not a service outcome — it is not scored either way.
      await sleep(100);
      expect(gw.fake.attestations.length).toBe(0);
    } finally {
      await gw.close();
    }
  });

  it('slow upstream → 504 upstream_timeout after UPSTREAM_TIMEOUT_MS', async () => {
    const gw = await bootGateway({ config: testConfig({ upstreamTimeoutMs: 100 }) });
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 1 });
      await adminMap(gw, 1, `${upstream.url}/slow`); // /slow answers after 400 ms
      const proof = await payInvoice(gw, 1);
      const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({ error: 'upstream_timeout' });
      // F4: an upstream timeout is a gateway-level failure — not scored either way.
      await sleep(100);
      expect(gw.fake.attestations.length).toBe(0);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('upstream responses above 1 MiB → 502 upstream_response_too_large', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 1 });
      await adminMap(gw, 1, `${upstream.url}/big`); // 2 MiB body
      const proof = await payInvoice(gw, 1);
      const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'upstream_response_too_large' });
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});

describe('attestation retry', () => {
  it('a failed recordAttestation is retried once after the configured delay', async () => {
    const gw = await bootGateway({ attestationRetryDelayMs: 50 });
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 1 });
      await adminMap(gw, 1, `${upstream.url}/data`);
      gw.fake.failAttestations = 1; // first attempt throws
      const proof = await payInvoice(gw, 1);
      const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(res.status).toBe(200); // buyer response is never blocked
      await until(() => gw.fake.attestations.length === 1);
      expect(gw.fake.attestations[0]).toMatchObject({
        serviceId: 1,
        paymentDeployHash: proof.deployHash,
        success: true,
      });
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('all attestation attempts failing → buyer still served, no attestation recorded', async () => {
    const gw = await bootGateway({ attestationRetryDelayMs: 50, attestationMaxAttempts: 2 });
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 1 });
      await adminMap(gw, 1, `${upstream.url}/data`);
      gw.fake.failAttestations = 2; // initial attempt AND the single retry throw
      const proof = await payInvoice(gw, 1);
      const res = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
      expect(res.status).toBe(200); // payment is captured, buyer is served regardless
      // Give the retry timer (50ms) time to fire and also fail.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(gw.fake.attestations.length).toBe(0); // nothing recorded after both failures
      expect(gw.fake.failAttestations).toBe(0); // both attempts were consumed
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});

describe('admin API', () => {
  it('rejects missing/wrong bearer tokens with 401 on every admin route', async () => {
    const gw = await bootGateway();
    try {
      const noAuth = await fetch(`${gw.baseUrl}/admin/services`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serviceId: 1, upstreamUrl: 'http://example.com' }),
      });
      expect(noAuth.status).toBe(401);
      expect(await noAuth.json()).toEqual({ error: 'unauthorized' });

      const wrongToken = await fetch(`${gw.baseUrl}/admin/services`, {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(wrongToken.status).toBe(401);

      const del = await fetch(`${gw.baseUrl}/admin/services/1`, { method: 'DELETE' });
      expect(del.status).toBe(401);
    } finally {
      await gw.close();
    }
  });

  it('validates payloads: bad serviceId and non-http(s) URLs → 400', async () => {
    const gw = await bootGateway();
    try {
      const headers = {
        authorization: `Bearer ${gw.config.adminToken}`,
        'content-type': 'application/json',
      };
      const badId = await fetch(`${gw.baseUrl}/admin/services`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ serviceId: -1, upstreamUrl: 'http://example.com' }),
      });
      expect(badId.status).toBe(400);
      expect(await badId.json()).toEqual({ error: 'invalid_service_id' });

      for (const upstreamUrl of ['ftp://example.com/x', 'not a url', 'http://user:pw@example.com/']) {
        const res = await fetch(`${gw.baseUrl}/admin/services`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ serviceId: 1, upstreamUrl }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid_upstream_url' });
      }
    } finally {
      await gw.close();
    }
  });

  it('lists and deletes mappings; mappings persist across a restart (atomic file)', async () => {
    const gw = await bootGateway();
    const headers = { authorization: `Bearer ${gw.config.adminToken}` };
    try {
      expect((await adminMap(gw, 7, 'http://example.com/feed')).status).toBe(204);
      expect((await adminMap(gw, 9, 'http://example.org/other')).status).toBe(204);
      const list = await fetch(`${gw.baseUrl}/admin/services`, { headers });
      expect(await list.json()).toEqual([
        { serviceId: 7, upstreamUrl: 'http://example.com/feed' },
        { serviceId: 9, upstreamUrl: 'http://example.org/other' },
      ]);
      const del = await fetch(`${gw.baseUrl}/admin/services/9`, { method: 'DELETE', headers });
      expect(del.status).toBe(204);
    } finally {
      await gw.close();
    }

    // Reboot on the same upstreams file — mapping must have been loaded at boot.
    const gw2 = await bootGateway({ upstreamsFile: gw.upstreamsFile });
    try {
      const list = await fetch(`${gw2.baseUrl}/admin/services`, {
        headers: { authorization: `Bearer ${gw2.config.adminToken}` },
      });
      expect(await list.json()).toEqual([{ serviceId: 7, upstreamUrl: 'http://example.com/feed' }]);
    } finally {
      await gw2.close();
    }
  });

  it('SSRF guard: live mode rejects private/loopback upstream hosts, mock mode allows them', async () => {
    const liveGw = await bootGateway({
      config: testConfig({
        mode: 'live',
        adminToken: 'live-admin-secret',
        csprCloudApiKey: 'test-key',
        // Live mode now requires an attestor signer path (fail-closed); this
        // test never attests, so a placeholder path is sufficient.
        gateSignerPemPath: '/tmp/agentgate-test-gate-signer.pem',
      }),
    });
    try {
      const headers = {
        authorization: 'Bearer live-admin-secret',
        'content-type': 'application/json',
      };
      const privateUrls = [
        'http://127.0.0.1:4010/feed',
        'http://localhost:4010/feed',
        'http://sub.localhost/feed',
        'http://10.1.2.3/feed',
        'http://172.16.0.1/feed',
        'http://192.168.1.1/feed',
        'http://169.254.169.254/latest/meta-data', // cloud metadata
        'http://[::1]:8080/feed',
        'http://[fd00::1]/feed',
        'http://0.0.0.0/feed',
        'http://2130706433/feed', // decimal spelling of 127.0.0.1
      ];
      for (const upstreamUrl of privateUrls) {
        const res = await fetch(`${liveGw.baseUrl}/admin/services`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ serviceId: 1, upstreamUrl }),
        });
        expect(res.status, upstreamUrl).toBe(400);
        expect(await res.json()).toEqual({ error: 'forbidden_upstream_host' });
      }
      const publicRes = await fetch(`${liveGw.baseUrl}/admin/services`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ serviceId: 1, upstreamUrl: 'https://api.example.com/gold' }),
      });
      expect(publicRes.status).toBe(204);
    } finally {
      await liveGw.close();
    }

    // Mock mode: loopback upstreams are explicitly allowed (local demo).
    const mockGw = await bootGateway();
    try {
      expect((await adminMap(mockGw, 1, 'http://127.0.0.1:4010/feed')).status).toBe(204);
    } finally {
      await mockGw.close();
    }
  });
});

describe('request hardening', () => {
  it('rejects a non-JSON request body with 415 before charging or proxying', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 1 });
      await adminMap(gw, 1, `${upstream.url}/echo`);
      const res = await fetch(`${gw.baseUrl}/svc/1`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
      // Never charged, never delivered: the upstream saw nothing.
      expect(upstream.seen.length).toBe(0);
    } finally {
      await upstream.close();
      await gw.close();
    }
  });

  it('serves /readyz when the chain is reachable', async () => {
    const gw = await bootGateway();
    try {
      const res = await fetch(`${gw.baseUrl}/readyz`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ready: boolean }).ready).toBe(true);
    } finally {
      await gw.close();
    }
  });

  it('refuses to build a live-mode app without a gate signer (fail closed)', () => {
    expect(() =>
      createApp({
        config: testConfig({
          mode: 'live',
          csprCloudApiKey: 'k',
          adminToken: 'a-strong-unique-token',
          gateSignerPemPath: '',
        }),
        chain: new FakeChainClient(),
        logger: silentLogger,
      }),
    ).toThrow(AgentGateError);
  });
});

describe('rate limiting', () => {
  it('limits /svc to 60 requests per minute per IP', async () => {
    const gw = await bootGateway();
    try {
      gw.fake.addService({ id: 1 });
      let limited = 0;
      for (let i = 0; i < 61; i += 1) {
        const res = await fetch(`${gw.baseUrl}/svc/1/meta`);
        if (res.status === 429) limited += 1;
        await res.arrayBuffer(); // drain
      }
      expect(limited).toBe(1);
    } finally {
      await gw.close();
    }
  });
});
