import { describe, it, expect } from 'vitest';
import { isSelfPaid, type PaymentRequiredResponse, type ServiceRecord } from '@agentgate/shared';
import { bootGateway, startUpstream, adminMap, proofHeaders, sleep } from './helpers';

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

describe('isSelfPaid (shared rule the gateway applies) — F1 wash-trade guard', () => {
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

describe('self-paid call is served but not scored — F1', () => {
  it('payer == payment target → 200 to the buyer but no attestation recorded', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      const target = 'payout.mock';
      gw.fake.addService({ id: 7, paymentTarget: target });
      await adminMap(gw, 7, `${upstream.url}/data`);

      const challenge = await fetch(`${gw.baseUrl}/svc/7`);
      const body = (await challenge.json()) as PaymentRequiredResponse;
      const req = body.accepts[0]!;
      // Pay from the payout account itself — a wash-trade attempt.
      const { txHash } = await gw.fake.pay(
        { serviceId: 7, nonce: req.extra.nonce, depositYocto: req.maxAmountRequired },
        { kind: 'mock', accountId: target },
      );
      const res = await fetch(`${gw.baseUrl}/svc/7`, {
        headers: proofHeaders({ txHash, nonce: req.extra.nonce, network: req.network, payer: target }),
      });
      expect(res.status).toBe(200); // the buyer paid, so they are still served
      await sleep(100);
      expect(gw.fake.attestations.filter((a) => a.serviceId === 7).length).toBe(0); // never scored
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});
