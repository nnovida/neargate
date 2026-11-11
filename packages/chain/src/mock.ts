import {
  AgentGateError,
  MOCK_NETWORK,
  MOCK_REGISTRY_ID,
  REGISTRATION_DEPOSIT_YOCTO,
  isValidNonce,
  stripTrailingSlashes,
} from '@agentgate/shared';
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

function assertNonEmpty(value: string, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`${what} must be a non-empty string`);
  }
}

function assertServiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalid(`serviceId must be a positive integer, got ${String(id)}`);
  }
}

/**
 * ChainClient backed by the local devnet's REST API (`/registry/*` and `/accounts/*`).
 *
 * Contract rejections come back as AgentGateError whose `code` is the contract's `ERR_*` code
 * and whose message starts with it ("ERR_NONCE_USED: nonce already paid"), the same shape a
 * contract panic has, so mock and live callers handle one error format.
 */
export class MockChainHttpClient implements ChainClient {
  readonly network = MOCK_NETWORK;
  readonly registryId = MOCK_REGISTRY_ID;
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
      const code = typeof errBody.error === 'string' ? errBody.error : 'devnet_error';
      const detail =
        typeof errBody.message === 'string'
          ? errBody.message
          : `devnet responded ${res.status} on ${method} ${path}`;
      // A contract panic message starts with its ERR_* code; the devnet sends the text alone.
      const message = code.startsWith('ERR_') && !detail.startsWith(code) ? `${code}: ${detail}` : detail;
      throw new AgentGateError(code, message, res.status);
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
    return await this.request<ServiceRecord>('GET', `/registry/services/${id}`, undefined, true);
  }

  async listServices(): Promise<ServiceRecord[]> {
    return await this.get<ServiceRecord[]>('/registry/services');
  }

  async getScore(id: number): Promise<ServiceScore> {
    assertServiceId(id);
    return await this.get<ServiceScore>(`/registry/services/${id}/score`);
  }

  async listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]> {
    assertServiceId(serviceId);
    const qs = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.get<AttestationRecord[]>(`/registry/services/${serviceId}/attestations${qs}`);
  }

  async listRecentActivity(limit?: number): Promise<ActivityEvent[]> {
    const qs = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.get<ActivityEvent[]>(`/registry/activity${qs}`);
  }

  async getBalance(accountId: string): Promise<Yocto> {
    assertNonEmpty(accountId, 'accountId');
    const result = await this.get<{ accountId: string; balanceYocto: Yocto }>(
      `/accounts/${encodeURIComponent(accountId)}/balance`,
    );
    return result.balanceYocto;
  }

  async getPayment(nonce: string): Promise<PaymentRecord | null> {
    assertNonEmpty(nonce, 'nonce');
    return await this.request<PaymentRecord>(
      'GET',
      `/registry/payments/${encodeURIComponent(nonce)}`,
      undefined,
      true,
    );
  }

  /** Devnet accounts own exactly one full-access key, derived from the account id. */
  async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    assertNonEmpty(accountId, 'accountId');
    assertNonEmpty(publicKey, 'publicKey');
    const result = await this.get<{ fullAccess: boolean }>(
      `/accounts/${encodeURIComponent(accountId)}/keys/${encodeURIComponent(publicKey)}`,
    );
    return result.fullAccess;
  }

  /**
   * Checks the registry's payment record for the nonce: not_found, wrong_service,
   * amount_too_low, expired, already_attested, then ok. `pending` never occurs in mock mode
   * because devnet payments settle synchronously, and `txHash`/`payer` are ignored: matching
   * the transaction to the nonce (`tx_mismatch`) is a live-only check.
   */
  async verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    if (typeof q.nonce !== 'string' || !isValidNonce(q.nonce)) {
      throw invalid('nonce must be 1–20 decimal digits');
    }
    assertServiceId(q.serviceId);
    if (typeof q.minAmountYocto !== 'string' || !YOCTO_RE.test(q.minAmountYocto)) {
      throw invalid('minAmountYocto must be a yocto decimal string');
    }
    if (typeof q.maxAgeMs !== 'number' || !Number.isFinite(q.maxAgeMs) || q.maxAgeMs < 0) {
      throw invalid('maxAgeMs must be a non-negative number');
    }

    const payment = await this.getPayment(q.nonce);
    if (payment === null) return { ok: false, reason: 'not_found' };
    if (payment.serviceId !== q.serviceId) return { ok: false, reason: 'wrong_service' };
    if (BigInt(payment.amountYocto) < BigInt(q.minAmountYocto)) {
      return { ok: false, reason: 'amount_too_low' };
    }
    if (Date.now() - payment.timestamp > q.maxAgeMs) return { ok: false, reason: 'expired' };
    if (payment.attested) return { ok: false, reason: 'already_attested' };
    return {
      ok: true,
      amountYocto: payment.amountYocto,
      payer: payment.payer,
      timestamp: payment.timestamp,
      selfPaid: payment.selfPaid,
    };
  }

  // ---- writes ---------------------------------------------------------------

  /** Registers a service, attaching exactly the registration deposit. */
  async registerService(
    input: RegisterServiceInput,
    signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    return await this.post<{ serviceId: number; txHash: string }>('/registry/register', {
      signer: mockSigner.accountId,
      input,
      depositYocto: REGISTRATION_DEPOSIT_YOCTO,
    });
  }

  /**
   * Calls the registry's `pay` with `depositYocto` attached: the price goes to the service's
   * payment target, the storage fee stays in the registry, the rest is refunded.
   */
  async pay(
    input: { serviceId: number; nonce: string; depositYocto: Yocto },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    if (typeof input.depositYocto !== 'string' || !YOCTO_RE.test(input.depositYocto)) {
      throw invalid('depositYocto must be a yocto decimal string');
    }
    return await this.post<{ txHash: string }>('/registry/pay', {
      signer: mockSigner.accountId,
      serviceId: input.serviceId,
      nonce: input.nonce, // the registry checks the shape (ERR_INVALID_NONCE)
      depositYocto: input.depositYocto,
    });
  }

  async recordAttestation(
    input: { serviceId: number; nonce: string; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    return await this.post<{ txHash: string }>('/registry/attest', {
      signer: mockSigner.accountId,
      serviceId: input.serviceId,
      nonce: input.nonce,
      paymentTxHash: input.paymentTxHash,
      success: input.success,
    });
  }

  async setActive(
    serviceId: number,
    active: boolean,
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(serviceId);
    return await this.post<{ txHash: string }>('/registry/active', {
      signer: mockSigner.accountId,
      serviceId,
      active,
    });
  }
}
