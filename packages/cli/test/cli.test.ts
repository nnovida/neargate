import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';
import {
  createDemoAccounts,
  listServices,
  serviceStatus,
  setServiceActive,
  wrapService,
} from '../src/index';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const HEX64 = (c: string): string => c.repeat(64);
const SIGNER: AnySigner = { kind: 'mock', publicKey: `01${HEX64('a')}` };
const PAYMENT_TARGET = `account-hash-${HEX64('1')}`;
const REGISTER_TX = HEX64('f');

interface FakeChain extends ChainClient {
  registered: Array<{ input: RegisterServiceInput; signer: AnySigner }>;
}

function makeService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id,
    name: `svc-${id}`,
    description: 'a service',
    endpointUrl: `http://gw.example:4021/svc/${id}`,
    priceMotes: '500000000',
    paymentTarget: PAYMENT_TARGET,
    owner: SIGNER.kind === 'mock' ? SIGNER.publicKey : '',
    attestor: `01${HEX64('a')}`,
    active: true,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function makeFakeChain(hooks: { onRegister?: () => void } = {}): FakeChain {
  const registered: FakeChain['registered'] = [];
  const chain: FakeChain = {
    network: 'mock',
    registered,
    async getService() {
      return null;
    },
    async listServices() {
      return [];
    },
    async getScore(): Promise<ServiceScore> {
      return { totalCalls: 0, successCalls: 0 };
    },
    async listAttestations(): Promise<AttestationRecord[]> {
      return [];
    },
    async listRecentActivity() {
      return [];
    },
    async getBalance() {
      return '0';
    },
    async verifyTransfer() {
      return { ok: false, reason: 'not_found' } as const;
    },
    async registerService(input, signer) {
      hooks.onRegister?.();
      registered.push({ input, signer });
      return { serviceId: 7, txHash: REGISTER_TX };
    },
    async recordAttestation() {
      return { txHash: HEX64('b') };
    },
    async setActive() {
      return { txHash: HEX64('c') };
    },
    async transfer() {
      return { deployHash: HEX64('d') };
    },
  };
  return chain;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeFakeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { impl: (url: string, init?: RequestInit) => Promise<Response>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    impl: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  };
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

// silence the warning print on the admin-failure path, keep assertions possible
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

function baseWrapOpts(chain: FakeChain, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return {
    upstreamUrl: 'http://localhost:4010/feed',
    priceCspr: '0.5',
    name: 'FX Oracle',
    description: 'USD/IDR + gold spot',
    gateway: 'http://gw.example:4021/', // trailing slash on purpose
    paymentTarget: PAYMENT_TARGET,
    chain,
    signer: SIGNER,
    adminToken: 'tok-123',
    fetchImpl,
  };
}

// ---------------------------------------------------------------------------
// wrapService — happy path
// ---------------------------------------------------------------------------

describe('wrapService', () => {
  it('registers on-chain first, then maps the upstream via the admin API', async () => {
    const order: string[] = [];
    const chain = makeFakeChain({ onRegister: () => order.push('register') });
    const { impl, calls } = makeFakeFetch(() => {
      order.push('admin');
      return new Response(null, { status: 204 });
    });

    const result = await wrapService(baseWrapOpts(chain, impl));

    // result shape + computed URLs
    expect(result.serviceId).toBe(7);
    expect(result.txHash).toBe(REGISTER_TX);
    expect(result.publicUrl).toBe('http://gw.example:4021/svc/7');
    expect(result.dashboardUrl).toBe('http://localhost:3000/services/7');
    expect(result.adminOk).toBe(true);
    expect(result.adminWarning).toBeUndefined();

    // ordering: on-chain registration happens before the admin POST
    expect(order).toEqual(['register', 'admin']);

    // on-chain input: endpointUrl is the gateway BASE (SPEC §9 final decision)
    expect(chain.registered).toHaveLength(1);
    const reg = chain.registered[0]!;
    expect(reg.input.endpointUrl).toBe('http://gw.example:4021');
    expect(reg.input.name).toBe('FX Oracle');
    expect(reg.input.description).toBe('USD/IDR + gold spot');
    expect(reg.input.priceMotes).toBe('500000000'); // 0.5 CSPR, bigint-derived
    expect(reg.input.paymentTarget).toBe(PAYMENT_TARGET);
    expect(reg.input.attestor).toBe(SIGNER.kind === 'mock' ? SIGNER.publicKey : '');
    expect(reg.signer).toEqual(SIGNER);

    // admin POST: URL, auth header, JSON body
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://gw.example:4021/admin/services');
    expect(call.init?.method).toBe('POST');
    expect(headersOf(call)['authorization']).toBe('Bearer tok-123');
    expect(headersOf(call)['content-type']).toBe('application/json');
    expect(bodyOf(call)).toEqual({ serviceId: 7, upstreamUrl: 'http://localhost:4010/feed' });
  });

  it('uses an explicit attestor when provided', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const attestor = `01${HEX64('9')}`;
    await wrapService({ ...baseWrapOpts(chain, impl), attestor });
    expect(chain.registered[0]!.input.attestor).toBe(attestor);
  });

  // -------------------------------------------------------------------------
  // admin failure path
  // -------------------------------------------------------------------------

  it('keeps the registration and returns a retry-curl warning when the admin POST fails (HTTP error)', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response('unauthorized', { status: 401 }));

    const result = await wrapService(baseWrapOpts(chain, impl));

    expect(result.serviceId).toBe(7);
    expect(result.txHash).toBe(REGISTER_TX);
    expect(result.publicUrl).toBe('http://gw.example:4021/svc/7');
    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toBeDefined();
    const warning = result.adminWarning!;
    expect(warning).toContain('HTTP 401');
    expect(warning).toContain('NOT rolled back');
    expect(warning).toContain(`tx ${REGISTER_TX}`);
    // exact retry curl
    expect(warning).toContain("curl -X POST 'http://gw.example:4021/admin/services'");
    expect(warning).toContain('-H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN"');
    expect(warning).toContain(
      `-d '{"serviceId":7,"upstreamUrl":"http://localhost:4010/feed"}'`,
    );
    // never leak the actual admin token into the warning
    expect(warning).not.toContain('tok-123');
    // warning also printed to stderr
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a network error on the admin POST the same way', async () => {
    const chain = makeFakeChain();
    const impl = async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4021');
    };

    const result = await wrapService(baseWrapOpts(chain, impl));

    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('ECONNREFUSED');
    expect(result.adminWarning).toContain('curl -X POST');
    expect(chain.registered).toHaveLength(1); // registration untouched
  });

  // -------------------------------------------------------------------------
  // validation rejections (no side effects at all)
  // -------------------------------------------------------------------------

  const rejectionCases: Array<{ title: string; patch: Record<string, string>; code: string }> = [
    { title: 'price of 0', patch: { priceCspr: '0' }, code: 'INVALID_PRICE' },
    { title: 'non-numeric price', patch: { priceCspr: 'abc' }, code: 'INVALID_AMOUNT' },
    { title: 'negative price', patch: { priceCspr: '-1' }, code: 'INVALID_AMOUNT' },
    { title: 'price with 10 decimals', patch: { priceCspr: '0.1234567891' }, code: 'INVALID_AMOUNT' },
    { title: 'blank name', patch: { name: '   ' }, code: 'INVALID_INPUT' },
    { title: 'non-http upstream', patch: { upstreamUrl: 'ftp://x.test/a' }, code: 'INVALID_URL' },
    { title: 'garbage upstream', patch: { upstreamUrl: 'not a url' }, code: 'INVALID_URL' },
    { title: 'ws gateway', patch: { gateway: 'ws://gw.example' }, code: 'INVALID_URL' },
    {
      title: 'gateway with query string',
      patch: { gateway: 'http://gw.example:4021/?x=1' },
      code: 'INVALID_URL',
    },
    {
      title: 'malformed payment target',
      patch: { paymentTarget: 'deadbeef' },
      code: 'INVALID_ACCOUNT_HASH',
    },
    { title: 'malformed attestor', patch: { attestor: 'zz' }, code: 'INVALID_PUBLIC_KEY' },
    { title: 'empty admin token', patch: { adminToken: ' ' }, code: 'INVALID_INPUT' },
    // name/description sanitization (these go on-chain unmodified)
    { title: 'name with a control char', patch: { name: 'bad\x01name' }, code: 'INVALID_INPUT' },
    { title: 'name with a NUL byte', patch: { name: 'a\x00b' }, code: 'INVALID_INPUT' },
    { title: 'name with a DEL byte', patch: { name: 'a\x7fb' }, code: 'INVALID_INPUT' },
    { title: 'overlong name', patch: { name: 'n'.repeat(129) }, code: 'INVALID_INPUT' },
    {
      title: 'description with a control char',
      patch: { description: 'line1\nline2' },
      code: 'INVALID_INPUT',
    },
    { title: 'overlong description', patch: { description: 'd'.repeat(513) }, code: 'INVALID_INPUT' },
  ];

  for (const { title, patch, code } of rejectionCases) {
    it(`rejects ${title} without touching the chain or the gateway`, async () => {
      const chain = makeFakeChain();
      const { impl, calls } = makeFakeFetch(() => new Response(null, { status: 204 }));
      await expect(
        wrapService({ ...baseWrapOpts(chain, impl), ...patch }),
      ).rejects.toMatchObject({ name: 'AgentGateError', code });
      expect(chain.registered).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });
  }

  // -------------------------------------------------------------------------
  // cleartext-token-over-http guard (live mode)
  // -------------------------------------------------------------------------

  it('rejects a cleartext-http non-localhost gateway in live mode (the admin token would leak)', async () => {
    const chain = makeFakeChain();
    const { impl, calls } = makeFakeFetch(() => new Response(null, { status: 204 }));
    await expect(
      wrapService({
        ...baseWrapOpts(chain, impl),
        gateway: 'http://gw.example:4021/',
        mode: 'live',
      }),
    ).rejects.toMatchObject({ name: 'AgentGateError', code: 'INSECURE_URL' });
    expect(chain.registered).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('allows a cleartext-http localhost gateway in live mode (token never leaves the box)', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const result = await wrapService({
      ...baseWrapOpts(chain, impl),
      gateway: 'http://localhost:4021/',
      mode: 'live',
    });
    expect(result.adminOk).toBe(true);
  });

  it('allows an https non-localhost gateway in live mode', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const result = await wrapService({
      ...baseWrapOpts(chain, impl),
      gateway: 'https://gw.example/',
      mode: 'live',
    });
    expect(result.adminOk).toBe(true);
  });

  // -------------------------------------------------------------------------
  // admin POST timeout (keeps the registration + prints the retry curl)
  // -------------------------------------------------------------------------

  it('treats an admin POST timeout as a failure: keeps the registration + retry curl', async () => {
    const chain = makeFakeChain();
    const impl = async (): Promise<Response> => {
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      throw err;
    };

    const result = await wrapService({ ...baseWrapOpts(chain, impl), timeoutMs: 1 });

    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('timed out');
    expect(result.adminWarning).toContain('curl -X POST');
    expect(chain.registered).toHaveLength(1); // registration untouched
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createDemoAccounts
// ---------------------------------------------------------------------------

describe('createDemoAccounts', () => {
  it('faucets 1000 CSPR to two fresh mock public keys and returns export lines', async () => {
    const { impl, calls } = makeFakeFetch(() =>
      Response.json({ balanceMotes: '1000000000000' }),
    );

    const result = await createDemoAccounts({
      devnetUrl: 'http://localhost:4030/',
      fetchImpl: impl,
    });

    // two POST /faucet calls (buyer first, then seller)
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('http://localhost:4030/faucet');
      expect(call.init?.method).toBe('POST');
      expect(bodyOf(call)['amountMotes']).toBe('1000000000000'); // 1000 CSPR in motes
    }
    expect(bodyOf(calls[0]!)['account']).toBe(result.buyer.publicKey);
    expect(bodyOf(calls[1]!)['account']).toBe(result.seller.publicKey);

    // key shape: "01" + 64 random hex chars, distinct per account
    expect(result.buyer.publicKey).toMatch(/^01[0-9a-f]{64}$/);
    expect(result.seller.publicKey).toMatch(/^01[0-9a-f]{64}$/);
    expect(result.seller.publicKey).not.toBe(result.buyer.publicKey);

    // balances + roles surfaced
    expect(result.buyer).toMatchObject({ role: 'buyer', balanceMotes: '1000000000000' });
    expect(result.seller).toMatchObject({ role: 'seller', balanceMotes: '1000000000000' });

    // export lines, exact shape
    expect(result.exportLines).toEqual([
      `export MOCK_BUYER_ACCOUNT=${result.buyer.publicKey}`,
      `export MOCK_SELLER_ACCOUNT=${result.seller.publicKey}`,
    ]);
  });

  it('rejects when the faucet answers with an error status', async () => {
    const { impl } = makeFakeFetch(() => new Response('nope', { status: 500 }));
    await expect(
      createDemoAccounts({ devnetUrl: 'http://localhost:4030', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'FAUCET_FAILED' });
  });

  it('rejects when the faucet returns a malformed body', async () => {
    const { impl } = makeFakeFetch(() => Response.json({ balanceMotes: 12345 }));
    await expect(
      createDemoAccounts({ devnetUrl: 'http://localhost:4030', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'FAUCET_FAILED' });
  });

  it('rejects when the devnet is unreachable', async () => {
    const impl = async (): Promise<Response> => {
      throw new Error('fetch failed');
    };
    await expect(
      createDemoAccounts({ devnetUrl: 'http://localhost:4030', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'FAUCET_UNREACHABLE' });
  });
});

// ---------------------------------------------------------------------------
// listServices / serviceStatus
// ---------------------------------------------------------------------------

describe('listServices', () => {
  it('joins services with scores and trust tiers', async () => {
    const chain = makeFakeChain();
    const scores = new Map<number, ServiceScore>([
      [1, { totalCalls: 30, successCalls: 30 }],
      [2, { totalCalls: 2, successCalls: 1 }],
    ]);
    chain.listServices = async () => [makeService(1), makeService(2)];
    chain.getScore = async (id) => scores.get(id) ?? { totalCalls: 0, successCalls: 0 };

    const listings = await listServices({ chain });
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ tier: 'trusted', score: { totalCalls: 30 } });
    expect(listings[1]).toMatchObject({ tier: 'new', score: { totalCalls: 2 } });
    expect(listings[0]!.service.id).toBe(1);
  });
});

describe('serviceStatus', () => {
  it('returns service + score + tier + recent attestations', async () => {
    const chain = makeFakeChain();
    const attestation: AttestationRecord = {
      serviceId: 1,
      paymentDeployHash: HEX64('e'),
      success: true,
      timestamp: 1_700_000_001_000,
      recordTxHash: HEX64('b'),
    };
    chain.getService = async (id) => (id === 1 ? makeService(1) : null);
    chain.getScore = async () => ({ totalCalls: 10, successCalls: 10 });
    chain.listAttestations = async () => [attestation];

    const status = await serviceStatus({ chain, id: 1 });
    expect(status.service.id).toBe(1);
    expect(status.tier).toBe('reliable');
    expect(status.attestations).toEqual([attestation]);
  });

  it('skips the attestation fetch when includeAttestations is false', async () => {
    const chain = makeFakeChain();
    chain.getService = async (id) => (id === 1 ? makeService(1) : null);
    chain.getScore = async () => ({ totalCalls: 10, successCalls: 10 });
    let listed = false;
    chain.listAttestations = async () => {
      listed = true;
      return [];
    };

    const res = await serviceStatus({ chain, id: 1, includeAttestations: false });
    expect(res.attestations).toEqual([]);
    expect(listed).toBe(false);
  });

  it('rejects unknown services with SERVICE_NOT_FOUND', async () => {
    const chain = makeFakeChain();
    await expect(serviceStatus({ chain, id: 99 })).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('rejects invalid ids with INVALID_SERVICE_ID (ids are 1-based, so 0 is invalid)', async () => {
    const chain = makeFakeChain();
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(serviceStatus({ chain, id })).rejects.toMatchObject({
        code: 'INVALID_SERVICE_ID',
        httpStatus: 400,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// setServiceActive (pause / resume)
// ---------------------------------------------------------------------------

describe('setServiceActive', () => {
  const SET_ACTIVE_TX = HEX64('c');

  /** Stateful fake: setActive mutates the stored record, getService reads it back. */
  function makeToggleChain(initialActive: boolean): {
    chain: FakeChain;
    calls: Array<{ serviceId: number; active: boolean; signer: AnySigner }>;
  } {
    const record = makeService(2, { active: initialActive });
    const calls: Array<{ serviceId: number; active: boolean; signer: AnySigner }> = [];
    const chain = makeFakeChain();
    chain.setActive = async (serviceId, active, signer) => {
      calls.push({ serviceId, active, signer });
      record.active = active;
      return { txHash: SET_ACTIVE_TX };
    };
    chain.getService = async (id) => (id === 2 ? record : null);
    return { chain, calls };
  }

  it('pause: flips active true→false and returns the tx hash + fresh record', async () => {
    const { chain, calls } = makeToggleChain(true);
    const result = await setServiceActive({ chain, signer: SIGNER, id: 2, active: false });
    expect(result.txHash).toBe(SET_ACTIVE_TX);
    expect(result.service.id).toBe(2);
    expect(result.service.active).toBe(false);
    expect(calls).toEqual([{ serviceId: 2, active: false, signer: SIGNER }]);
  });

  it('resume: flips active false→true and returns the tx hash + fresh record', async () => {
    const { chain, calls } = makeToggleChain(false);
    const result = await setServiceActive({ chain, signer: SIGNER, id: 2, active: true });
    expect(result.txHash).toBe(SET_ACTIVE_TX);
    expect(result.service.active).toBe(true);
    expect(calls).toEqual([{ serviceId: 2, active: true, signer: SIGNER }]);
  });

  it('rejects invalid ids with INVALID_SERVICE_ID without touching the chain', async () => {
    const { chain, calls } = makeToggleChain(true);
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(
        setServiceActive({ chain, signer: SIGNER, id, active: false }),
      ).rejects.toMatchObject({ code: 'INVALID_SERVICE_ID', httpStatus: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it('rewords the devnet 403 not_authorized into the owner-only message', async () => {
    const chain = makeFakeChain();
    chain.setActive = async () => {
      throw new AgentGateError(
        'not_authorized',
        'only the service owner may change the active flag',
        403,
      );
    };
    await expect(
      setServiceActive({ chain, signer: SIGNER, id: 2, active: false }),
    ).rejects.toMatchObject({
      name: 'AgentGateError',
      code: 'not_authorized',
      httpStatus: 403,
      message: expect.stringContaining('only the service owner can pause/resume service 2'),
    });
  });

  it('passes other chain errors through unchanged', async () => {
    const chain = makeFakeChain();
    chain.setActive = async () => {
      throw new AgentGateError('NOT_DEPLOYED', 'registry contract is not deployed', 503);
    };
    await expect(
      setServiceActive({ chain, signer: SIGNER, id: 2, active: false }),
    ).rejects.toMatchObject({ code: 'NOT_DEPLOYED', httpStatus: 503 });
  });

  it('rejects with SERVICE_NOT_FOUND when the re-fetch after set_active finds nothing', async () => {
    const chain = makeFakeChain(); // getService → null, setActive → tx hash
    await expect(
      setServiceActive({ chain, signer: SIGNER, id: 2, active: false }),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND', httpStatus: 404 });
  });
});
