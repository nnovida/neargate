import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ActivityEvent,
  AttestationRecord,
  ChainClient,
  PaymentRequiredResponse,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { decodeXPayment, isAgentGateError, trustTier, X402_SCHEME, X402_VERSION } from '@agentgate/shared';
import { MockLlm, runBuyerAgent } from '@agentgate/buyer-agent';
import type { BuyerRunReport, CatalogEntry } from '@agentgate/buyer-agent';

/** Base58 strings of NEAR tx-hash length. */
const PAYMENT_TX = 'D'.repeat(44);
const ATTEST_TX = 'E'.repeat(44);
const TARGET = 'seller.mock';
const REGISTRY = 'registry.mock';
const SIGNER = { kind: 'mock', accountId: 'buyer.mock' } as const;
const STORAGE_FEE = '2000000000000000000000'; // 0.002 NEAR

function makeService(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: 1,
    name: 'Gold Spot Feed',
    description: 'XAU/USD gold spot price with confidence score',
    endpointUrl: 'http://gateway/svc/1',
    priceYocto: '500000000000000000000000', // 0.5 NEAR
    paymentTarget: TARGET,
    owner: 'owner.mock',
    attestor: 'attestor.mock',
    active: true,
    createdAt: 1_700_000_000_000,
    accepts: [],
    ...overrides,
  };
}

function entry(
  service: Partial<ServiceRecord>,
  score: ServiceScore = { totalCalls: 0, successCalls: 0 },
): CatalogEntry {
  const svc = makeService(service);
  return { service: svc, score, tier: trustTier(score) };
}

interface FakeChainOpts {
  services?: ServiceRecord[];
  scores?: Map<number, ServiceScore>;
  attestations?: AttestationRecord[];
  activity?: ActivityEvent[];
}

function makeChain(opts: FakeChainOpts = {}): ChainClient {
  const services = opts.services ?? [makeService()];
  const scores = opts.scores ?? new Map<number, ServiceScore>();
  const attestations = opts.attestations ?? [];
  const activity = opts.activity ?? [];
  return {
    network: 'mock',
    registryId: REGISTRY,
    getService: vi.fn(async (id: number) => services.find((s) => s.id === id) ?? null),
    listServices: vi.fn(async () => services),
    getScore: vi.fn(async (id: number) => scores.get(id) ?? { totalCalls: 0, successCalls: 0 }),
    listAttestations: vi.fn(async () => attestations),
    listRecentActivity: vi.fn(async () => activity),
    getBalance: vi.fn(async () => '1000000000000000000000000000'),
    getPayment: vi.fn(async () => null),
    verifyPayment: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
    isFullAccessKey: vi.fn(async () => false),
    registerService: vi.fn(async () => ({ serviceId: 1, txHash: 'tx' })),
    pay: vi.fn(async () => ({ txHash: PAYMENT_TX })),
    recordAttestation: vi.fn(async () => ({ txHash: 'tx' })),
    setActive: vi.fn(async () => ({ txHash: 'tx' })),
  };
}

/**
 * TODO(Task 5): a D3 invoice quotes price + storage fee as maxAmountRequired; the
 * agent's budget gate and client cap still use the bare price, so this fixture
 * quotes the price alone.
 */
function invoiceFor(service: ServiceRecord): PaymentRequiredResponse {
  return {
    x402Version: X402_VERSION,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: X402_SCHEME,
        network: 'mock',
        maxAmountRequired: service.priceYocto,
        asset: 'NEAR',
        payTo: REGISTRY,
        resource: service.endpointUrl,
        description: service.name,
        maxTimeoutSeconds: 300,
        extra: {
          nonce: '424242',
          serviceId: service.id,
          expiresAtMs: Date.now() + 300_000,
          settlement: 'neargate-registry-pay',
          contractId: REGISTRY,
          method: 'pay',
          priceYocto: service.priceYocto,
          storageFeeYocto: STORAGE_FEE,
          seller: service.paymentTarget,
          caip2: 'near:mock',
        },
      },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Paywall fake: 402 invoice without X-PAYMENT proof, 200 data with it. */
function paywallFetch(service: ServiceRecord, data: unknown) {
  return vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const xp = headers.get('X-PAYMENT');
    if (xp !== null) {
      const decoded = decodeXPayment(xp);
      expect(decoded.payload).toMatchObject({
        kind: 'tx',
        transaction: PAYMENT_TX,
        nonce: '424242',
        payer: 'buyer.mock',
      });
      return json(data, 200);
    }
    return json(invoiceFor(service), 402);
  }) as unknown as typeof fetch;
}

function tmpLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'agentgate-test-')), 'decisions.jsonl');
}

const silent = (): void => {};

