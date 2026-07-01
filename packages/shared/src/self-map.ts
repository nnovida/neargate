/** Freshness window (ms) a self-service map request's timestamp must fall within. */
export const SELF_MAP_WINDOW_MS = 120_000;

export interface SelfMapMessageInput {
  /** Casper network name (e.g. "casper-test") — prevents cross-network replay. */
  network: string;
  /** On-chain service id being mapped — prevents cross-service replay. */
  serviceId: number;
  /** Upstream URL, EXACTLY as transmitted (signed + verified over the same bytes). */
  upstreamUrl: string;
  /** Client clock in ms since epoch — freshness. */
  timestamp: number;
}

/**
 * Canonical, domain-separated bytes a service owner signs to authorize an
 * upstream mapping on the gateway. THE single source of truth: the CLI signs
 * these exact bytes and the gateway rebuilds+verifies them, so both sides must
 * call this one function. The `AgentGate/self-map/v1` prefix + `network` +
 * `serviceId` block cross-protocol / cross-network / cross-service replay;
 * `timestamp` bounds freshness; `upstreamUrl` binds the payload.
 */
export function buildSelfMapMessage(input: SelfMapMessageInput): Uint8Array {
  const text = [
    'AgentGate/self-map/v1',
    input.network,
    String(input.serviceId),
    input.upstreamUrl,
    String(input.timestamp),
  ].join('\n');
  return new TextEncoder().encode(text);
}
