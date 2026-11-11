import type { Metadata } from 'next';
import { DEFAULT_DASHBOARD_URL } from '@agentgate/shared';
import { httpUrl } from './links';

/** The dashboard's dev origin (`npm run dev:dashboard`): the last resort for SITE_URL. */
const LOCAL_ORIGIN = 'http://localhost:3000';

/**
 * Origin for absolute URLs (canonical, OpenGraph, sitemap, robots, metadataBase): the origin the
 * dashboard is served from. Set NEXT_PUBLIC_SITE_URL at build time (Next inlines it); without it
 * this is DEFAULT_DASHBOARD_URL (the shared hosted dashboard, empty until the team hosts NearGate)
 * and then the local dev origin, so it is always a usable URL and never an old host.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  DEFAULT_DASHBOARD_URL ||
  LOCAL_ORIGIN
).replace(/\/+$/, '');

/**
 * The source repository (nav, footer, home page). Set NEXT_PUBLIC_REPO_URL at build time to show
 * the links; there is no default, so while it is unset (or not an http(s) URL) they are hidden.
 */
export const REPO_URL: string | null = httpUrl(process.env.NEXT_PUBLIC_REPO_URL?.trim() ?? '');

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
