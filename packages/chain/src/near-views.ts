import { NEAR_NATIVE_ASSET, formatNear, isRecord, stripTrailingSlashes } from '@agentgate/shared';
import type {
  ActivityEvent,
  AttestationRecord,
  PaymentOption,
  PaymentRecord,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { YOCTO_RE } from './checks';
import { badResponse } from './near-errors';

// Decoders from the `neargate-registry` JSON views (snake_case, U128 amounts as decimal strings)
// to the shared records. A view that does not have the ABI's shape is RPC_BAD_RESPONSE: the
// configured account is not answering as the registry does.

interface FieldReader {
  str(key: string): string;
  /** A non-negative safe integer (u64 ids, timestamps, block heights, counters). */
  int(key: string): number;
  bool(key: string): boolean;
  /** A U128 amount: a decimal string without sign or leading zeros. */
  amount(key: string): string;
}

function fields(value: unknown, method: string): FieldReader {
  if (!isRecord(value)) throw badResponse(`the ${method} view`);
  const pick = <T>(key: string, ok: (v: unknown) => v is T): T => {
    const v = value[key];
    if (!ok(v)) throw badResponse(`the ${method} view`);
    return v;
  };
  return {
    str: (key) => pick(key, (v): v is string => typeof v === 'string'),
    int: (key) => pick(key, (v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0),
    bool: (key) => pick(key, (v): v is boolean => typeof v === 'boolean'),
    amount: (key) => pick(key, (v): v is string => typeof v === 'string' && YOCTO_RE.test(v)),
  };
}

function list(value: unknown, method: string): unknown[] {
  if (!Array.isArray(value)) throw badResponse(`the ${method} view`);
  return value;
}

function paymentOption(value: unknown, method: string): PaymentOption {
  const f = fields(value, method);
  return { asset: f.str('asset'), amount: f.amount('amount'), decimals: f.int('decimals'), symbol: f.str('symbol') };
}

/**
 * A `ServiceView` as a ServiceRecord: `endpointUrl = <gateway_base_url>/svc/<id>` and
 * `priceYocto` = the native NEAR option's amount. A service without a native option is null:
 * the registry's `pay` cannot settle it, so NearGate does not offer it.
 */
export function parseService(value: unknown, method: string): ServiceRecord | null {
  const f = fields(value, method);
  const id = f.int('id');
  const accepts = list((value as Record<string, unknown>)['accepts'], method).map((o) => paymentOption(o, method));
  const native = accepts.find((o) => o.asset === NEAR_NATIVE_ASSET);
  if (native === undefined) return null;
  return {
    id,
    name: f.str('name'),
    description: f.str('description'),
    endpointUrl: `${stripTrailingSlashes(f.str('gateway_base_url'))}/svc/${id}`,
    priceYocto: native.amount,
    paymentTarget: f.str('payment_target'),
    owner: f.str('owner'),
    attestor: f.str('attestor'),
    active: f.bool('active'),
    createdAt: f.int('created_at_ms'),
    accepts,
  };
}

export function parsePayment(value: unknown, method: string): PaymentRecord {
  const f = fields(value, method);
  return {
    nonce: f.str('nonce'),
    serviceId: f.int('service_id'),
    payer: f.str('payer'),
    amountYocto: f.amount('amount'),
    timestamp: f.int('timestamp_ms'),
    blockHeight: f.int('block_height'),
    selfPaid: f.bool('self_paid'),
    attested: f.bool('attested'),
  };
}

export function parseScore(value: unknown, method: string): ServiceScore {
  const f = fields(value, method);
  return { totalCalls: f.int('total_calls'), successCalls: f.int('success_calls') };
}

/** `get_attestations` (newest first) for `serviceId`. */
export function parseAttestations(value: unknown, serviceId: number, method: string): AttestationRecord[] {
  return list(value, method).map((entry) => {
    const f = fields(entry, method);
    return {
      serviceId,
      nonce: f.str('nonce'),
      paymentTxHash: f.str('payment_tx_hash'),
      success: f.bool('success'),
      timestamp: f.int('timestamp_ms'),
    };
  });
}

const ACTIVITY_KINDS: ReadonlySet<string> = new Set<ActivityEvent['kind']>(['service_registered', 'payment', 'attestation']);

function isActivityKind(kind: string): kind is ActivityEvent['kind'] {
  return ACTIVITY_KINDS.has(kind);
}

/**
 * `get_recent_activity` (newest first) as feed events. A contract view cannot know which tx
 * produced an entry, so `txHash` is null; attestation events carry the attested payment's tx as
 * `paymentTxHash`, payment and attestation events their `nonce`. Entries of a kind this client
 * does not know are skipped.
 */
export function parseActivity(value: unknown, method: string): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const entry of list(value, method)) {
    const f = fields(entry, method);
    const kind = f.str('kind');
    if (!isActivityKind(kind)) continue;
    const serviceId = f.int('service_id');
    const account = f.str('account');
    const base = { kind, serviceId, account, txHash: null, blockHeight: f.int('block_height') };
    const timestamp = f.int('timestamp_ms');
    if (kind === 'service_registered') {
      events.push({ ...base, timestamp, detail: `service #${serviceId} registered by ${account}` });
    } else if (kind === 'payment') {
      const amountYocto = f.amount('amount');
      events.push({
        ...base,
        amountYocto,
        nonce: f.str('nonce'),
        timestamp,
        detail: `${account} paid ${formatNear(amountYocto)} to service #${serviceId}`,
      });
    } else {
      const success = f.bool('success');
      events.push({
        ...base,
        success,
        nonce: f.str('nonce'),
        paymentTxHash: f.str('payment_tx_hash'),
        timestamp,
        detail: `attested service #${serviceId} — ${success ? 'success' : 'failure'}`,
      });
    }
  }
  return events;
}

/**
 * True iff `action` (as the RPC's tx view shows it) is the registry ABI's
 * `pay({service_id, nonce})` for exactly this service and nonce.
 */
export function isPayAction(action: unknown, serviceId: number, nonce: string): boolean {
  if (!isRecord(action) || !isRecord(action['FunctionCall'])) return false;
  const call = action['FunctionCall'];
  if (call['method_name'] !== 'pay' || typeof call['args'] !== 'string') return false;
  let args: unknown;
  try {
    args = JSON.parse(Buffer.from(call['args'], 'base64').toString('utf8'));
  } catch {
    return false;
  }
  return isRecord(args) && args['service_id'] === serviceId && args['nonce'] === nonce;
}