describe('MockLlm.chooseService', () => {
  it('picks the cheapest active service whose name/description matches the task', async () => {
    const llm = new MockLlm();
    const catalog = [
      entry({ id: 1, name: 'Gold Spot Feed', priceYocto: '500000000000000000000000' }),
      entry({
        id: 2,
        name: 'Random Numbers',
        description: 'entropy as a service',
        priceYocto: '100000000000000000000000', // cheaper but irrelevant
      }),
    ];
    const choice = await llm.chooseService('Get the gold price for a treasury report', catalog);
    expect(choice.serviceId).toBe(1);
    expect(choice.reason).toContain('gold');
  });

  it('among multiple matches picks the cheapest', async () => {
    const llm = new MockLlm();
    const catalog = [
      entry({ id: 1, name: 'Gold Spot Feed Premium', priceYocto: '900000000000000000000000' }),
      entry({ id: 2, name: 'Gold Spot Feed Lite', priceYocto: '200000000000000000000000' }),
    ];
    const choice = await llm.chooseService('gold price please', catalog);
    expect(choice.serviceId).toBe(2);
  });

  it('breaks price ties by highest trust tier', async () => {
    const llm = new MockLlm();
    const catalog = [
      entry({ id: 1, name: 'Gold Feed A', priceYocto: '200000000000000000000000' }, { totalCalls: 0, successCalls: 0 }), // new
      entry({ id: 2, name: 'Gold Feed B', priceYocto: '200000000000000000000000' }, { totalCalls: 30, successCalls: 30 }), // trusted
    ];
    const choice = await llm.chooseService('gold price', catalog);
    expect(choice.serviceId).toBe(2);
  });

  it('ignores inactive services', async () => {
    const llm = new MockLlm();
    const catalog = [
      entry({ id: 1, name: 'Gold Feed Cheap', priceYocto: '100000000000000000000000', active: false }),
      entry({ id: 2, name: 'Gold Feed', priceYocto: '300000000000000000000000' }),
    ];
    const choice = await llm.chooseService('gold price', catalog);
    expect(choice.serviceId).toBe(2);
  });

  it('falls back to cheapest active when nothing matches the keywords', async () => {
    const llm = new MockLlm();
    const catalog = [
      entry({ id: 1, name: 'Weather Feed', description: 'rain or shine', priceYocto: '700000000000000000000000' }),
      entry({ id: 2, name: 'Stocks Feed', description: 'equities', priceYocto: '300000000000000000000000' }),
    ];
    const choice = await llm.chooseService('quantum flux telemetry', catalog);
    expect(choice.serviceId).toBe(2);
    expect(choice.reason).toContain('falling back');
  });

  it('rejects when there are no active services', async () => {
    const llm = new MockLlm();
    const catalog = [entry({ id: 1, active: false })];
    const err = await llm.chooseService('anything', catalog).catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('NO_SERVICES');
  });

  it('summarize is deterministic', async () => {
    const llm = new MockLlm();
    const a = await llm.summarize('task', { x: 1 });
    const b = await llm.summarize('task', { x: 1 });
    expect(a).toBe(b);
    expect(a).toContain('task');
    expect(a).toContain('"x":1');
  });
});

