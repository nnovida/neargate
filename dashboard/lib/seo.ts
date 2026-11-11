import type { Metadata } from 'next';
import { DEFAULT_DASHBOARD_URL } from '@agentgate/shared';

/**
 * Production origin for absolute URLs (canonical, OpenGraph, sitemap, robots).
 * Set NEXT_PUBLIC_SITE_URL to the deployment's origin; without it this falls back to the shared
 * DEFAULT_DASHBOARD_URL (the one place the hosted dashboard URL is defined).
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_DASHBOARD_URL).replace(/\/+$/, '');

/** The source repository (nav, footer, home page, docs). */
export const REPO_URL = 'https://example.invalid/AgentGate';

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
