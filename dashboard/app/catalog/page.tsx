import type { Metadata } from 'next';
import { CatalogGrid } from '@/components/catalog-grid';

export const metadata: Metadata = {
  title: 'Catalog',
  description: 'On-chain catalog of paid x402 services on Casper.',
};

export default function CatalogPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="microlabel text-accent">service registry</p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        Catalog
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-mut">
        Every service below is registered on-chain with a price, a payment target and a public
        reputation score. Agents discover, pay and rate them autonomously.
      </p>
      <div className="mt-10">
        <CatalogGrid />
      </div>
    </div>
  );
}
