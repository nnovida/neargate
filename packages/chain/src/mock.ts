import {
  AgentGateError,
  MOCK_NETWORK,
  MOCK_REGISTRY_ID,
  REGISTRATION_DEPOSIT_YOCTO,
  stripTrailingSlashes,
} from '@agentgate/shared';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import type {
  AccessKeyInfo,
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
  ViewFinality,
  Yocto,
} from '@agentgate/shared';
import { YOCTO_RE, assertNonEmpty, assertServiceId, assertYocto, checkVerifyQuery, judgePaymentRecord } from './checks';
import { deriveDevnetKey, devnetRelayTxHash } from './devnet-key';
import { PAY_DELEGATE_METHOD, PAY_DELEGATE_TTL_BLOCKS, buildEscrowPayDelegate, relayablePayDelegate } from './near-delegate';
import { TxTimeoutError } from './near-errors';

/** Devnet is local/in-process, but never let a hung socket block a request forever. */
const DEVNET_REQUEST_TIMEOUT_MS = 30_000;

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
    const result = await this.get<{ fullAccess?: unknown } | undefined>(
      `/accounts/${encodeURIComponent(accountId)}/keys/${encodeURIComponent(publicKey)}`,
    );
    // The answer gates owner authority: anything but a boolean is a broken devnet, never a "yes".
    if (typeof result?.fullAccess !== 'boolean') {
      throw new AgentGateError('devnet_bad_response', 'devnet key check did not answer { fullAccess: boolean }', 502);
    }
    return result.fullAccess;
  }

  /** The devnet knows an account once it holds a balance record (faucet-funded or paid to). */
  async accountExists(accountId: string): Promise<boolean> {
    assertNonEmpty(accountId, 'accountId');
    const result = await this.get<{ exists?: unknown } | undefined>(`/accounts/${encodeURIComponent(accountId)}`);
    // `wrap` registers a payment target on this answer: anything but a boolean is a broken devnet.
    if (typeof result?.exists !== 'boolean') {
      throw new AgentGateError('devnet_bad_response', 'devnet account check did not answer { exists: boolean }', 502);
    }
    return result.exists;
  }

  /** The devnet's height: every successful write (and every faucet credit) takes one block. */
  async blockHeight(): Promise<number> {
    const result = await this.get<{ height?: unknown } | undefined>('/block');
    const height = result?.height;
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
      throw new AgentGateError('devnet_bad_response', 'devnet block lookup did not answer { height: integer }', 502);
    }
    return height;
  }

  /**
   * The devnet's one key of an account (its derived devnet key, full access): its nonce, which a
   * relayed delegate moves, or null for any other key or an account the devnet does not know. The
   * devnet settles each call at once, so every finality reads the same.
   */
  async accessKey(accountId: string, publicKey: string, _finality?: ViewFinality): Promise<AccessKeyInfo | null> {
    assertNonEmpty(accountId, 'accountId');
    assertNonEmpty(publicKey, 'publicKey');
    const result = await this.request<{ nonce?: unknown; permission?: unknown }>(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/access-key/${encodeURIComponent(publicKey)}`,
      undefined,
      true,
    );
    if (result === null) return null;
    // The answer gates a relay: anything but a u64 nonce on a full-access key is a broken devnet.
    if (typeof result.nonce !== 'string' || !YOCTO_RE.test(result.nonce) || result.permission !== 'FullAccess') {
      throw new AgentGateError(
        'devnet_bad_response',
        "devnet access key lookup did not answer { nonce: decimal string, permission: 'FullAccess' }",
        502,
      );
    }
    return { nonce: BigInt(result.nonce), permission: 'FullAccess' };
  }

  /**
   * Signs (sends nothing) the gasless rail's NEP-366 delegate with the signer's devnet key, as the
   * live client does with a real key: one zero-deposit `pay_from_escrow(service_id, nonce)` to the
   * registry, the key's nonce + 1, valid 100 blocks past the devnet height. A devnet key is public
   * by construction (`deriveDevnetKey`): it protects nothing outside mock mode.
   */
  async signPayDelegate(input: { serviceId: number; nonce: string }, signer: AnySigner): Promise<string> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    const devnetKey = deriveDevnetKey(mockSigner.accountId);
    const key = await this.accessKey(mockSigner.accountId, devnetKey.publicKey);
    if (key === null) {
      throw new AgentGateError(
        'SIGNER_KEY_NOT_FOUND',
        `${devnetKey.publicKey} is not an access key of ${mockSigner.accountId} on ${this.network} (fund the account first)`,
        400,
      );
    }
    const height = await this.blockHeight();
    return buildEscrowPayDelegate(new KeyPairSigner(KeyPair.fromString(devnetKey.secretKey as `ed25519:${string}`)), {
      registryId: this.registryId,
      senderId: mockSigner.accountId,
      serviceId: input.serviceId,
      nonce: input.nonce, // the registry checks the shape (ERR_INVALID_NONCE)
      delegateNonce: key.nonce + 1n,
      maxBlockHeight: BigInt(height + PAY_DELEGATE_TTL_BLOCKS),
    });
  }

  /**
   * Relays a signed delegate as `relayer` through the devnet's NEP-366 route: the devnet checks it
   * the way NEAR does (signature, key, nonce, expiry), then runs `pay_from_escrow` as the
   * delegate's sender; the relayer attaches nothing. Only a zero-deposit `pay_from_escrow` to the
   * registry is relayed (invalid_query before the devnet sees anything else). NEAR refusing the
   * delegate is DELEGATE_REJECTED naming the DelegateAction error; the inner call failing keeps its
   * ERR_* code. An answer that timed out leaves the outcome unknown (the devnet may have run the
   * relay): TX_TIMEOUT naming the tx the devnet gives that relay (`devnetRelayTxHash`), as a live
   * relay's would.
   */
  async relayPay(signedDelegate: string, relayer: AnySigner): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(relayer);
    relayablePayDelegate(signedDelegate, this.registryId);
    try {
      return await this.post<{ txHash: string }>('/registry/relay', {
        relayer: mockSigner.accountId,
        signedDelegate,
      });
    } catch (err) {
      if (err instanceof AgentGateError && err.code === 'devnet_timeout') {
        throw new TxTimeoutError(
          `the devnet did not answer the ${PAY_DELEGATE_METHOD} relay within ${DEVNET_REQUEST_TIMEOUT_MS / 1000} s`,
          devnetRelayTxHash(signedDelegate),
          undefined,
        );
      }
      throw err;
    }
  }

  /** The account's escrow in yocto; `"0"` for an account that never deposited. */
  async escrowOf(accountId: string): Promise<Yocto> {
    assertNonEmpty(accountId, 'accountId');
    const result = await this.get<{ escrowYocto?: unknown } | undefined>(
      `/registry/escrow/${encodeURIComponent(accountId)}`,
    );
    // The answer gates a payment's pre-check: anything but a yocto string is a broken devnet.
    const escrow = result?.escrowYocto;
    if (typeof escrow !== 'string' || !YOCTO_RE.test(escrow)) {
      throw new AgentGateError('devnet_bad_response', 'devnet escrow check did not answer { escrowYocto: yocto string }', 502);
    }
    return escrow;
  }

  /**
   * Checks the registry's payment record for the nonce: not_found, wrong_service,
   * amount_too_low, expired, already_attested, then ok. `pending` never occurs in mock mode
   * because devnet payments settle synchronously, and `txHash`/`payer` are ignored: matching
   * the transaction to the nonce (`tx_mismatch`) is a live-only check.
   */
  async verifyPayment(q: VerifyPaymentQuery): Promise<VerifyResult> {
    checkVerifyQuery(q);
    const payment = await this.getPayment(q.nonce);
    return judgePaymentRecord(payment, q, Date.now());
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
    assertYocto(input.depositYocto, 'depositYocto');
    return await this.post<{ txHash: string }>('/registry/pay', {
      signer: mockSigner.accountId,
      serviceId: input.serviceId,
      nonce: input.nonce, // the registry checks the shape (ERR_INVALID_NONCE)
      depositYocto: input.depositYocto,
    });
  }

  /**
   * `deposit_escrow` with `amountYocto` attached. The first deposit of an account must be more
   * than the 0.002 NEAR storage fee, which the registry keeps; later ones are credited in full.
   */
  async depositEscrow(amountYocto: Yocto, signer: AnySigner): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertYocto(amountYocto, 'amountYocto');
    return await this.post<{ txHash: string }>('/registry/deposit-escrow', {
      signer: mockSigner.accountId,
      depositYocto: amountYocto,
    });
  }

  /** `withdraw_escrow(amount)` with exactly 1 yocto attached, as on NEAR (a full-access key only). */
  async withdrawEscrow(amountYocto: Yocto, signer: AnySigner): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertYocto(amountYocto, 'amountYocto');
    return await this.post<{ txHash: string }>('/registry/withdraw-escrow', {
      signer: mockSigner.accountId,
      amountYocto,
      depositYocto: '1',
    });
  }

  /** `pay_from_escrow(service_id, nonce)`: attaches nothing, the price + fee come out of the escrow. */
  async payFromEscrow(
    input: { serviceId: number; nonce: string },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    return await this.post<{ txHash: string }>('/registry/pay-from-escrow', {
      signer: mockSigner.accountId,
      serviceId: input.serviceId,
      nonce: input.nonce, // the registry checks the shape (ERR_INVALID_NONCE)
      depositYocto: '0',
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
