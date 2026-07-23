/**
 * Response shapes of the dashboard's own /api/* routes.
 * Shared between the route handlers (server) and the SWR consumers (client).
 */
import type {
  ActivityEvent,
  AttestationRecord,
  Motes,
  ServiceRecord,
  ServiceScore,
  TrustTier,
} from '@agentgate/shared';

export interface FacilitatorPrice {
  /** Atomic token amount charged on the x402 facilitator rail (decimal string). */
  amount: Motes;
  /** Token symbol, e.g. "WCSPR". */
  symbol: string;
  /** Token decimals for display (WCSPR = 9). */
  decimals: number;
}

export interface CatalogEntry {
  service: ServiceRecord;
  score: ServiceScore;
  trustTier: TrustTier;
  /**
   * Set when the service settles on the x402 facilitator rail (a CEP-18 token),
   * from the gateway's FACILITATOR_SERVICES config. The on-chain `priceMotes` is
   * the native-CSPR nominal; this is what a facilitator buy actually charges.
   */
  facilitator?: FacilitatorPrice;
}

export interface ServicesResponse {
  network: string;
  services: CatalogEntry[];
}

export interface ServiceDetailResponse {
  network: string;
  mode: 'mock' | 'live';
  service: ServiceRecord;
  score: ServiceScore;
  trustTier: TrustTier;
  attestations: AttestationRecord[];
  /** price × successCalls, computed server-side with bigint math. */
  revenueMotes: Motes;
  /** getBalance(paymentTarget) — mock mode only, null in live or on failure. */
  balanceMotes: Motes | null;
  /** Facilitator-rail token price, when this service settles in a CEP-18 token. */
  facilitator?: FacilitatorPrice;
}

export interface ActivityResponse {
  network: string;
  events: ActivityEvent[];
  /** True when served from the server cache because a live refresh failed (e.g. CSPR.cloud quota). */
  stale?: boolean;
}

export interface StatsResponse {
  network: string;
  services: number;
  activeServices: number;
  totalCalls: number;
  successCalls: number;
  /** Σ price × successCalls across all services (bigint-safe motes string). */
  revenueMotes: Motes;
}

export interface ApiErrorBody {
  error: string;
}
