import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodePaymentSignatureHeader, type FacilitatorClient } from '@x402/core/http';
import { bootGateway, adminMap, startUpstream, testConfig, until, type TestGateway, type TestUpstream } from './helpers';
import { FakeChainClient } from './fake-chain';

const PAY_TARGET = `account-hash-${'ab'.repeat(32)}`;
const SETTLE_TX = 's'.repeat(64);
const PAYER = `00${'cd'.repeat(32)}`; // '00'+account-hash, distinct from the payment target (not self-paid)
const ASSET = 'f'.repeat(64);

const FAC_SERVICE = {
  7: { asset: ASSET, amount: '100000000', token: { name: 'Test USD', version: '1', decimals: 9, symbol: 'TUSD' } },
};

/** A fake facilitator whose verify/settle are canned; content of the payload is ignored. */
function fakeFacilitator(over: Partial<{ isValid: boolean; success: boolean }> = {}): FacilitatorClient {
  const isValid = over.isValid ?? true;
  const success = over.success ?? true;
  return {
    verify: vi.fn(async () => (isValid ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: 'invalid_signature' })),
    settle: vi.fn(async () =>
      success
        ? { success: true, transaction: SETTLE_TX, payer: PAYER, network: 'casper:casper-test' }
        : { success: false, transaction: '', network: 'casper:casper-test', errorReason: 'insufficient_balance' },
    ),
    getSupported: vi.fn(async () => ({ kinds: [], extensions: [] })),
  } as unknown as FacilitatorClient;
}

/** A decodable PAYMENT-SIGNATURE header (the fake facilitator ignores its contents). */
function paymentSignatureHeader(): Record<string, string> {
  const payload = {
    x402Version: 2 as const,
    accepted: {
      scheme: 'exact', network: 'casper:casper-test' as const, asset: ASSET, amount: '100000000',
      payTo: `00${'ab'.repeat(32)}`, maxTimeoutSeconds: 300, extra: { name: 'Test USD', version: '1', decimals: 9, symbol: 'TUSD' },
    },
    payload: {
      signature: '00'.repeat(65), publicKey: `02${'ee'.repeat(33)}`,
      authorization: { from: PAYER, to: `00${'ab'.repeat(32)}`, value: '100000000', validAfter: '0', validBefore: '9999999999', nonce: `0x${'11'.repeat(32)}` },
    },
  };
  return { 'payment-signature': encodePaymentSignatureHeader(payload as never) };
}

let gw: TestGateway | undefined;
let upstream: TestUpstream | undefined;
afterEach(async () => {
  await gw?.close();
  await upstream?.close();
  gw = undefined;
  upstream = undefined;
});

describe('middleware · facilitator (x402 v2) rail', () => {
  async function boot(facilitator: FacilitatorClient) {
    const fake = new FakeChainClient();
    fake.addService({ id: 7, paymentTarget: PAY_TARGET, attestor: `01${'bb'.repeat(32)}`, active: true });
    fake.addService({ id: 8, paymentTarget: PAY_TARGET, attestor: `01${'bb'.repeat(32)}`, active: true }); // native
    upstream = await startUpstream();
    gw = await bootGateway({
      fake,
      config: testConfig({ facilitatorServices: FAC_SERVICE }),
      facilitatorClient: facilitator,
      attestationRetryDelayMs: 5,
    });
    await adminMap(gw, 7, `${upstream.url}/data`);
    await adminMap(gw, 8, `${upstream.url}/data`);
    return fake;
  }

  it('a facilitator-enabled service returns a v2 402 when unpaid', async () => {
    await boot(fakeFacilitator());
    const res = await fetch(`${gw!.baseUrl}/svc/7`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: { asset: string; network: string }[] };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]!.asset).toBe(ASSET);
    expect(body.accepts[0]!.network).toBe('casper:casper-test');
  });

  it('a NATIVE service in the same app still returns a v1 402 (coexistence)', async () => {
    await boot(fakeFacilitator());
    const res = await fetch(`${gw!.baseUrl}/svc/8`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: { asset: string }[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]!.asset).toBe('CSPR');
  });

  it('verify→settle→proxy→attest: serves the upstream and records the settle tx as the attestation', async () => {
    const fac = fakeFacilitator();
    const fake = await boot(fac);
    const res = await fetch(`${gw!.baseUrl}/svc/7`, { headers: paymentSignatureHeader() });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hello: string }).toEqual({ hello: 'world', query: {} });
    // settle-before-serve: both facilitator calls ran, in order
    expect((fac.verify as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((fac.settle as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    // X-PAYMENT-RESPONSE carries the settle tx
    const spHeader = res.headers.get('x-payment-response');
    expect(spHeader).toBeTruthy();
    // attestation recorded with the settle tx hash as the payment id
    await until(() => fake.attestations.some((a) => a.serviceId === 7 && a.paymentDeployHash === SETTLE_TX && a.success));
  });

  it('a failed settle re-challenges with 402 and never proxies or attests', async () => {
    const fac = fakeFacilitator({ success: false });
    const fake = await boot(fac);
    const res = await fetch(`${gw!.baseUrl}/svc/7`, { headers: paymentSignatureHeader() });
    expect(res.status).toBe(402);
    expect((fac.settle as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(upstream!.seen.length).toBe(0); // upstream never hit
    expect(fake.attestations.length).toBe(0);
  });
});
