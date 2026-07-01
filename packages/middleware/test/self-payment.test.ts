import { describe, it, expect } from 'vitest';
import type { PaymentRequiredResponse, ServiceRecord } from '@agentgate/shared';
import { isSelfPayment } from '../src/app';
import { bootGateway, startUpstream, adminMap, proofHeaders, sleep } from './helpers';

const svc = (over: Partial<ServiceRecord> = {}): ServiceRecord => ({
  id: 1,
  name: 'x',
  description: '',
  endpointUrl: '',
  priceMotes: '1',
  paymentTarget: `account-hash-${'ab'.repeat(32)}`,
  owner: `01${'aa'.repeat(32)}`,
  attestor: `01${'bb'.repeat(32)}`,
  active: true,
  createdAt: 0,
  ...over,
});

describe('isSelfPayment — F1 wash-trade guard', () => {
  it('true when the payer is the payout account (prefix- and case-insensitive)', () => {
    expect(isSelfPayment(`account-hash-${'AB'.repeat(32)}`, svc())).toBe(true);
  });
  it('true when the payer is the service owner', () => {
    expect(isSelfPayment(`01${'aa'.repeat(32)}`, svc())).toBe(true);
  });
  it('false for a distinct third-party payer', () => {
    expect(isSelfPayment(`account-hash-${'ee'.repeat(32)}`, svc())).toBe(false);
  });
  it('false for an empty/unknown payer', () => {
    expect(isSelfPayment('', svc())).toBe(false);
  });
});

describe('self-paid call is served but not scored — F1', () => {
  it('payer == payment target → 200 to the buyer but no attestation recorded', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      const target = `account-hash-${'cd'.repeat(32)}`;
      gw.fake.addService({ id: 7, paymentTarget: target });
      await adminMap(gw, 7, `${upstream.url}/data`);

      const challenge = await fetch(`${gw.baseUrl}/svc/7`);
      const body = (await challenge.json()) as PaymentRequiredResponse;
      const req = body.accepts[0]!;
      // Pay from the payout account itself — a wash-trade attempt.
      const { deployHash } = await gw.fake.transfer(
        { to: req.payTo, amountMotes: req.maxAmountRequired, transferId: req.extra.nonce },
        { kind: 'mock', publicKey: target },
      );
      const res = await fetch(`${gw.baseUrl}/svc/7`, {
        headers: proofHeaders({ deployHash, nonce: req.extra.nonce, network: req.network }),
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
