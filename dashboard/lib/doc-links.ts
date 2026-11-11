/**
 * Single source of truth for the docs information architecture. Kept in a
 * plain (non-'use client') module so both server code (sitemap, metadata) and
 * client components (sidebar, search) can import the same ordered list.
 *
 * Get started → Use NearGate → Concepts → Reference. The sidebar, the search
 * palette, the prev/next pager, the sitemap and the /docs overview map all
 * render from this, so they never drift (a link test checks every href
 * resolves to a page).
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
        keywords: ['neargate', 'x402', '402', 'what is', 'roles', 'seller', 'buyer', 'operator', 'near'],
      },
      {
        href: '/docs/quickstart',
        label: 'Quickstart',
        keywords: ['demo', 'npm run demo', 'dev:seed', 'mock', 'offline', 'testnet', 'near:bootstrap', 'near:deploy', 'near:seed', 'smoke:live', 'DRY_RUN', 'tutorial'],
      },
    ],
  },
  {
    label: 'Use NearGate',
    hint: 'Sell an API, buy a call, or plug the catalog into an agent.',
    links: [
      {
        href: '/docs/cli',
        label: 'CLI & MCP',
        keywords: ['neargate', 'wrap', 'map', 'buy', 'list', 'status', 'pause', 'resume', 'demo-accounts', 'escrow', 'agent-key', '--from-escrow', '--allowance', 'neargate_escrow_balance', 'fromEscrow', 'ERR_ESCROW_INSUFFICIENT', 'mcp', 'claude desktop', '--account', '--key-file', '--max', '--price', '--registry', '--rpc', '--mode', 'neargate_buy', 'neargate_list_services', 'error codes', 'BUDGET_EXCEEDED', 'PAID_NOT_SERVED', 'TX_TIMEOUT', 'RPC_TIMEOUT', 'SIGNER_KEY_NOT_FOUND', 'REGISTRY_MISMATCH', 'SERVICE_MISMATCH', 'troubleshooting'],
      },
    ],
  },
  {
    label: 'Concepts',
    links: [
      {
        href: '/docs/protocol',
        label: 'How it works',
        keywords: ['nonce', 'X-PAYMENT', 'X-PAYMENT-RESPONSE', 'invoice', '402', 'PaymentRequiredResponse', 'accepts', 'maxAmountRequired', 'storage fee', 'pay', 'attestation', 'receipts', 'receipt', 'x402Version', 'near-testnet', 'near-mock', 'protocol', 'flow', 'verification', 'settlement_pending'],
      },
      {
        href: '/docs/security',
        label: 'Security model',
        keywords: ['trust model', 'ssrf', 'replay', 'self-payment', 'wash trading', 'self-map', 'owner signature', 'full access key', 'admin token', 'rate limit', 'keys', 'TRUST_PROXY', 'redirect', 'budget cap', 'attestor', 'guards', 'agent key', 'function-call key', 'spending limit', 'blast radius', 'escrow'],
      },
    ],
  },
  {
    label: 'Reference',
    links: [
      {
        href: '/docs/contract',
        label: 'Registry contract',
        keywords: ['neargate-registry', 'near-sdk', 'rust', 'register_service', 'pay', 'record_attestation', 'set_active', 'set_attestor', 'get_service', 'list_services', 'services_count', 'get_score', 'get_attestations', 'get_payment', 'get_recent_activity', 'deposit_escrow', 'withdraw_escrow', 'pay_from_escrow', 'escrow_of', 'ESCROW_STORAGE_FEE_YOCTO', 'ERR_ONE_YOCTO_REQUIRED', 'ERR_DEPOSIT_NOT_ALLOWED', 'views', 'events', 'NEP-297', 'storage', 'yocto', 'ERR_', 'ERR_NONCE_USED', 'ERR_SELF_PAYMENT', 'ERR_DEPOSIT_TOO_LOW', 'ABI'],
      },
    ],
  },
];

/** Flat, ordered list (derived) — drives the prev/next pager, search and the sitemap. */
export const DOC_LINKS: DocLink[] = DOC_GROUPS.flatMap((g) => g.links);
