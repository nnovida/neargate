import { createHash } from 'node:crypto';
import { AgentGateError } from '@agentgate/shared';
import type {
  ActivityEvent,
  AnySigner,
  AttestationRecord,
  ChainClient,
  Motes,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
  SignerRef,
  VerifyResult,
  VerifyTransferQuery,
} from '@agentgate/shared';

const MOTES_RE = /^(0|[1-9]\d*)$/;
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Mock account-hash derivation used by the devnet (SPEC §4):
 * `"account-hash-" + sha256(publicKey) hex` (64 hex chars).
 */
export function mockAccountHash(publicKey: string): string {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new AgentGateError('invalid_public_key', 'publicKey must be a non-empty string', 400);
  }
  return `account-hash-${createHash('sha256').update(publicKey).digest('hex')}`;
}

/** Shape of the devnet's GET /chain/transfers/:deployHash response. */
interface DevnetTransfer {
  deployHash: string;
  fromPublicKey: string;
  from: string;
  to: string;
  amountMotes: Motes;
  transferId: string;
  timestamp: number;
}

/** Devnet is local/in-process, but never let a hung socket block a request forever. */
const DEVNET_REQUEST_TIMEOUT_MS = 30_000;

function invalid(message: string): AgentGateError {
  return new AgentGateError('invalid_query', message, 400);
}

function requireMockSigner(signer: AnySigner): SignerRef {
  if (signer.kind !== 'mock') {
    throw new AgentGateError(
      'invalid_signer',
      `MockChainHttpClient requires a mock signer, got "${signer.kind}"`,
      400,
    );
  }
  if (signer.publicKey.trim() === '') {
    throw new AgentGateError('invalid_signer', 'mock signer publicKey must not be empty', 400);
  }
  return signer;
}

function assertServiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalid(`serviceId must be a positive integer, got ${String(id)}`);
  }
}

/**
 * ChainClient backed by the local devnet's REST API (SPEC §4).
 * Maps every read/write 1:1 onto the SPEC §3 routes.
 */
export class MockChainHttpClient implements ChainClient {
  readonly network = 'mock';
  private readonly baseUrl: string;

