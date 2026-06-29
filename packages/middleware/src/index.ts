/**
 * @agentgate/middleware — 402 paywall reverse proxy + admin API (SPEC §5).
 *
 * - createApp({ config, chain, logger? }): pure express factory, no listen()
 * - startServer(opts): boots the server, returns { port, close() }
 * - InvoiceStore / MemoryInvoiceStore: nonce → invoice persistence seam
 * - UpstreamStore: serviceId → upstream URL map (atomic JSON file)
 */
export { createApp } from './app';
export type { MiddlewareDeps, AppInternals } from './app';
export { startServer } from './server';
export type { MiddlewareStartOpts, RunningServer } from './server';
export { MemoryInvoiceStore } from './invoice-store';
export type { InvoiceStore, StoredInvoice } from './invoice-store';
export { UpstreamStore } from './upstream-store';
export type { UpstreamMapping } from './upstream-store';
export { ServiceCache, SERVICE_CACHE_TTL_MS } from './service-cache';
export { isPrivateHost, validateUpstreamUrl } from './ssrf';
export type { UpstreamUrlValidation } from './ssrf';
export {
  MAX_PROXY_BODY_BYTES,
  HOP_BY_HOP_HEADERS,
  proxyToUpstream,
  isUpstreamSuccess,
} from './proxy';
export type { ProxyOutcome, ProxyFailureCode, ProxyOptions } from './proxy';
export { HEADER_X_PAYMENT, HEADER_X_PAYMENT_RESPONSE } from './types';
export type { PaywallErrorCode } from './types';