describe('runBuyerAgent', () => {
  it('runs the full loop: catalog → pick → pay → summarize → attestation receipt', async () => {
    const gold = makeService();
    const cheapIrrelevant = makeService({
      id: 2,
      name: 'Random Numbers',
      description: 'entropy as a service',
      endpointUrl: 'http://gateway/svc/2',
      priceYocto: '100000000000000000000000',
    });
    const attestation: AttestationRecord = {
      serviceId: 1,
      nonce: '424242',
      paymentTxHash: PAYMENT_TX,
      success: true,
      timestamp: Date.now(),
    };
    const attestationEvent: ActivityEvent = {
      kind: 'attestation',
      serviceId: 1,
      account: 'attestor.mock',
      txHash: ATTEST_TX,
      blockHeight: 3,
      success: true,
      nonce: '424242',
      timestamp: Date.now(),
      detail: 'attestation success for service 1',
    };
    const chain = makeChain({
      services: [gold, cheapIrrelevant],
      attestations: [attestation],
      activity: [attestationEvent],
    });
    const logPath = tmpLogPath();

    const report = await runBuyerAgent({
      task: 'Get the gold price and summarize it for a treasury report',
      budgetNear: '5',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl: paywallFetch(gold, { xau_usd: 3310.25 }),
      decisionLogPath: logPath,
      attestationTimeoutMs: 500,
      attestationPollIntervalMs: 10,
      print: silent,
    });

    // picked the matching service, not the cheaper irrelevant one
    expect(report.chosenServiceId).toBe(1);
    expect(report.paid).toBe(true);
    expect(report.paymentTxHash).toBe(PAYMENT_TX);
    expect(report.attestationTxHash).toBe(ATTEST_TX);
    expect(report.spentYocto).toBe('500000000000000000000000');
    expect(report.summary).toContain('3310.25');
    expect(report.reason.length).toBeGreaterThan(0);

    expect(chain.pay).toHaveBeenCalledTimes(1);
    expect(chain.pay).toHaveBeenCalledWith(
      { serviceId: 1, nonce: '424242', depositYocto: '500000000000000000000000' },
      SIGNER,
    );

    // decisions.jsonl has parseable lines covering the whole run
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    const steps = lines.map((l) => (JSON.parse(l) as { step: string }).step);
    expect(steps).toEqual(
      expect.arrayContaining([
        'run_start',
        'catalog',
        'choice',
        'budget_ok',
        'payment',
        'summary',
        'attestation',
        'run_end',
      ]),
    );
  });

  it('refuses BEFORE paying when the price exceeds the budget', async () => {
    const gold = makeService(); // 0.5 NEAR
    const chain = makeChain({ services: [gold] });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const logPath = tmpLogPath();

    const report = await runBuyerAgent({
      task: 'gold price',
      budgetNear: '0.1',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl,
      decisionLogPath: logPath,
      print: silent,
    });

    expect(report.paid).toBe(false);
    expect(report.paymentTxHash).toBeNull();
    expect(report.attestationTxHash).toBeNull();
    expect(report.spentYocto).toBe('0');
    expect(report.summary).toContain('refused');
    expect(chain.pay).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled(); // never even contacted the service

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    const steps = lines.map((l) => (JSON.parse(l) as { step: string }).step);
    expect(steps).toContain('budget_refusal');
    expect(steps).not.toContain('payment');
  });

  it('allows a price exactly equal to the budget', async () => {
    const gold = makeService(); // 0.5 NEAR
    const chain = makeChain({ services: [gold] });

    const report = await runBuyerAgent({
      task: 'gold price',
      budgetNear: '0.5',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl: paywallFetch(gold, { ok: true }),
      decisionLogPath: tmpLogPath(),
      attestationTimeoutMs: 50,
      attestationPollIntervalMs: 10,
      print: silent,
    });
    expect(report.paid).toBe(true);
    expect(report.spentYocto).toBe('500000000000000000000000');
  });

  it('converts a PRICE_EXCEEDED invoice (server asks more than budget) into a refusal report', async () => {
    // On-chain price fits the budget, but the invoice demands more.
    const gold = makeService({ priceYocto: '400000000000000000000000' });
    const chain = makeChain({ services: [gold] });
    const base = invoiceFor(gold);
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      json(
        {
          ...base,
          accepts: [{ ...base.accepts[0], maxAmountRequired: '900000000000000000000000' }],
        },
        402,
      ),
    ) as unknown as typeof fetch;

    const report = await runBuyerAgent({
      task: 'gold price',
      budgetNear: '0.5',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl,
      decisionLogPath: tmpLogPath(),
      print: silent,
    });

    expect(report.paid).toBe(false);
    expect(report.spentYocto).toBe('0');
    expect(report.paymentTxHash).toBeNull();
    expect(chain.pay).not.toHaveBeenCalled();
  });

  it('returns attestationTxHash null when no attestation lands within the timeout', async () => {
    const gold = makeService();
    const chain = makeChain({ services: [gold], attestations: [] });

    const report = await runBuyerAgent({
      task: 'gold price',
      budgetNear: '5',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl: paywallFetch(gold, { ok: true }),
      decisionLogPath: tmpLogPath(),
      attestationTimeoutMs: 60,
      attestationPollIntervalMs: 20,
      print: silent,
    });
    expect(report.paid).toBe(true);
    expect(report.attestationTxHash).toBeNull();
  });

  it('produces the exact BuyerRunReport shape', async () => {
    const gold = makeService();
    const chain = makeChain({ services: [gold] });

    const report: BuyerRunReport = await runBuyerAgent({
      task: 'gold price',
      budgetNear: '5',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl: paywallFetch(gold, { ok: true }),
      decisionLogPath: tmpLogPath(),
      attestationTimeoutMs: 50,
      attestationPollIntervalMs: 10,
      print: silent,
    });

    expect(Object.keys(report).sort()).toEqual([
      'attestationTxHash',
      'chosenServiceId',
      'paid',
      'paymentTxHash',
      'reason',
      'spentYocto',
      'summary',
    ]);
    expect(typeof report.chosenServiceId).toBe('number');
    expect(typeof report.reason).toBe('string');
    expect(typeof report.paid).toBe('boolean');
    expect(typeof report.summary).toBe('string');
    expect(typeof report.spentYocto).toBe('string');
  });

  it('throws NO_SERVICES on an empty catalog', async () => {
    const chain = makeChain({ services: [] });
    const err = await runBuyerAgent({
      task: 'gold price',
      budgetNear: '5',
      chain,
      signer: SIGNER,
      llm: new MockLlm(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      decisionLogPath: tmpLogPath(),
      print: silent,
    }).catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('NO_SERVICES');
  });

  it('rejects an empty task', async () => {
    const err = await runBuyerAgent({
      task: '   ',
      chain: makeChain(),
      signer: SIGNER,
      llm: new MockLlm(),
      print: silent,
    }).catch((e: unknown) => e);
    expect(isAgentGateError(err)).toBe(true);
    if (isAgentGateError(err)) expect(err.code).toBe('BAD_TASK');
  });
});
