/**
 * The CLI commands the site shows run from any folder: they use the npm binary (`npm install -g
 * @neargate/cli`, then `neargate …`). The repository's `npm run neargate -- …` exists only at the
 * root of a clone (anywhere else npm answers `Missing script: "neargate"`), so on the pages a
 * visitor meets first it appears only where the text says it is the clone form. The quickstart's
 * local-stack sections run inside the clone (`npm run dev`) and keep the clone form.
 * Rendered, so a command that moves into another component is still checked.
 */
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GATEWAY_ACCOUNT_ID, DEFAULT_GATEWAY_URL, type ServiceRecord } from '@agentgate/shared';
import CliPage from '@/app/docs/cli/page';
import QuickstartPage from '@/app/docs/quickstart/page';
import Home from '@/app/page';
import { CatalogGrid } from '@/components/catalog-grid';
import { ServiceDetail } from '@/components/service-detail';
import type { ServiceDetailResponse, ServicesResponse } from '@/lib/api-types';

/** Text only: tags dropped, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const page = (p: () => React.JSX.Element): string => text(renderToStaticMarkup(createElement(p)));

function withData<P extends object>(fallback: Record<string, unknown>, component: FunctionComponent<P>, props: P): string {
  return text(renderToStaticMarkup(createElement(SWRConfig, { value: { fallback } }, createElement(component, props))));
}

const SERVICE: ServiceRecord = {
  id: 1,
  name: 'USD exchange rates',
  description: 'rates',
  endpointUrl: `${DEFAULT_GATEWAY_URL}/svc/1`,
  priceYocto: '10000000000000000000000',
  paymentTarget: 'seller.testnet',
  owner: 'seller.testnet',
  attestor: DEFAULT_GATEWAY_ACCOUNT_ID,
  active: true,
  createdAt: Date.now(),
  accepts: [{ asset: 'near', amount: '10000000000000000000000', decimals: 24, symbol: 'NEAR' }],
};

const emptyCatalog: ServicesResponse = { network: 'near-testnet', services: [] };
const serviceDetail: ServiceDetailResponse = {
  network: 'near-testnet',
  explorerUrl: 'https://testnet.nearblocks.io',
  mode: 'live',
  service: SERVICE,
  score: { totalCalls: 1, successCalls: 1 },
  trustTier: 'new',
  attestations: [],
  revenueYocto: '10000000000000000000000',
  balanceYocto: null,
};

/** The quickstart's "Try the live deployment" section: the part a visitor without a clone follows. */
function quickstartLive(): string {
  const all = page(QuickstartPage);
  const start = all.indexOf('Try the live deployment');
  const end = all.indexOf('Prerequisites', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return all.slice(start, end);
}

const SURFACES: Array<{ name: string; text: () => string }> = [
  { name: 'home', text: () => page(Home) },
  { name: 'catalog (empty registry)', text: () => withData({ '/api/services': emptyCatalog }, CatalogGrid, {}) },
  { name: 'service page', text: () => withData({ '/api/services/1': serviceDetail }, ServiceDetail, { id: 1 }) },
  { name: 'quickstart, live section', text: quickstartLive },
  { name: 'CLI reference', text: () => page(CliPage) },
];

describe('the CLI commands on the site run from any folder', () => {
  it.each(SURFACES)('$name names `npm run neargate --` only as the clone form', ({ text: surface }) => {
    const out = surface();
    for (const m of out.matchAll(/npm run neargate --/g)) {
      const before = out.slice(Math.max(0, m.index - 300), m.index);
      expect(before, `…${before}npm run neargate --`).toMatch(/clone/);
    }
  });

  it('the home page and the empty catalog show the install and a wrap the hosted gateway will score', () => {
    const wrap = `neargate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" --account alice.testnet --attestor ${DEFAULT_GATEWAY_ACCOUNT_ID} --gateway ${DEFAULT_GATEWAY_URL}`;
    for (const out of [page(Home), withData({ '/api/services': emptyCatalog }, CatalogGrid, {})]) {
      expect(out).toContain('npm install -g @neargate/cli');
      expect(out).toContain(wrap);
    }
    expect(page(Home)).toContain('neargate list');
  });

  it('the service page shows `neargate buy <id>` with the install', () => {
    const out = withData({ '/api/services/1': serviceDetail }, ServiceDetail, { id: 1 });
    expect(out).toContain('npm install -g @neargate/cli');
    expect(out).toContain('neargate buy 1 --max <near> --account <your account>');
  });

  it('the quickstart lets a visitor without a clone read the live catalog, and says where the clone form runs', () => {
    const live = quickstartLive();
    for (const cmd of ['npm install -g @neargate/cli', 'neargate list', 'neargate status 1', 'npx -y @neargate/cli status 1', 'neargate buy 1 --max 0.02']) {
      expect(live).toContain(cmd);
    }
    expect(live).toContain('Missing script: "neargate"');
  });

  it('the CLI reference uses the binary in its examples', () => {
    const out = page(CliPage);
    for (const cmd of ['neargate status <id>', 'neargate list', 'neargate buy <id> --account <buyer>', 'neargate escrow balance [account]']) {
      expect(out).toContain(cmd);
    }
    expect([...out.matchAll(/npm run neargate --/g)]).toHaveLength(1);
  });
});
