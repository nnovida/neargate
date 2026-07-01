import { readFile, stat } from 'node:fs/promises';
import { BigNumber } from '@ethersproject/bignumber';
import { blake2b } from '@noble/hashes/blake2b';
import {
  Args,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  Key,
  KeyAlgorithm,
  NativeTransferBuilder,
  ParamDictionaryIdentifier,
  ParamDictionaryIdentifierContractNamedKey,
  PrivateKey,
  PublicKey,
  RpcClient,
  AccountHash,
} from './sdk';
import { AgentGateError } from '@agentgate/shared';
import type {
  ActivityEvent,
  AgentGateConfig,
  AnySigner,
  AttestationRecord,
  ChainClient,
  Motes,
  PemSignerRef,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
  VerifyResult,
  VerifyTransferQuery,
} from '@agentgate/shared';

const MOTES_RE = /^(0|[1-9]\d*)$/;
const U64_MAX = 18_446_744_073_709_551_615n;

// Gas budgets, measured against live Casper 2.0 testnet (2026-06-29). The node REJECTS a
// contract-call transaction whose payment is below a ~2.5 CSPR minimum with "Invalid
// transaction" (-32016) at submit — set_active at 1.5 CSPR was rejected, while
// record_attestation (2.5) and register_service (5) went through. Keep every contract-call
// budget >= ~2.5 CSPR. (The native-transfer payment below is separate from the >= 2.5 CSPR
// minimum that applies to the transfer AMOUNT itself.)
const GAS_NATIVE_TRANSFER_MOTES = 100_000_000; // 0.1 CSPR — native-transfer payment
const GAS_REGISTER_SERVICE_MOTES = 5_000_000_000; // 5 CSPR
const GAS_RECORD_ATTESTATION_MOTES = 5_000_000_000; // 5 CSPR — rewrites the capped Vec (most expensive)
const GAS_SET_ACTIVE_MOTES = 3_000_000_000; // 3 CSPR — above the ~2.5 CSPR contract-call minimum

// Odra 2.x assigns each module field a 1-based storage index in declaration
// order (odra-macros emits `idx as u8 + 1`). The registry declares, in order,
//   services_count(1), services(2), scores(3), seen_payments(4), attestations(5)
// — see contracts/agentgate-registry/src/registry.rs. These indices feed the
// dictionary-item-key derivation (odraDictionaryItemKey); an off-by-one here
// silently reads the WRONG dictionary item (e.g. scores[id] would collide with
// services[id]).
// ⚠️ confirm once against a real testnet dictionary read before relying on live
// reads (docs/DEPLOY.md read-path smoke test) — the deploy itself is out of scope.
const STATE_INDEX = {
  servicesCount: 1,
  services: 2,
  scores: 3,
} as const;

/** Odra 2.x keeps all module state in a single contract dictionary named "state". */
const ODRA_STATE_DICTIONARY = 'state'; // ⚠️ verify against deployed contract

const TX_POLL_INTERVAL_MS = 2_000;
const TX_WAIT_TIMEOUT_MS = 120_000;

function notDeployed(): AgentGateError {
  return new AgentGateError(
    'NOT_DEPLOYED',
    'requires REGISTRY_CONTRACT_PACKAGE_HASH — run contracts deploy first',
    503,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounds a node-RPC call so a slow/half-open Casper node cannot hang the caller
 * forever. casper-js-sdk's HttpHandler exposes no timeout option and axios
 * defaults to `timeout: 0`, so we race the call against a timer (the underlying
 * socket may keep going, but we stop waiting and surface a clean error).
 */
async function withRpcTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AgentGateError('RPC_TIMEOUT', `${label} timed out after ${ms}ms`, 504)),
      ms,
    );
  });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bounded retry-with-backoff for idempotent node-RPC reads. Retries transient
 * transport/timeout failures (jittered backoff, capped by the per-call timeout)
 * but never retries deterministic on-chain failures.
 */
async function withReadRetry<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await withRpcTimeout(label, timeoutMs, fn);
    } catch (error) {
      lastError = error;
      // Deterministic on-chain failures will not change on retry.
      if (error instanceof AgentGateError && error.code === 'TX_FAILED') throw error;
      if (attempt < attempts - 1) {
        await sleep(Math.min(200 * 2 ** attempt + attempt * 50, timeoutMs));
      }
    }
  }
  throw lastError;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function normalizeAccountHashHex(value: string): string {
  return value.toLowerCase().replace(/^account-hash-/, '');
}

function stripHashPrefix(value: string): string {
  return value.toLowerCase().replace(/^(contract-package-wasm|contract-package-|hash-)/, '');
}

