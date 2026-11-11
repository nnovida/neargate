import type { Request, Response } from 'express';
import { verifyNearSignature } from '@agentgate/chain';
import {
  buildSelfMapMessage,
  isBase64,
  isEd25519PublicKey,
  isNearAccountId,
  SELF_MAP_WINDOW_MS,
  type AgentGateConfig,
  type ChainClient,
  type Logger,
  type ServiceRecord,
} from '@agentgate/shared';
import { parseServiceId } from './service-id';
import { validateUpstreamUrl } from './ssrf';
import type { UpstreamStore } from './upstream-store';

/** An ed25519 signature is 64 bytes: 88 base64 chars. Anything much longer is not one. */
const SIGNATURE_B64_MAX_CHARS = 128;

export interface SelfMapDeps {
  config: AgentGateConfig;
  chain: ChainClient;
  logger: Logger;
  upstreams: UpstreamStore;
  /** Cached service lookup (`null` when the service does not exist). */
  getService(id: number): Promise<ServiceRecord | null>;
}

interface SelfMapBody {
  upstreamUrl: string;
  accountId: string;
  publicKey: string;
  timestamp: number;
  signature: string;
}

/** Body shape only: no chain call may happen on a body that fails this (the chain rejects malformed ids). */
function parseBody(body: unknown): SelfMapBody | null {
  if (body === null || typeof body !== 'object') return null;
  const { upstreamUrl, accountId, publicKey, timestamp, signature } = body as Record<string, unknown>;
  if (
    typeof upstreamUrl !== 'string' ||
    !isNearAccountId(accountId) ||
    !isEd25519PublicKey(publicKey) ||
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    !isBase64(signature) ||
    signature.length > SIGNATURE_B64_MAX_CHARS
  ) {
    return null;
  }
  return { upstreamUrl, accountId, publicKey, timestamp, signature };
}

/**
 * `POST /services/:id/map`: a service OWNER maps their upstream by signing a canonical
 * challenge (`buildSelfMapMessage`) with a full-access key of their NEAR account, with no
 * shared admin token. This is what lets `agentgate wrap` run against a hosted gateway in one
 * line. The order is DoS-conscious: cheap rejects first, the signature only for a service that
 * exists and a fresh request, the chain call only for a signature that verifies and an
 * account that owns the service, the SSRF check only for a verified owner.
 *
 *   id syntax 400 → body shape 400 → service exists 404 → fresh 400 stale_timestamp →
 *   signature 401 owner_signature_invalid → account is the owner 403 not_service_owner →
 *   full-access key 403 key_not_full_access (chain error 503) → newer than the last accepted
 *   map 409 replayed → upstream URL passes the SSRF guard 400 → map + persist 204.
 */
export function createSelfMapHandler(deps: SelfMapDeps): (req: Request, res: Response) => Promise<void> {
  const { config, chain, logger, upstreams, getService } = deps;
  // Per-service monotonic timestamp of the last ACCEPTED map; a rejected request never moves it.
  const lastSelfMapTs = new Map<number, number>();

  return async (req, res) => {
    const id = parseServiceId(req.params['id']);
    if (id === null) {
      res.status(400).json({ error: 'invalid_service_id' });
      return;
    }
    const body = parseBody(req.body);
    if (body === null) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const { upstreamUrl, accountId, publicKey, timestamp, signature } = body;

    const service = await getService(id);
    if (!service) {
      res.status(404).json({ error: 'service_not_found' });
      return;
    }

    // Freshness: bounds replay independently of the per-service guard below.
    if (Math.abs(Date.now() - timestamp) > SELF_MAP_WINDOW_MS) {
      res.status(400).json({ error: 'stale_timestamp' });
      return;
    }

    // The signature covers the RAW transmitted upstreamUrl (byte-identical to what the owner
    // signed), this network and this service id, so it cannot be replayed elsewhere.
    const message = buildSelfMapMessage({ network: chain.network, serviceId: id, upstreamUrl, timestamp });
    if (!verifyNearSignature(publicKey, message, signature)) {
      res.status(401).json({ error: 'owner_signature_invalid' });
      return;
    }

    if (accountId !== service.owner) {
      res.status(403).json({ error: 'not_service_owner' });
      return;
    }

    // The signing key must be a FULL-ACCESS key of the owner account: a function-call key
    // (e.g. a dapp login key) is not the owner's authority over the service.
    let fullAccess: boolean;
    try {
      fullAccess = await chain.isFullAccessKey(accountId, publicKey);
    } catch (err) {
      // Never guess when the chain cannot answer: fail closed, map nothing.
      logger.warn('self_map_key_lookup_failed', {
        serviceId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ error: 'chain_unavailable' });
      return;
    }
    if (!fullAccess) {
      res.status(403).json({ error: 'key_not_full_access' });
      return;
    }

    // Per-service monotonic timestamp: reject stale/replayed authorized requests.
    const last = lastSelfMapTs.get(id);
    if (last !== undefined && timestamp <= last) {
      res.status(409).json({ error: 'replayed' });
      return;
    }

    // SSRF guard: same as the admin path; only reached for a verified owner.
    const verdict = validateUpstreamUrl(upstreamUrl, { rejectPrivateHosts: config.mode === 'live' });
    if (!verdict.ok) {
      res.status(400).json({ error: verdict.error });
      return;
    }

    // Advance the guard before the first await so two concurrent requests cannot both pass the
    // replay check; give it back if the mapping could not be persisted.
    lastSelfMapTs.set(id, timestamp);
    try {
      await upstreams.set(id, verdict.url.toString());
    } catch (err) {
      if (lastSelfMapTs.get(id) === timestamp) {
        if (last === undefined) lastSelfMapTs.delete(id);
        else lastSelfMapTs.set(id, last);
      }
      throw err;
    }
    logger.info('self_mapped', { serviceId: id });
    res.status(204).end();
  };
}
