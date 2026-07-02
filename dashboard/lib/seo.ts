import type { Metadata } from 'next';

/**
 * Production origin for absolute URLs (canonical, OpenGraph, sitemap, robots).
 * Defaults to the hosted dashboard; set NEXT_PUBLIC_SITE_URL to override for
 * a self-hosted deployment.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://agentgate.example.org'
).replace(
  /\/+$/,
  '',
);

/**
 * Per-page metadata helper: a unique title + description, a self-referencing
 * canonical, and OpenGraph/Twitter cards derived from the same copy. Relative
 * paths resolve against `metadataBase` (set once in the root layout).
 */
export function docMeta(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}