/**
 * Picks the highest-numbered ENABLED contract version. `disabledVersions` is the
 * SDK's `number[][]` where each entry's first element is the disabled
 * `contractVersion`. Returns null when nothing is enabled.
 */
export function pickLatestVersion<T extends { contractVersion: number }>(
  versions: T[],
  disabledVersions: number[][],
): T | null {
  const disabled = new Set(disabledVersions.map((d) => d[0]));
  const enabled = versions.filter((v) => !disabled.has(v.contractVersion));
  if (enabled.length === 0) return null;
  return enabled.reduce((best, v) => (v.contractVersion > best.contractVersion ? v : best));
}

function u64LeBytes(value: number | bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(value), true);
  return new Uint8Array(buf);
}

/**
 * Odra 2.x dictionary item key for a module-state field (Var or Mapping entry).
 *
 * Odra keeps all module state in one contract dictionary named "state". The item
 * key is the lowercase-hex blake2b-256 digest of `index_bytes ++ mapping_key`,
 * where `index_bytes` is the field's storage index — see `odra-core`
 * (2.7.2/2.8.1, identical codec) `ContractEnv::index_bytes()` / `current_key()`.
 * For top-level fields (index ≤ 15) the index is packed into a u32 and emitted
 * as 4 BIG-ENDIAN bytes; a u64 mapping key serializes as 8 little-endian bytes
 * (Casper `ToBytes`). NOTE: field indices are 1-based — see {@link STATE_INDEX}.
 */
export function odraDictionaryItemKey(index: number, keyBytes?: Uint8Array): string {
  // Field index as a 4-byte big-endian u32 (Odra `index_bytes()` for fields ≤ 15).
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, index, false);
  const material = keyBytes ? Uint8Array.from([...prefix, ...keyBytes]) : prefix;
  return bytesToHex(blake2b(material, { dkLen: 32 }));
}

/**
 * Strips the CLValue `List<U8>` framing from a stored Odra value. Odra persists
 * every module-state field via `CLValue::from_t(bytes.to_vec())`, whose CLType is
 * `List<U8>`; the SDK serializes that as a 4-byte little-endian element count
 * followed by the payload. We read the declared length, assert it matches the
 * remaining buffer, and return the bare payload. A mismatch means the stored
 * shape is not what we expect — fail loudly instead of silently mis-decoding.
 */
function stripListU8Prefix(raw: Uint8Array): Uint8Array {
  if (raw.length < 4) {
    throw new AgentGateError(
      'STATE_PARSE_FAILED',
      `dictionary value too short for a List<U8> length prefix (${raw.length} bytes)`,
      502,
    );
  }
  const declaredLen = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
  const payload = raw.subarray(4);
  if (declaredLen !== payload.length) {
    throw new AgentGateError(
      'STATE_PARSE_FAILED',
      `List<U8> length prefix (${declaredLen}) != payload length (${payload.length}) — unexpected stored value shape`,
      502,
    );
  }
  return payload;
}

