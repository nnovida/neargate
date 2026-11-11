import { AgentGateError, stripTrailingSlashes } from '@agentgate/shared';
import type {
  ActivityEvent,
  AnySigner,
  AttestationRecord,
  ChainClient,
  MockSigner,
  PaymentRecord,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
  VerifyPaymentQuery,
  VerifyResult,
  Yocto,
} from '@agentgate/shared';

const YOCTO_RE = /^(0|[1-9]\d*)$/;
/** Same nonce rule as the registry contract. */
const NONCE_RE = /^[0-9]{1,20}$/;

/** Shape of the devnet's GET /chain/transfers/:txHash response. */
interface DevnetTransfer {
  txHash: string;
  from: string;
  to: string;
  amountYocto: Yocto;
  transferId: string;
  timestamp: number;
}

/** Devnet is local/in-process, but never let a hung socket block a request forever. */
const DEVNET_REQUEST_TIMEOUT_MS = 30_000;

function invalid(message: string): AgentGateError {
  return new AgentGateError('invalid_query', message, 400);
}

function requireMockSigner(signer: AnySigner): MockSigner {
  if (signer.kind !== 'mock') {
    throw new AgentGateError(
      'invalid_signer',
      `MockChainHttpClient requires a mock signer, got "${signer.kind}"`,
      400,
    );
  }
  if (signer.accountId.trim() === '') {
    throw new AgentGateError('invalid_signer', 'mock signer accountId must not be empty', 400);
  }
  return signer;
}

function notYet(method: string): AgentGateError {
  return new AgentGateError('not_implemented', `MockChainHttpClient.${method} lands in Task 3`, 501);
}

function assertServiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalid(`serviceId must be a positive integer, got ${String(id)}`);
  }
}

/**
 * ChainClient backed by the local devnet's REST API.
 * Maps every read/write 1:1 onto the devnet routes.
 * TODO(Task 3): mirror the NEAR registry routes (`/registry/*`), `network = 'near-mock'`.
 */
export class MockChainHttpClient implements ChainClient {
  readonly network = 'mock';
  readonly registryId = 'registry.mock';
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
    this.baseUrl = stripTrailingSlashes(devnetUrl);
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

  /** Readiness probe: a bounded GET to the devnet health endpoint. */
  async ping(): Promise<void> {
    await this.get('/healthz');
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

  async getBalance(accountId: string): Promise<Yocto> {
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      throw invalid('accountId must be a non-empty string');
    }
    const result = await this.get<{ account: string; balanceYocto: Yocto }>(
      `/chain/balance/${encodeURIComponent(accountId)}`,
    );
    return result.balanceYocto;
  }

  /** TODO(Task 3): GET the registry payment record by nonce. */
  async getPayment(_nonce: string): Promise<PaymentRecord | null> {
    throw notYet('getPayment');
  }

  /** TODO(Task 3): devnet accounts get deterministic full-access keys. */
  async isFullAccessKey(_accountId: string, _publicKey: string): Promise<boolean> {
    throw notYet('isFullAccessKey');
  }

  /**
   * Looks up the transfer by txHash, then checks nonce → service target →
   * amount → age. `pending` never occurs in mock mode because devnet transfers
   * settle synchronously.
   * TODO(Task 3): verify against the registry payment record (by nonce), with
   * `already_attested` and `selfPaid` from the contract rules.
   */
  async verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    if (typeof q.nonce !== 'string' || !NONCE_RE.test(q.nonce)) {
      throw invalid('nonce must be 1–20 decimal digits');
    }
    assertServiceId(q.serviceId);
    if (typeof q.minAmountYocto !== 'string' || !YOCTO_RE.test(q.minAmountYocto)) {
      throw invalid('minAmountYocto must be a yocto decimal string');
    }
    if (typeof q.maxAgeMs !== 'number' || !Number.isFinite(q.maxAgeMs) || q.maxAgeMs < 0) {
      throw invalid('maxAgeMs must be a non-negative number');
    }
    if (q.txHash === undefined || q.txHash.trim() === '') return { ok: false, reason: 'not_found' };

    const transfer = await this.request<DevnetTransfer>(
      'GET',
      `/chain/transfers/${encodeURIComponent(q.txHash)}`,
      undefined,
      true,
    );
    if (transfer === null) return { ok: false, reason: 'not_found' };
    if (transfer.transferId !== q.nonce) return { ok: false, reason: 'tx_mismatch' };
    const service = await this.getService(q.serviceId);
    if (service === null || transfer.to !== service.paymentTarget) {
      return { ok: false, reason: 'wrong_service' };
    }
    if (BigInt(transfer.amountYocto) < BigInt(q.minAmountYocto)) {
      return { ok: false, reason: 'amount_too_low' };
    }
    if (Date.now() - transfer.timestamp > q.maxAgeMs) {
      return { ok: false, reason: 'expired' };
    }
    return {
      ok: true,
      amountYocto: transfer.amountYocto,
      payer: transfer.from,
      timestamp: transfer.timestamp,
      selfPaid: transfer.from === service.owner || transfer.from === service.paymentTarget,
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
      ownerAccountId: mockSigner.accountId,
    });
  }

  async recordAttestation(
    input: { serviceId: number; nonce: string; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    return await this.post<{ txHash: string }>('/chain/attestations', {
      serviceId: input.serviceId,
      nonce: input.nonce,
      paymentTxHash: input.paymentTxHash,
      success: input.success,
      byAccountId: mockSigner.accountId,
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
      byAccountId: mockSigner.accountId,
    });
  }

  /**
   * Pays a service: moves `depositYocto` to the service's payment target,
   * tagged with the invoice nonce.
   * TODO(Task 3): call the devnet registry `pay` (price forwarded, storage fee kept, excess refunded).
   */
  async pay(
    input: { serviceId: number; nonce: string; depositYocto: Yocto },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    if (typeof input.nonce !== 'string' || !NONCE_RE.test(input.nonce)) {
      throw invalid('nonce must be 1–20 decimal digits');
    }
    if (typeof input.depositYocto !== 'string' || !YOCTO_RE.test(input.depositYocto)) {
      throw invalid('depositYocto must be a yocto decimal string');
    }
    const service = await this.getService(input.serviceId);
    if (service === null) {
      throw new AgentGateError('service_not_found', `no service with id ${input.serviceId}`, 404);
    }
    const result = await this.post<{ txHash: string; timestamp: number }>('/chain/transfers', {
      fromAccountId: mockSigner.accountId,
      to: service.paymentTarget,
      amountYocto: input.depositYocto,
      transferId: input.nonce,
    });
    return { txHash: result.txHash };
  }
}
