/**
 * Single source of truth for the docs information architecture. Kept in a
 * plain (non-'use client') module so both server code (sitemap, metadata) and
 * client components (sidebar, search) can import the same ordered list.
 *
 * Role-oriented IA: Get started → For sellers → For buyers → Run a gateway →
 * Concepts → Reference. The sidebar and the /docs overview map both render
 * from this, so the two never drift.
 */
export interface DocLink {
  href: string;
  label: string;
}

export interface DocGroup {
  label: string;
  /** One-line descriptor shown under the group label to orient the reader. */
  hint?: string;
  links: DocLink[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    label: 'Get started',
    links: [
      { href: '/docs', label: 'Overview' },
      { href: '/docs/quickstart', label: 'Quickstart' },
      { href: '/docs/installation', label: 'Installation' },
    ],
  },
  {
    label: 'For sellers',
    hint: 'Wrap your HTTP API into a paid, on-chain service.',
    links: [
      { href: '/docs/sellers', label: 'Wrap an API' },
      { href: '/docs/cli', label: 'CLI' },
    ],
  },
  {
    label: 'For buyers',
    hint: 'Build an agent that discovers, pays and rates services.',
    links: [
      { href: '/docs/buyers', label: 'Build an agent' },
      { href: '/docs/sdk', label: 'Client SDK' },
    ],
  },
  {
    label: 'Run a gateway',
    hint: 'Self-host the 402 middleware, or use the hosted one.',
    links: [{ href: '/docs/deployment', label: 'Deploy to production' }],
  },
  {
    label: 'Concepts',
    links: [
      { href: '/docs/protocol', label: 'How it works' },
      { href: '/docs/architecture', label: 'Architecture' },
      { href: '/docs/security', label: 'Security model' },
    ],
  },
  {
    label: 'Reference',
    links: [
      { href: '/docs/api', label: 'HTTP API' },
      { href: '/docs/configuration', label: 'Configuration' },
      { href: '/docs/contract', label: 'Smart contracts' },
      { href: '/docs/errors', label: 'Error codes' },
      { href: '/docs/changelog', label: 'Changelog' },
    ],
  },
];

/** Flat, ordered list (derived) — used for prev/next, search and the sitemap. */
export const DOC_LINKS: DocLink[] = DOC_GROUPS.flatMap((g) => g.links);