/** Sequential reader for Casper `ToBytes` payloads stored by the Odra contract. */
class ByteReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private take(n: number): Uint8Array {
    if (this.offset + n > this.buf.length) {
      throw new Error(`unexpected end of state bytes at offset ${this.offset}`);
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u32le(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64le(): bigint {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bool(): boolean {
    const value = this.u8();
    if (value !== 0 && value !== 1) throw new Error(`invalid bool byte ${value}`);
    return value === 1;
  }

  string(): string {
    const len = this.u32le();
    return new TextDecoder('utf-8', { fatal: true }).decode(this.take(len));
  }

  /** U512: 1 length byte then little-endian magnitude bytes. */
  u512(): bigint {
    const len = this.u8();
    const bytes = this.take(len);
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i -= 1) {
      value = (value << 8n) | BigInt(bytes[i] ?? 0);
    }
    return value;
  }

  /**
   * Odra `Address`: 1 tag byte + 32 hash bytes (0 = account, 1 = contract package).
   * ⚠️ verify against deployed contract — tag values per odra-core Address codec.
   */
  address(): string {
    const tag = this.u8();
    const hex = bytesToHex(this.take(32));
    if (tag === 0) return `account-hash-${hex}`;
    return `contract-package-${hex}`;
  }
}

// ---- CSPR.cloud REST response shapes (subset we consume) ----------------------
// ⚠️ verify against deployed contract — field names per docs.cspr.cloud once the
// first real deploys/transfers exist to inspect.

interface CloudListEnvelope<T> {
  data?: T[];
}

interface CloudItemEnvelope<T> {
  data?: T;
}

interface CloudTransfer {
  deploy_hash?: string;
  transaction_hash?: string;
  to_account_hash?: string | null;
  from_account_hash?: string | null;
  initiator_account_hash?: string | null;
  amount?: string | number;
  /** `GET /deploys/<hash>/transfers` calls it `id`; the legacy `/transfers` used `transfer_id`. */
  id?: string | number | null;
  transfer_id?: string | number | null;
  timestamp?: string;
}

interface CloudDeploy {
  deploy_hash?: string;
  block_hash?: string | null;
  error_message?: string | null;
  timestamp?: string;
  entry_point?: { name?: string } | null;
  entry_point_name?: string | null;
  args?: Record<string, { parsed?: unknown } | undefined> | null;
}

interface CloudAccount {
  balance?: string | number;
}

function cloudArg(deploy: CloudDeploy, name: string): unknown {
  const entry = deploy.args?.[name];
  return entry?.parsed;
}

/**
 * The registry entry point of a CSPR.cloud contract-call deploy. CSPR.cloud
 * dropped the entry-point NAME (it now returns only a numeric `entry_point_id`),
 * so when the name is absent we infer it from the call's argument set — the
 * registry's entry points have disjoint args. Exported for unit testing.
 */
export function cloudEntryPoint(deploy: CloudDeploy): string {
  if (deploy.entry_point?.name) return deploy.entry_point.name;
  if (deploy.entry_point_name) return deploy.entry_point_name;
  const args = deploy.args ?? {};
  const has = (k: string): boolean => k in args;
  if (has('payment_deploy_hash')) return 'record_attestation';
  if (has('name') && has('price')) return 'register_service';
  if (has('active')) return 'set_active';
  if (has('attestor')) return 'set_attestor';
  return '';
}

function parseCloudTimestamp(value: string | undefined): number {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Parse a CSPR.cloud motes amount. Motes always exceed 2^53, so the API returns
 * them as integer strings; a JSON `number` here would lose precision and could
 * silently accept an underpayment in verifyTransfer. We therefore reject any
 * non-string-integer value loudly rather than truncating money.
 */
function parseCloudAmount(value: string | number | undefined): bigint {
  if (typeof value === 'string' && MOTES_RE.test(value)) return BigInt(value);
  throw new AgentGateError(
    'CSPR_CLOUD_ERROR',
    `expected an integer-string motes amount from CSPR.cloud, got ${typeof value}: ${String(value)}`,
    502,
  );
}

/**
 * Live Casper Testnet ChainClient (SPEC §4):
 * - writes via casper-js-sdk v5 transaction builders + node RPC `putTransaction`,
 * - reads/verifyTransfer via CSPR.cloud REST (auth header is the RAW token, no
 *   "Bearer" prefix) plus node-RPC dictionary reads for the registry state,
 * - every contract-dependent path throws AgentGateError('NOT_DEPLOYED', …, 503)
 *   while REGISTRY_CONTRACT_PACKAGE_HASH is unset.
 */
export class LiveCasperClient implements ChainClient {
  readonly network: string;
  private readonly cfg: AgentGateConfig;
  private readonly rpc: RpcClient;
  private readonly cloudBase: string;
  private readonly pemCache = new Map<string, PrivateKey>();
  private contractHashCache: string | null = null;

  constructor(config: AgentGateConfig) {
    this.cfg = config;
    this.network = config.casperNetwork;
    this.cloudBase = config.csprCloudApiUrl.replace(/\/+$/, '');
    this.rpc = new RpcClient(new HttpHandler(config.casperNodeUrl));
  }

  // ---- plumbing -------------------------------------------------------------

  /** Readiness probe: a bounded node-RPC status call (throws if unreachable). */
  async ping(): Promise<void> {
    await withRpcTimeout('node RPC getStatus', this.cfg.upstreamTimeoutMs, () =>
      this.rpc.getStatus(),
    );
  }

  private requireContract(): string {
    const hash = this.cfg.registryContractPackageHash.trim();
    if (hash === '') throw notDeployed();
    return stripHashPrefix(hash);
  }

  private async cloudGet<T>(path: string, allow404 = false): Promise<T | null> {
    const url = `${this.cloudBase}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: 'application/json',
          // CSPR.cloud expects the raw access token — no "Bearer" prefix.
          authorization: this.cfg.csprCloudApiKey,
        },
        // Never let a slow/hung CSPR.cloud block the middleware request forever.
        signal: AbortSignal.timeout(this.cfg.upstreamTimeoutMs),
        // Live chain state: bypass any fetch-layer cache (e.g. Next.js) so the
        // dashboard never shows stale on-chain reads. `cache` is a valid web
        // fetch option Node accepts but omits from its RequestInit types.
        cache: 'no-store',
      } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AgentGateError(
        timedOut ? 'CSPR_CLOUD_TIMEOUT' : 'CSPR_CLOUD_UNREACHABLE',
        `CSPR.cloud request ${timedOut ? 'timed out' : 'failed'} (GET ${url}): ${error instanceof Error ? error.message : String(error)}`,
        timedOut ? 504 : 502,
      );
    }
    if (res.status === 404 && allow404) {
      await res.text().catch(() => undefined);
      return null;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new AgentGateError(
        'CSPR_CLOUD_ERROR',
        `CSPR.cloud responded ${res.status} on GET ${path}: ${text.slice(0, 200)}`,
        502,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentGateError(
        'CSPR_CLOUD_ERROR',
        `CSPR.cloud returned non-JSON body on GET ${path}`,
        502,
      );
    }
  }

  private async loadPemKey(signer: AnySigner): Promise<PrivateKey> {
    if (signer.kind !== 'pem') {
      throw new AgentGateError(
        'invalid_signer',
        `LiveCasperClient requires a pem signer, got "${signer.kind}"`,
        400,
      );
    }
    const pemSigner: PemSignerRef = signer;
    const cached = this.pemCache.get(pemSigner.pemPath);
    if (cached) return cached;

    // Warn loudly if the signing key is group/other-accessible (POSIX only).
    if (process.platform !== 'win32') {
      try {
        const st = await stat(pemSigner.pemPath);
        if ((st.mode & 0o077) !== 0) {
          process.stderr.write(
            `[agentgate] WARNING: signer key ${pemSigner.pemPath} is group/other-accessible ` +
              `(mode ${(st.mode & 0o777).toString(8)}); run \`chmod 600\` on it.\n`,
          );
        }
      } catch {
        // A stat failure surfaces as SIGNER_PEM_UNREADABLE from readFile below.
      }
    }

