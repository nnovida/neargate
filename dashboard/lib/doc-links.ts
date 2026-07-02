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
  /**
   * Search-only synonyms: core vocabulary, error codes, env vars and flags a
   * reader is likely to type into ⌘K. Never rendered in the nav.
   */
  keywords?: string[];
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
      {
        href: '/docs',
        label: 'Overview',
        keywords: ['agentgate', 'x402', '402', 'what is', 'roles', 'seller', 'buyer', 'operator'],
      },
      {
        href: '/docs/quickstart',
        label: 'Quickstart',
        keywords: ['demo', 'npm run demo', 'mock', 'offline', 'hello world', 'getting started', 'tutorial'],
      },
      {
        href: '/docs/installation',
        label: 'Installation',
        keywords: ['install', 'npx', 'node', 'clone', 'npm install', 'prerequisites', 'setup'],
      },
    ],
  },
  {
    label: 'For sellers',
    hint: 'Wrap your HTTP API into a paid, on-chain service.',
    links: [
      {
        href: '/docs/sellers',
        label: 'Wrap an API',
        keywords: ['wrap', 'price', 'pricing', 'pem', 'register', 'upstream', 'self-map', 'paywall', 'monetize', 'payment target', 'attestor', '2.5 CSPR'],
      },
      {
        href: '/docs/cli',
        label: 'CLI',
        keywords: ['wrap', 'list', 'status', 'pause', 'resume', 'demo-accounts', '--pem', '--price', '--gateway', '--mode', 'command', 'flags'],
      },
    ],
  },
  {
    label: 'For buyers',
    hint: 'Build an agent that discovers, pays and rates services.',
    links: [
      {
        href: '/docs/buyers',
        label: 'Build an agent',
        keywords: ['agent', 'fetchPaid', 'budget', 'discover', 'pay', 'retry', 'curl', 'llm', 'claude', 'anthropic', 'task'],
      },
      {
        href: '/docs/sdk',
        label: 'Client SDK',
        keywords: ['fetchPaid', 'client', 'ChainClient', 'typescript', 'types', 'PaymentPayload', 'parsePaymentRequired', 'sdk'],
      },
    ],
  },
  {
    label: 'Run a gateway',
    hint: 'Self-host the 402 middleware, or use the hosted one.',
    links: [
      {
        href: '/docs/deployment',
        label: 'Deploy to production',
        keywords: ['deploy', 'docker', 'pm2', 'cloudflared', 'tunnel', 'self-host', 'hosting', 'INVOICE_STORE_PATH', 'production'],
      },
    ],
  },
  {
    label: 'Concepts',
    links: [
      {
        href: '/docs/protocol',
        label: 'How it works',
        keywords: ['nonce', 'X-PAYMENT', 'transfer_id', 'invoice', '402', 'PaymentRequiredResponse', 'accepts', 'PaymentRequirements', 'settlement', 'attestation', 'burn', 'x402Version', 'X-PAYMENT-RESPONSE', 'protocol', 'flow'],
      },
      {
        href: '/docs/architecture',
        label: 'Architecture',
        keywords: ['packages', 'monorepo', 'devnet', 'middleware', 'chain', 'mock', 'live', 'seam', 'components', 'design'],
      },
      {
        href: '/docs/security',
        label: 'Security model',
        keywords: ['ssrf', 'replay', 'self-payment', 'wash trading', 'threat model', 'admin token', 'rate limit', 'keys', 'TRUST_PROXY', 'guards'],
      },
    ],
  },
  {
    label: 'Reference',
    links: [
      {
        href: '/docs/api',
        label: 'HTTP API',
        keywords: ['endpoints', 'routes', 'healthz', 'svc', 'admin', 'map', 'services', 'X-PAYMENT', '402', 'curl', 'rest'],
      },
      {
        href: '/docs/configuration',
        label: 'Configuration',
        keywords: ['env', 'AGENTGATE_MODE', 'CSPR_CLOUD_API_KEY', 'CASPER_NODE_URL', 'REGISTRY_CONTRACT_PACKAGE_HASH', 'SELLER_SIGNER_PEM_PATH', 'GATE_SIGNER_PEM_PATH', 'INVOICE_TTL_MS', 'INVOICE_STORE_PATH', 'ANTHROPIC_API_KEY', 'TRUST_PROXY', 'ports', 'variables'],
      },
      {
        href: '/docs/contract',
        label: 'Smart contracts',
        keywords: ['odra', 'entry points', 'register_service', 'record_attestation', 'set_active', 'set_attestor', 'events', 'trust score', 'storage', 'package hash', 'wasm', 'rust', 'testnet'],
      },
      {
        href: '/docs/errors',
        label: 'Error codes',
        keywords: ['invoice_expired', 'invoice_used', 'unknown_nonce', 'amount_too_low', 'settlement_pending', 'service_inactive', 'service_unavailable', 'upstream_unreachable', 'MOCK_ONLY', 'SIGNER_MISSING', 'INVALID_PRICE', 'PRICE_EXCEEDED', 'debugging', 'troubleshooting'],
      },
      {
        href: '/docs/changelog',
        label: 'Changelog',
        keywords: ['versions', 'releases', 'history', 'what changed'],
      },
    ],
  },
];

/** Flat, ordered list (derived) — drives the prev/next pager, search and the sitemap. */
export const DOC_LINKS: DocLink[] = DOC_GROUPS.flatMap((g) => g.links);