  constructor(devnetUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(devnetUrl);
    } catch {
      throw new AgentGateError('invalid_devnet_url', `invalid DEVNET_URL: ${devnetUrl}`, 500);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AgentGateError('invalid_devnet_url', 'DEVNET_URL must be http(s)', 500);
    }
    this.baseUrl = devnetUrl.replace(/\/+$/, '');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEVNET_REQUEST_TIMEOUT_MS),
        // Chain state is live: never let a fetch layer (e.g. Next.js App Router,
        // which patches global fetch and caches by default) serve a stale read.
        // `cache` is a valid web fetch option Node accepts but omits from its types.
        cache: 'no-store',
      } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AgentGateError(
        timedOut ? 'devnet_timeout' : 'devnet_unreachable',
        `devnet request ${timedOut ? 'timed out' : 'failed'} (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`,
        timedOut ? 504 : 502,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const errBody = (parsed ?? {}) as { error?: unknown; message?: unknown };
      throw new AgentGateError(
        typeof errBody.error === 'string' ? errBody.error : 'devnet_error',
        typeof errBody.message === 'string'
          ? errBody.message
          : `devnet responded ${res.status} on ${method} ${path}`,
        res.status,
      );
    }
    return parsed as T;
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>('GET', path)) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('POST', path, body)) as T;
  }

  // ---- reads ----------------------------------------------------------------

  async getService(id: number): Promise<ServiceRecord | null> {
    assertServiceId(id);
    return await this.request<ServiceRecord>('GET', `/chain/services/${id}`, undefined, true);
  }

  async listServices(): Promise<ServiceRecord[]> {
    return await this.get<ServiceRecord[]>('/chain/services');
  }

  async getScore(id: number): Promise<ServiceScore> {
    assertServiceId(id);
    return await this.get<ServiceScore>(`/chain/services/${id}/score`);
  }

  async listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]> {
    assertServiceId(serviceId);
    const qs = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.get<AttestationRecord[]>(`/chain/services/${serviceId}/attestations${qs}`);
  }

  async listRecentActivity(limit?: number): Promise<ActivityEvent[]> {
    const qs = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.get<ActivityEvent[]>(`/chain/activity${qs}`);
  }

  async getBalance(account: string): Promise<Motes> {
    if (typeof account !== 'string' || account.trim() === '') {
      throw invalid('account must be a non-empty string');
    }
    const result = await this.get<{ account: string; balanceMotes: Motes }>(
      `/chain/balance/${encodeURIComponent(account)}`,
    );
    return result.balanceMotes;
  }

  /**
   * Looks up the transfer by deployHash, then checks target → amount →
   * transfer_id → age (SPEC §4). `pending` never occurs in mock mode because
   * devnet transfers settle synchronously.
   */
  async verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult> {
    if (typeof q.deployHash !== 'string' || q.deployHash.trim() === '') {
      throw invalid('deployHash must be a non-empty string');
    }
    if (typeof q.expectedTarget !== 'string' || q.expectedTarget.trim() === '') {
      throw invalid('expectedTarget must be a non-empty string');
    }
    if (typeof q.minAmountMotes !== 'string' || !MOTES_RE.test(q.minAmountMotes)) {
      throw invalid('minAmountMotes must be a motes decimal string');
    }
    if (typeof q.expectedTransferId !== 'string' || !MOTES_RE.test(q.expectedTransferId)) {
      throw invalid('expectedTransferId must be a u64 decimal string');
    }
    if (typeof q.maxAgeMs !== 'number' || !Number.isFinite(q.maxAgeMs) || q.maxAgeMs < 0) {
      throw invalid('maxAgeMs must be a non-negative number');
    }

    const transfer = await this.request<DevnetTransfer>(
      'GET',
      `/chain/transfers/${encodeURIComponent(q.deployHash)}`,
      undefined,
      true,
    );
    if (transfer === null) return { ok: false, reason: 'not_found' };
    if (transfer.to.toLowerCase() !== q.expectedTarget.toLowerCase()) {
      return { ok: false, reason: 'wrong_target' };
    }
    if (BigInt(transfer.amountMotes) < BigInt(q.minAmountMotes)) {
      return { ok: false, reason: 'amount_too_low' };
    }
    if (BigInt(transfer.transferId) !== BigInt(q.expectedTransferId)) {
      return { ok: false, reason: 'wrong_transfer_id' };
    }
    if (Date.now() - transfer.timestamp > q.maxAgeMs) {
      return { ok: false, reason: 'expired' };
    }
    return {
      ok: true,
      amountMotes: transfer.amountMotes,
      from: transfer.from,
      timestamp: transfer.timestamp,
    };
  }

  // ---- writes ---------------------------------------------------------------

  async registerService(
    input: RegisterServiceInput,
    signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    return await this.post<{ serviceId: number; txHash: string }>('/chain/register-service', {
      ...input,
      ownerPublicKey: mockSigner.publicKey,
    });
  }

  async recordAttestation(
    input: { serviceId: number; paymentDeployHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    return await this.post<{ txHash: string }>('/chain/attestations', {
      serviceId: input.serviceId,
      paymentDeployHash: input.paymentDeployHash,
      success: input.success,
      byPublicKey: mockSigner.publicKey,
    });
  }

  async setActive(
    serviceId: number,
    active: boolean,
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(serviceId);
    return await this.post<{ txHash: string }>(`/chain/services/${serviceId}/active`, {
      active,
      byPublicKey: mockSigner.publicKey,
    });
  }

  async transfer(
    input: { to: string; amountMotes: Motes; transferId: string },
    signer: AnySigner,
  ): Promise<{ deployHash: string }> {
    const mockSigner = requireMockSigner(signer);
    if (typeof input.to !== 'string' || input.to.trim() === '') {
      throw invalid('"to" must be a non-empty account string');
    }
    if (typeof input.amountMotes !== 'string' || !MOTES_RE.test(input.amountMotes)) {
      throw invalid('amountMotes must be a motes decimal string');
    }
    if (
      typeof input.transferId !== 'string' ||
      !MOTES_RE.test(input.transferId) ||
      BigInt(input.transferId) > U64_MAX
    ) {
      throw invalid('transferId must be a u64 decimal string');
    }
    const result = await this.post<{ deployHash: string; timestamp: number }>('/chain/transfers', {
      fromPublicKey: mockSigner.publicKey,
      to: input.to,
      amountMotes: input.amountMotes,
      transferId: input.transferId,
    });
    return { deployHash: result.deployHash };
  }
}