    let content: string;
    try {
      content = await readFile(pemSigner.pemPath, 'utf8');
    } catch (error) {
      throw new AgentGateError(
        'SIGNER_PEM_UNREADABLE',
        `cannot read signer PEM at ${pemSigner.pemPath}: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    let key: PrivateKey | null = null;
    for (const algorithm of [KeyAlgorithm.ED25519, KeyAlgorithm.SECP256K1]) {
      try {
        key = PrivateKey.fromPem(content, algorithm);
        break;
      } catch {
        // try the next algorithm
      }
    }
    if (key === null) {
      throw new AgentGateError(
        'SIGNER_PEM_INVALID',
        `PEM at ${pemSigner.pemPath} is neither a valid ed25519 nor secp256k1 key`,
        500,
      );
    }
    this.pemCache.set(pemSigner.pemPath, key);
    return key;
  }

  private async putTransaction(tx: ReturnType<NativeTransferBuilder['build']>): Promise<string> {
    try {
      const result = await withRpcTimeout('node RPC putTransaction', this.cfg.upstreamTimeoutMs, () =>
        this.rpc.putTransaction(tx),
      );
      return result.transactionHash.toHex();
    } catch (error) {
      if (error instanceof AgentGateError) throw error;
      throw new AgentGateError(
        'RPC_ERROR',
        `node RPC put failed: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
  }

  /** Polls node RPC until the transaction executed (throws on on-chain failure). */
  private async waitForTransaction(txHash: string): Promise<void> {
    const deadline = Date.now() + TX_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const info = await withRpcTimeout(
          'node RPC getTransaction',
          this.cfg.upstreamTimeoutMs,
          () => this.rpc.getTransactionByTransactionHash(txHash),
        );
        const exec = info.executionInfo;
        if (exec?.executionResult) {
          const errorMessage = exec.executionResult.errorMessage;
          if (errorMessage) {
            throw new AgentGateError(
              'TX_FAILED',
              `transaction ${txHash} failed on-chain: ${errorMessage}`,
              502,
            );
          }
          return;
        }
      } catch (error) {
        // A real on-chain failure is terminal; a per-call timeout or
        // "not found / not executed yet" is transient — keep polling until the
        // overall deadline below.
        if (error instanceof AgentGateError && error.code === 'TX_FAILED') throw error;
      }
      await sleep(TX_POLL_INTERVAL_MS);
    }
    throw new AgentGateError(
      'TX_TIMEOUT',
      `transaction ${txHash} not executed within ${TX_WAIT_TIMEOUT_MS}ms`,
      504,
    );
  }

  // ---- contract state reads ---------------------------------------------------

  /**
   * Resolves the active contract hash behind the registry package via node RPC
   * (`query_global_state` on the package key) — no CSPR.cloud key required.
   */
  private async resolveContractHash(): Promise<string> {
    const packageHash = this.requireContract();
    if (this.contractHashCache) return this.contractHashCache;

    const res = await withRpcTimeout(
      'node RPC queryLatestGlobalState (package)',
      this.cfg.upstreamTimeoutMs,
      () => this.rpc.queryLatestGlobalState(`hash-${packageHash}`, []),
    );
    const pkg = res.storedValue?.contractPackage;
    if (!pkg) {
      throw new AgentGateError(
        'CONTRACT_RESOLVE_FAILED',
        `package hash-${packageHash} has no contractPackage stored value (node RPC)`,
        502,
      );
    }
    const latest = pickLatestVersion(pkg.versions, pkg.disabledVersions);
    if (!latest) {
      throw new AgentGateError(
        'CONTRACT_RESOLVE_FAILED',
        `package hash-${packageHash} has no enabled contract versions`,
        502,
      );
    }
    this.contractHashCache = latest.contractHash.hash.toHex();
    return this.contractHashCache;
  }

  /** Odra 2.x dictionary item key — see {@link odraDictionaryItemKey}. */
  private odraStateKey(index: number, keyBytes?: Uint8Array): string {
    return odraDictionaryItemKey(index, keyBytes);
  }

  /** Reads one item from the registry's "state" dictionary; null when absent. */
  private async readStateBytes(itemKey: string): Promise<Uint8Array | null> {
    const contractHash = await this.resolveContractHash();
    try {
      const result = await withReadRetry(
        'node RPC getDictionaryItem',
        this.cfg.upstreamTimeoutMs,
        () =>
          this.rpc.getDictionaryItemByIdentifier(
            null,
            new ParamDictionaryIdentifier(
              undefined,
              new ParamDictionaryIdentifierContractNamedKey(
                `hash-${contractHash}`,
                ODRA_STATE_DICTIONARY,
                itemKey,
              ),
            ),
          ),
      );
      const clValue = result.storedValue.clValue;
      if (!clValue) return null;
      // Odra stores each module-state value as a CLValue `List<U8>`
      // (`CLValue::from_t(bytes.to_vec())` in odra-casper-wasm-env), so the
      // SDK's clValue.bytes() is the List serialization: a 4-byte LITTLE-ENDIAN
      // element count followed by the raw payload. Strip and validate the
      // prefix; if it doesn't match we fail loudly rather than mis-decode.
      return stripListU8Prefix(clValue.bytes());
    } catch (error) {
      if (error instanceof AgentGateError) throw error;
      // Dictionary item not found ⇒ value was never written.
      return null;
    }
  }

  private async readServicesCount(): Promise<number> {
    const bytes = await this.readStateBytes(this.odraStateKey(STATE_INDEX.servicesCount));
    if (bytes === null || bytes.length === 0) return 0;
    const count = new ByteReader(bytes).u64le();
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AgentGateError('STATE_PARSE_FAILED', 'services_count exceeds 2^53', 502);
    }
    return Number(count);
  }

  /**
   * Parses the contract's `Service` struct (SPEC §10 field order: name,
   * description, gateway_base_url, price, payment_target, owner, attestor,
   * active, created_at). ⚠️ verify against deployed contract.
   */
  private parseService(bytes: Uint8Array, id: number): ServiceRecord {
    try {
      const reader = new ByteReader(bytes);
      const name = reader.string();
      const description = reader.string();
      const gatewayBaseUrl = reader.string().replace(/\/+$/, '');
      const priceMotes = reader.u512().toString();
      const paymentTarget = reader.address();
      const owner = reader.address();
      const attestor = reader.address();
      const active = reader.bool();
      const createdAt = Number(reader.u64le());
      return {
        id,
        name,
        description,
        // SPEC §9 final decision: readers compute endpointUrl from the stored base.
        endpointUrl: `${gatewayBaseUrl}/svc/${id}`,
        priceMotes,
        paymentTarget,
        // ⚠️ verify against deployed contract — on-chain Addresses surface as
        // account-hash strings here (public keys are not stored by the contract).
        owner,
        attestor,
        active,
        createdAt,
      };
    } catch (error) {
      throw new AgentGateError(
        'STATE_PARSE_FAILED',
        `cannot parse Service ${id} from contract state: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
  }

  // ---- ChainClient reads ------------------------------------------------------

  async getService(id: number): Promise<ServiceRecord | null> {
    this.requireContract();
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const bytes = await this.readStateBytes(
      this.odraStateKey(STATE_INDEX.services, u64LeBytes(id)),
    );
    if (bytes === null) return null;
    return this.parseService(bytes, id);
  }

  async listServices(): Promise<ServiceRecord[]> {
    this.requireContract();
    const count = await this.readServicesCount();
    const ids = Array.from({ length: count }, (_, i) => i + 1); // ids are 1-based ⚠️ verify against deployed contract
    const records = await Promise.all(ids.map((id) => this.getService(id)));
    return records.filter((r): r is ServiceRecord => r !== null);
  }

  async getScore(id: number): Promise<ServiceScore> {
    this.requireContract();
    if (!Number.isSafeInteger(id) || id < 1) return { totalCalls: 0, successCalls: 0 };
    const bytes = await this.readStateBytes(this.odraStateKey(STATE_INDEX.scores, u64LeBytes(id)));
    if (bytes === null) return { totalCalls: 0, successCalls: 0 };
    try {
      const reader = new ByteReader(bytes);
      return { totalCalls: Number(reader.u64le()), successCalls: Number(reader.u64le()) };
    } catch (error) {
      throw new AgentGateError(
        'STATE_PARSE_FAILED',
        `cannot parse score for service ${id}: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
  }

  /**
   * Attestations are reconstructed from CSPR.cloud deploys against the registry
   * package (each successful `record_attestation` deploy IS the attestation tx,
   * so its hash doubles as recordTxHash).
   */
  async listAttestations(serviceId: number, limit = 50): Promise<AttestationRecord[]> {
    const packageHash = this.requireContract();
    // ⚠️ verify against deployed contract — CSPR.cloud deploys filter params/shape.
    const res = await this.cloudGet<CloudListEnvelope<CloudDeploy>>(
      `/deploys?contract_package_hash=${packageHash}&page_size=100&order_by=timestamp&order_direction=DESC`,
      true,
    );
    const deploys = res?.data ?? [];
    const out: AttestationRecord[] = [];
    for (const deploy of deploys) {
      if (cloudEntryPoint(deploy) !== 'record_attestation') continue;
      if (deploy.error_message) continue; // reverted deploys recorded nothing
      const sid = Number(cloudArg(deploy, 'service_id'));
      if (!Number.isSafeInteger(sid) || sid !== serviceId) continue;
      out.push({
        serviceId,
        paymentDeployHash: String(cloudArg(deploy, 'payment_deploy_hash') ?? ''),
        success: cloudArg(deploy, 'success') === true || cloudArg(deploy, 'success') === 'true',
        timestamp: parseCloudTimestamp(deploy.timestamp),
        recordTxHash: deploy.deploy_hash ?? '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Activity = registry deploys (register/attest) + transfers into payment targets. */
  async listRecentActivity(limit = 50): Promise<ActivityEvent[]> {
    const packageHash = this.requireContract();
    const events: ActivityEvent[] = [];

    // ⚠️ verify against deployed contract — CSPR.cloud deploys filter params/shape.
    const res = await this.cloudGet<CloudListEnvelope<CloudDeploy>>(
      `/deploys?contract_package_hash=${packageHash}&page_size=100&order_by=timestamp&order_direction=DESC`,
      true,
    );
    for (const deploy of res?.data ?? []) {
      if (deploy.error_message) continue;
      const entryPoint = cloudEntryPoint(deploy);
      const timestamp = parseCloudTimestamp(deploy.timestamp);
      if (entryPoint === 'register_service') {
        const name = String(cloudArg(deploy, 'name') ?? 'service');
        events.push({
          kind: 'service_registered',
          txHash: deploy.deploy_hash ?? '',
          serviceId: null, // the id is assigned on-chain; not present in the deploy args
          timestamp,
          detail: `service "${name}" registered`,
        });
      } else if (entryPoint === 'record_attestation') {
        const sid = Number(cloudArg(deploy, 'service_id'));
        const success =
          cloudArg(deploy, 'success') === true || cloudArg(deploy, 'success') === 'true';
        events.push({
          kind: 'attestation',
          txHash: deploy.deploy_hash ?? '',
          serviceId: Number.isSafeInteger(sid) ? sid : null,
          success,
          timestamp,
          detail: `attestation ${success ? 'success' : 'failure'} for service ${sid}`,
        });
      }
    }

    // Payment events: transfers into each registered service's payment target.
    const services = await this.listServices();
    const targets = [...new Set(services.map((s) => s.paymentTarget))].slice(0, 10);
    for (const target of targets) {
      const hex = normalizeAccountHashHex(target);
      // ⚠️ verify against deployed contract — CSPR.cloud account-transfers endpoint shape.
      const transfers = await this.cloudGet<CloudListEnvelope<CloudTransfer>>(
        `/accounts/${hex}/transfers?page_size=20`,
        true,
      );
      for (const transfer of transfers?.data ?? []) {
        if (normalizeAccountHashHex(transfer.to_account_hash ?? '') !== hex) continue;
        const service = services.find((s) => normalizeAccountHashHex(s.paymentTarget) === hex);
        const amount = parseCloudAmount(transfer.amount);
        events.push({
          kind: 'payment',
          txHash: transfer.deploy_hash ?? transfer.transaction_hash ?? '',
          serviceId: service?.id ?? null,
          amountMotes: amount.toString(),
          timestamp: parseCloudTimestamp(transfer.timestamp),
          detail: `payment of ${amount} motes to ${target}`,
        });
      }
    }

    events.sort((a, b) => b.timestamp - a.timestamp);
    return events.slice(0, limit);
  }

  async getBalance(account: string): Promise<Motes> {
    if (typeof account !== 'string' || account.trim() === '') {
      throw new AgentGateError('invalid_query', 'account must be a non-empty string', 400);
    }
    const ident = normalizeAccountHashHex(account);
    // ⚠️ verify against deployed contract — CSPR.cloud account payload (`balance` motes).
    const res = await this.cloudGet<CloudItemEnvelope<CloudAccount>>(`/accounts/${ident}`, true);
    if (res?.data === undefined) return '0';
    return parseCloudAmount(res.data.balance).toString();
  }

  /** CSPR.cloud `GET /deploys/<hash>/transfers` → target/amount/id/age checks. */
  async verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult> {
    const res = await this.cloudGet<CloudListEnvelope<CloudTransfer>>(
      `/deploys/${encodeURIComponent(q.deployHash)}/transfers`,
      true,
    );
    const transfers = res?.data ?? [];
    if (transfers.length === 0) {
      // Distinguish "still settling" from "no such deploy".
      const deploy = await this.cloudGet<CloudItemEnvelope<CloudDeploy>>(
        `/deploys/${encodeURIComponent(q.deployHash)}`,
        true,
      );
      const d = deploy?.data;
      if (!d) return { ok: false, reason: 'not_found' };
      // ⚠️ verify against deployed contract — pending detection via block_hash/error fields.
      if (!d.block_hash && !d.error_message) return { ok: false, reason: 'pending' };
      return { ok: false, reason: 'not_found' };
    }

    const expectedTarget = normalizeAccountHashHex(q.expectedTarget);
    const expectedId = BigInt(q.expectedTransferId);
    // New endpoint exposes the transfer id as `id`; the legacy one used `transfer_id`.
    const transferIdOf = (t: CloudTransfer): string => {
      const raw = t.id ?? t.transfer_id;
      return raw === null || raw === undefined ? '' : String(raw);
    };
    // Match on target AND transfer id together (F5): a single deploy can carry
    // several transfers to the same payment target, so pick the one that
    // actually carries our nonce rather than the first-by-target. The amount and
    // age checks below then bind to that specific transfer.
    const toTarget = transfers.filter(
      (t) => normalizeAccountHashHex(t.to_account_hash ?? '') === expectedTarget,
    );
    if (toTarget.length === 0) return { ok: false, reason: 'wrong_target' };
    const match = toTarget.find((t) => {
      const tid = transferIdOf(t);
      return /^\d+$/.test(tid) && BigInt(tid) === expectedId;
    });
    if (!match) return { ok: false, reason: 'wrong_transfer_id' };

    const amount = parseCloudAmount(match.amount);
    if (amount < BigInt(q.minAmountMotes)) return { ok: false, reason: 'amount_too_low' };

    const timestamp = parseCloudTimestamp(match.timestamp);
    if (Date.now() - timestamp > q.maxAgeMs) return { ok: false, reason: 'expired' };

    const fromHex = normalizeAccountHashHex(
      match.initiator_account_hash ?? match.from_account_hash ?? '',
    );
    return {
      ok: true,
      amountMotes: amount.toString(),
      from: fromHex === '' ? '' : `account-hash-${fromHex}`,
      timestamp,
    };
  }

  // ---- ChainClient writes -------------------------------------------------------

  private async callEntrypoint(
    entryPoint: string,
    args: Args,
    signer: AnySigner,
    gasMotes: number,
  ): Promise<string> {
    const packageHash = this.requireContract();
    const key = await this.loadPemKey(signer);
    const tx = new ContractCallBuilder()
      .from(key.publicKey)
      .byPackageHash(packageHash)
      .entryPoint(entryPoint)
      .runtimeArgs(args)
      .chainName(this.cfg.casperNetwork)
      .payment(gasMotes)
      .build();
    tx.sign(key);
    return await this.putTransaction(tx);
  }

  /** Builds a CLValue Key for an `account-hash-…` string (Odra Address::Account). */
  private accountKey(accountHash: string): CLValue {
    const hex = normalizeAccountHashHex(accountHash);
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new AgentGateError(
        'invalid_account_hash',
        `expected "account-hash-<64 hex>", got ${accountHash}`,
        400,
      );
    }
    return CLValue.newCLKey(Key.newKey(`account-hash-${hex}`));
  }

  async registerService(
    input: RegisterServiceInput,
    signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    this.requireContract();
    if (input.name.trim() === '') {
      throw new AgentGateError('empty_name', 'service name must not be empty', 400);
    }
    if (!MOTES_RE.test(input.priceMotes) || BigInt(input.priceMotes) < 1000n) {
      throw new AgentGateError('invalid_price', 'priceMotes must be ≥ 1000 motes', 400);
    }
    // The contract's attestor arg is an Address — derive it from the public key hex.
    // ⚠️ verify against deployed contract — arg names + Address (Key) encoding per Odra ABI.
    const attestorKey = CLValue.newCLKey(
      Key.newKey(PublicKey.fromHex(input.attestor).accountHash().toPrefixedString()),
    );
    const args = Args.fromMap({
      name: CLValue.newCLString(input.name),
      description: CLValue.newCLString(input.description),
      // SPEC §9 final decision: endpointUrl carries the GATEWAY BASE url on input.
      gateway_base_url: CLValue.newCLString(input.endpointUrl.replace(/\/+$/, '')),
      price: CLValue.newCLUInt512(BigNumber.from(input.priceMotes)),
      payment_target: this.accountKey(input.paymentTarget),
      attestor: attestorKey,
    });
    const txHash = await this.callEntrypoint(
      'register_service',
      args,
      signer,
      GAS_REGISTER_SERVICE_MOTES,
    );
    // The id is assigned on-chain — wait for execution, then read the new count.
    // ⚠️ verify against deployed contract — ids assumed 1-based (id == count after insert).
    await this.waitForTransaction(txHash);
    const serviceId = await this.readServicesCount();
    if (serviceId < 1) {
      throw new AgentGateError(
        'STATE_PARSE_FAILED',
        `register_service ${txHash} executed but services_count is still 0`,
        502,
      );
    }
    return { serviceId, txHash };
  }

  async recordAttestation(
    input: { serviceId: number; paymentDeployHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    this.requireContract();
    if (!Number.isSafeInteger(input.serviceId) || input.serviceId < 1) {
      throw new AgentGateError('invalid_query', 'serviceId must be a positive integer', 400);
    }
    const args = Args.fromMap({
      service_id: CLValue.newCLUint64(input.serviceId),
      payment_deploy_hash: CLValue.newCLString(input.paymentDeployHash),
      success: CLValue.newCLValueBool(input.success),
    });
    const txHash = await this.callEntrypoint(
      'record_attestation',
      args,
      signer,
      GAS_RECORD_ATTESTATION_MOTES,
    );
    return { txHash };
  }

  async setActive(
    serviceId: number,
    active: boolean,
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    this.requireContract();
    if (!Number.isSafeInteger(serviceId) || serviceId < 1) {
      throw new AgentGateError('invalid_query', 'serviceId must be a positive integer', 400);
    }
    const args = Args.fromMap({
      service_id: CLValue.newCLUint64(serviceId),
      active: CLValue.newCLValueBool(active),
    });
    const txHash = await this.callEntrypoint('set_active', args, signer, GAS_SET_ACTIVE_MOTES);
    return { txHash };
  }

  /** Native CSPR transfer with transfer_id (Plan B payment rail). */
  async transfer(
    input: { to: string; amountMotes: Motes; transferId: string },
    signer: AnySigner,
  ): Promise<{ deployHash: string }> {
    if (!MOTES_RE.test(input.amountMotes) || BigInt(input.amountMotes) < 1n) {
      throw new AgentGateError('invalid_query', 'amountMotes must be a positive motes string', 400);
    }
    if (!MOTES_RE.test(input.transferId) || BigInt(input.transferId) > U64_MAX) {
      throw new AgentGateError('invalid_query', 'transferId must be a u64 decimal string', 400);
    }
    const key = await this.loadPemKey(signer);
    const target = AccountHash.fromString(input.to);
    const tx = new NativeTransferBuilder()
      .from(key.publicKey)
      .targetAccountHash(target)
      .amount(input.amountMotes)
      // The SDK types `id` as number but newCLUint64 accepts any BigNumberish at
      // runtime; u64 transfer ids exceed 2^53, so we pass a BigNumber through.
      .id(BigNumber.from(input.transferId) as unknown as number)
      .chainName(this.cfg.casperNetwork)
      .payment(GAS_NATIVE_TRANSFER_MOTES)
      .build();
    tx.sign(key);
    const deployHash = await this.putTransaction(tx);
    return { deployHash };
  }
}
