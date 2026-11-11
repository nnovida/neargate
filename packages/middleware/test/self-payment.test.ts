import { describe, it, expect } from 'vitest';
import { isSelfPaid, type PaymentRequiredResponse, type ServiceRecord } from '@agentgate/shared';
import { bootGateway, startUpstream, adminMap, payInvoice, proofHeaders, sleep, until } from './helpers';

const svc = (over: Partial<ServiceRecord> = {}): ServiceRecord => ({
  id: 1,
  name: 'x',
  description: '',
  endpointUrl: '',
  priceYocto: '1',
  paymentTarget: 'seller.mock',
  owner: 'owner.mock',
  attestor: 'attestor.mock',
  active: true,
  createdAt: 0,
  accepts: [],
  ...over,
});

describe('isSelfPaid (the shared rule the registry and devnet apply; the gateway follows verdict.selfPaid) — F1 wash-trade guard', () => {
  it('true when the payer is the payout account', () => {
    expect(isSelfPaid('seller.mock', svc())).toBe(true);
  });
  it('true when the payer is the service owner', () => {
    expect(isSelfPaid('owner.mock', svc())).toBe(true);
  });
  it('false for a distinct third-party payer', () => {
    expect(isSelfPaid('buyer.mock', svc())).toBe(false);
  });
  it('false for an empty/unknown payer', () => {
    expect(isSelfPaid('', svc())).toBe(false);
  });
  it('is an exact match: NEAR account ids are lowercase-only, so no other spelling exists', () => {
    expect(isSelfPaid('SELLER.mock', svc())).toBe(false);
  });
});

describe('self-payment is served but not attested — F1', () => {
  it.each([
    ['the payment target', 'payout.mock'],
    ['the service owner', 'owner.mock'],
  ])('payer == %s → 200 to the buyer, no attestation recorded (the registry flags it selfPaid)', async (_who, payer) => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 7, paymentTarget: 'payout.mock', owner: 'owner.mock' });
      await adminMap(gw, 7, `${upstream.url}/data`);

      const challenge = await fetch(`${gw.baseUrl}/svc/7`);
      const body = (await challenge.json()) as PaymentRequiredResponse;
      const req = body.accepts[0]!;
      // Pay from the payout account / owner itself: a wash-trade attempt.
      const { txHash } = await gw.fake.pay(
        { serviceId: 7, nonce: req.extra.nonce, depositYocto: req.maxAmountRequired },
        { kind: 'mock', accountId: payer },
      );
      const res = await fetch(`${gw.baseUrl}/svc/7`, {
        headers: proofHeaders({ txHash, nonce: req.extra.nonce, network: req.network, payer }),
      });
      expect(res.status).toBe(200); // the buyer paid, so they are still served
      expect(res.headers.get('x-payment-response')).not.toBeNull();
      await sleep(100);
      expect(gw.fake.attestations.filter((a) => a.serviceId === 7).length).toBe(0); // never scored
      expect(gw.fake.attestationCalls).toBe(0); // and the gateway did not even try
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('a third-party payer on the same service IS attested', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 7, paymentTarget: 'payout.mock', owner: 'owner.mock' });
      await adminMap(gw, 7, `${upstream.url}/data`);
      const proof = await payInvoice(gw, 7);
      expect((await fetch(`${gw.baseUrl}/svc/7`, { headers: proofHeaders(proof) })).status).toBe(200);
      await until(() => gw.fake.attestations.length === 1);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});
