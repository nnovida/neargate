/**
 * The real data components, rendered with the API payload SWR would fetch (its `fallback`), so the
 * links they emit are checked end to end: live network vs the offline devnet (R39), and a seller's
 * non-http endpoint (R35).
 */
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import { base58Encode, type ActivityEvent, type ServiceRecord } from '@agentgate/shared';
import { ActivityFeed } from '@/components/activity-feed';
import { CatalogGrid } from '@/components/catalog-grid';
import { ServiceDetail } from '@/components/service-detail';
import type { ActivityResponse, ServiceDetailResponse, ServicesResponse } from '@/lib/api-types';

const EXPLORER = 'https://testnet.nearblocks.io';
const PAY_TX = base58Encode(new Uint8Array(32).fill(3));
const OWNER = 'seller.testnet';

function render<P extends object>(fallback: Record<string, unknown>, component: FunctionComponent<P>, props: P): string {
  return renderToStaticMarkup(
    createElement(SWRConfig, { value: { fallback } }, createElement(component, props)),
  );
}

function events(txHash: string | null): ActivityEvent[] {
  return [
    {
      kind: 'payment',
      serviceId: 1,
      account: 'buyer.testnet',
      txHash,
      blockHeight: 190_001,
      amountYocto: '500000000000000000000000',
      nonce: '42',
      timestamp: Date.now(),
      detail: 'buyer.testnet paid 0.5 NEAR to service #1',
    },
  ];
}

function feed(network: string, txHash: string | null): string {
  const body: ActivityResponse = { network, explorerUrl: EXPLORER, events: events(txHash) };
  return render({ '/api/activity?limit=100': body }, ActivityFeed, {});
}

describe('ActivityFeed', () => {
  it('on near-testnet a null-hash event links to its block, a real hash to its transaction', () => {
    expect(feed('near-testnet', null)).toContain(`href="${EXPLORER}/blocks/190001"`);
    expect(feed('near-testnet', PAY_TX)).toContain(`href="${EXPLORER}/txns/${PAY_TX}"`);
  });

  it('on near-mock the transaction is plain text with no explorer link anywhere', () => {
    const out = feed('near-mock', PAY_TX);
    expect(out).toContain(PAY_TX.slice(0, 10));
    expect(out).not.toContain('nearblocks');
  });

  it('shows the NEAR amount of the payment', () => {
    expect(feed('near-mock', PAY_TX)).toContain('0.5 NEAR');
  });
});

function service(endpointUrl: string): ServiceRecord {
  return {
    id: 1,
    name: 'RWA FX & Gold Oracle',
    description: 'feed',
    endpointUrl,
    priceYocto: '500000000000000000000000',
    paymentTarget: OWNER,
    owner: OWNER,
    attestor: 'gateway.testnet',
    active: true,
    createdAt: Date.now(),
    accepts: [{ asset: 'near', amount: '500000000000000000000000', decimals: 24, symbol: 'NEAR' }],
  };
}

function detail(network: string, endpointUrl: string): string {
  const body: ServiceDetailResponse = {
    network,
    explorerUrl: EXPLORER,
    mode: network === 'near-mock' ? 'mock' : 'live',
    service: service(endpointUrl),
    score: { totalCalls: 1, successCalls: 1 },
    trustTier: 'new',
    attestations: [
      { serviceId: 1, nonce: '42', paymentTxHash: PAY_TX, success: true, timestamp: Date.now() },
    ],
    revenueYocto: '500000000000000000000000',
    balanceYocto: null,
  };
  return render({ '/api/services/1': body }, ServiceDetail, { id: 1 });
}

describe('ServiceDetail', () => {
  it('shows the NEAR price, the 1/1 score and the storage fee a buyer attaches', () => {
    const out = detail('near-mock', 'http://localhost:4021/svc/1');
    expect(out).toContain('0.5 NEAR');
    expect(out).toContain('0.5 NEAR + 0.002 NEAR storage');
    expect(out).toContain('1/1');
  });

  it('links owner, payment target and attested payment to the explorer on near-testnet', () => {
    const out = detail('near-testnet', 'https://gateway.example.org/svc/1');
    expect(out).toContain(`href="${EXPLORER}/address/${OWNER}"`);
    expect(out).toContain(`href="${EXPLORER}/txns/${PAY_TX}"`);
    expect(out).toContain('--max &lt;near&gt; --account &lt;your account&gt;');
    expect(out).not.toContain('--mode mock');
  });

  it('links nothing to an explorer on near-mock and tells the CLI to use --mode mock', () => {
    const out = detail('near-mock', 'http://localhost:4021/svc/1');
    expect(out).not.toContain('nearblocks');
    expect(out).toContain('--mode mock');
  });

  it('R35: an https endpoint is a link; a javascript: or data: endpoint is text, never an href', () => {
    const good = detail('near-testnet', 'https://gateway.example.org/svc/1');
    expect(good).toContain('href="https://gateway.example.org/svc/1"');
    for (const hostile of ['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>']) {
      const out = detail('near-testnet', hostile);
      expect(out).not.toMatch(/href="(javascript|data):/i);
      expect(out).toContain('&lt;gateway endpoint&gt;'); // the snippet carries a placeholder, not the value
    }
  });
});

describe('the cached-data notice (stale: true, set when a route served its cache after a failed refresh)', () => {
  const activityBody = (stale: boolean): ActivityResponse => ({
    network: 'near-testnet',
    explorerUrl: EXPLORER,
    events: events(PAY_TX),
    ...(stale ? { stale } : {}),
  });
  const catalogBody = (stale: boolean): ServicesResponse => ({
    network: 'near-testnet',
    services: [{ service: service('https://gateway.example.org/svc/1'), score: { totalCalls: 1, successCalls: 1 }, trustTier: 'new' }],
    ...(stale ? { stale } : {}),
  });
  const detailBody = (stale: boolean): ServiceDetailResponse => ({
    network: 'near-testnet',
    explorerUrl: EXPLORER,
    mode: 'live',
    service: service('https://gateway.example.org/svc/1'),
    score: { totalCalls: 1, successCalls: 1 },
    trustTier: 'new',
    attestations: [],
    revenueYocto: '500000000000000000000000',
    balanceYocto: null,
    ...(stale ? { stale } : {}),
  });

  it('shows on the activity feed, the catalog and a service page, and only when stale', () => {
    const surfaces: Array<{ name: string; html: (stale: boolean) => string; text: string }> = [
      {
        name: 'activity',
        html: (stale) => render({ '/api/activity?limit=100': activityBody(stale) }, ActivityFeed, {}),
        text: 'Showing cached activity',
      },
      {
        name: 'catalog',
        html: (stale) => render({ '/api/services': catalogBody(stale) }, CatalogGrid, {}),
        text: 'Showing the cached catalog',
      },
      {
        name: 'service',
        html: (stale) => render({ '/api/services/1': detailBody(stale) }, ServiceDetail, { id: 1 }),
        text: 'Showing cached data for this service',
      },
    ];
    for (const { name, html, text } of surfaces) {
      expect(html(true), name).toContain(text);
      expect(html(false), name).not.toContain('Retrying automatically');
    }
  });
});
