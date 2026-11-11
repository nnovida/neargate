import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  KeyPair,
  KeyPairSigner,
  KeyType,
  Signature,
  actions,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
} from 'near-api-js';
import type { Action } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { SIGNED_DELEGATE_MAX } from '@agentgate/shared';
import {
  PAY_DELEGATE_GAS,
  RELAY_MIN_TTL_BLOCKS,
  buildEscrowPayDelegate,
  decodeSignedDelegate,
  inspectPayDelegate,
  judgeRelayOutcome,
  payDelegateArgs,
  payDelegateTiming,
  verifyDelegateSignature,
  type PayDelegateRefusal,
} from '../src/near-delegate';

// NEP-366 delegates are built and signed here with near-api-js's own encoding; no network access.

// The RPC outcome fixtures are free-form JSON-RPC envelopes; tests edit them in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const REGISTRY = 'neargate-registry.testnet';
const BUYER = 'buyer.testnet';
const SERVICE = 1;
const NONCE = '4242';
const HEIGHT = 221_004_517; // block-final.json
const KEY_NONCE = 186_000_000_000_012n; // view-access-key-agent.json

const FIXTURES = new URL('./fixtures/near/', import.meta.url);

function outcome(name: string): Json {
  return (JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as Json).result;
}

const EXPECT = {
  registryId: REGISTRY,
  serviceId: SERVICE,
  nonce: NONCE,
  payer: BUYER,
  currentBlockHeight: HEIGHT,
  minGas: PAY_DELEGATE_GAS,
  maxGas: PAY_DELEGATE_GAS,
};

function newSigner(curve: 'ed25519' | 'secp256k1' = 'ed25519'): { keyPair: KeyPair; signer: KeyPairSigner } {
  const keyPair = KeyPair.fromRandom(curve);
  return { keyPair, signer: new KeyPairSigner(keyPair) };
}

/** The relayable call: pay_from_escrow(service_id, nonce), 30 TGas, nothing attached (each part overridable). */
function payCall(over: { method?: string; args?: string | Uint8Array; gas?: bigint; deposit?: bigint } = {}): Action {
  const args = over.args ?? payDelegateArgs(SERVICE, NONCE);
  return actions.functionCall(
    over.method ?? 'pay_from_escrow',
    typeof args === 'string' ? Buffer.from(args, 'utf8') : args,
    over.gas ?? PAY_DELEGATE_GAS,
    over.deposit ?? 0n,
  );
}

interface DelegateParts {
  senderId?: string;
  receiverId?: string;
  actions?: Action[];
  nonce?: bigint;
  maxBlockHeight?: bigint;
}

/** Any delegate, signed by `signer` through near-api-js: the shapes the gateway refuses are built the same way. */
async function signDelegate(signer: KeyPairSigner, over: DelegateParts = {}): Promise<string> {
  const delegateAction = buildDelegateAction({
    senderId: over.senderId ?? BUYER,
    receiverId: over.receiverId ?? REGISTRY,
    actions: over.actions ?? [payCall()],
    nonce: over.nonce ?? KEY_NONCE + 1n,
    maxBlockHeight: over.maxBlockHeight ?? BigInt(HEIGHT + 100),
    publicKey: await signer.getPublicKey(),
  });
  const { signedDelegate } = await signer.signDelegateAction(delegateAction);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
}

function bytesOf(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

describe('buildEscrowPayDelegate → decodeSignedDelegate (NEP-366, near-api-js encoding)', () => {
  it('builds one zero-deposit pay_from_escrow(service_id, nonce) to the registry with 30 TGas, signed by the key', async () => {
    const { keyPair, signer } = newSigner();
    const b64 = await buildEscrowPayDelegate(signer, {
      registryId: REGISTRY,
      senderId: BUYER,
      serviceId: SERVICE,
      nonce: NONCE,
      delegateNonce: KEY_NONCE + 1n,
      maxBlockHeight: BigInt(HEIGHT + 100),
    });

    const decoded = decodeSignedDelegate(b64);
    expect(decoded).toMatchObject({
      senderId: BUYER,
      receiverId: REGISTRY,
      nonce: KEY_NONCE + 1n,
      maxBlockHeight: BigInt(HEIGHT + 100),
      publicKey: keyPair.getPublicKey().toString(),
    });
    expect(decoded?.actions).toHaveLength(1);
    const call = decoded?.actions[0];
    expect(call).toMatchObject({ kind: 'functionCall', methodName: 'pay_from_escrow', gas: PAY_DELEGATE_GAS, deposit: 0n });
    if (call?.kind !== 'functionCall') throw new Error('expected a FunctionCall');
    expect(Buffer.from(call.args).toString('utf8')).toBe('{"service_id":1,"nonce":"4242"}');
    expect(verifyDelegateSignature(decoded!)).toBe(true);
    expect(inspectPayDelegate(b64, EXPECT)).toMatchObject({ ok: true, delegate: { senderId: BUYER } });
  });

  it('the call arguments are exactly {"service_id":<id>,"nonce":"<nonce>"}: compact JSON, this key order', () => {
    expect(payDelegateArgs(7, '42')).toBe('{"service_id":7,"nonce":"42"}');
    expect(payDelegateArgs(1, '18446744073709551615')).toBe('{"service_id":1,"nonce":"18446744073709551615"}');
  });

  it('decodes nothing it cannot read back byte for byte: not base64, garbage, a cut or a padded encoding', async () => {
    const { signer } = newSigner();
    const good = bytesOf(await signDelegate(signer));
    expect(decodeSignedDelegate(good.toString('base64'))).not.toBeNull();
    for (const bad of [
      '',
      'not base64!',
      Buffer.from('borsh SignedDelegate bytes', 'utf8').toString('base64'),
      good.subarray(0, good.length - 1).toString('base64'), // one byte short
      Buffer.concat([good, Buffer.from([0])]).toString('base64'), // a trailing byte borsh would ignore
    ]) {
      expect(decodeSignedDelegate(bad), `should refuse ${bad.slice(0, 24)}`).toBeNull();
    }
  });

  it('reads only ed25519 delegates: a secp256k1 key is malformed for NearGate', async () => {
    const { signer } = newSigner('secp256k1');
    const b64 = await signDelegate(signer);
    expect(decodeSignedDelegate(b64)).toBeNull();
    expect(inspectPayDelegate(b64, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('SIGNED_DELEGATE_MAX (R58 §3): 4096 decoded bytes, refused as malformed before borsh', () => {
  it('a 4096-byte delegate is decoded and judged; one byte more is malformed', async () => {
    expect(SIGNED_DELEGATE_MAX).toBe(4096);
    const { signer } = newSigner();
    const base = bytesOf(await signDelegate(signer, { actions: [payCall({ args: new Uint8Array(0) })] })).length;
    const sized = (total: number): Promise<string> =>
      signDelegate(signer, { actions: [payCall({ args: new Uint8Array(total - base).fill(0x20) })] });

    const atMax = await sized(SIGNED_DELEGATE_MAX);
    expect(bytesOf(atMax)).toHaveLength(4096);
    expect(inspectPayDelegate(atMax, EXPECT)).toEqual({ ok: false, reason: 'wrong_args' }); // decoded, then judged

    const over = await sized(SIGNED_DELEGATE_MAX + 1);
    expect(bytesOf(over)).toHaveLength(4097);
    expect(decodeSignedDelegate(over)).toBeNull();
    expect(inspectPayDelegate(over, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('inspectPayDelegate refuses every delegate but this invoice\'s zero-deposit pay_from_escrow', () => {
  const cases: Array<[string, DelegateParts, PayDelegateRefusal]> = [
    ['the receiver is not the registry', { receiverId: 'other-registry.testnet' }, 'wrong_receiver'],
    ['two actions', { actions: [payCall(), payCall()] }, 'wrong_action'],
    ['a Transfer, not a FunctionCall', { actions: [actions.transfer(1n)] }, 'wrong_action'],
    ['another method than pay_from_escrow', { actions: [payCall({ method: 'withdraw_escrow' })] }, 'wrong_action'],
    ['args for another invoice nonce', { actions: [payCall({ args: payDelegateArgs(SERVICE, '4243') })] }, 'wrong_args'],
    ['args for another service', { actions: [payCall({ args: payDelegateArgs(2, NONCE) })] }, 'wrong_args'],
    ['the same args in another key order', { actions: [payCall({ args: '{"nonce":"4242","service_id":1}' })] }, 'wrong_args'],
    [
      'args with a duplicate key (parsers disagree on those)',
      { actions: [payCall({ args: '{"service_id":1,"nonce":"9","nonce":"4242"}' })] },
      'wrong_args',
    ],
    ['a deposit attached (the relayer would pay it)', { actions: [payCall({ deposit: 1n })] }, 'deposit_not_zero'],
    ['more gas than the cap', { actions: [payCall({ gas: PAY_DELEGATE_GAS + 1n })] }, 'gas_too_high'],
    ['less gas than the relayer attaches', { actions: [payCall({ gas: PAY_DELEGATE_GAS - 1n })] }, 'gas_too_low'],
    ['a sender other than the payer', { senderId: 'mallory.testnet' }, 'wrong_sender'],
    ['max_block_height at the current height', { maxBlockHeight: BigInt(HEIGHT) }, 'expired'],
    ['max_block_height below the current height', { maxBlockHeight: BigInt(HEIGHT - 1) }, 'expired'],
    [
      'valid for fewer blocks than the relay needs to land',
      { maxBlockHeight: BigInt(HEIGHT + RELAY_MIN_TTL_BLOCKS - 1) },
      'expired',
    ],
    ['a nonce NEAR refuses as too large (height × 10^6 or more)', { nonce: BigInt(HEIGHT) * 1_000_000n }, 'nonce_too_large'],
  ];

  it.each(cases)('%s → %s', async (_name, parts, reason) => {
    const { signer } = newSigner();
    expect(inspectPayDelegate(await signDelegate(signer, parts), EXPECT)).toEqual({ ok: false, reason });
  });

  it('malformed: anything that is not a base64 borsh SignedDelegate', () => {
    for (const b64 of ['', 'AAAA', Buffer.from('{"kind":"delegate"}', 'utf8').toString('base64')]) {
      expect(inspectPayDelegate(b64, EXPECT)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('accepts the edges: exactly the TTL margin left, and the largest nonce NEAR takes', async () => {
    const { signer } = newSigner();
    const lastHeight = BigInt(HEIGHT + RELAY_MIN_TTL_BLOCKS);
    expect(inspectPayDelegate(await signDelegate(signer, { maxBlockHeight: lastHeight }), EXPECT)).toMatchObject({ ok: true });
    const maxNonce = BigInt(HEIGHT) * 1_000_000n - 1n;
    expect(inspectPayDelegate(await signDelegate(signer, { nonce: maxNonce }), EXPECT)).toMatchObject({ ok: true });
  });

  it('without a current height it judges the structure only; payDelegateTiming judges the timing on its own', async () => {
    const { signer } = newSigner();
    const { currentBlockHeight: _height, ...structureOnly } = EXPECT;
    const expired = await signDelegate(signer, { maxBlockHeight: BigInt(HEIGHT - 1) });
    const inspected = inspectPayDelegate(expired, structureOnly);
    expect(inspected).toMatchObject({ ok: true });
    if (!inspected.ok) throw new Error('unreachable');
    expect(payDelegateTiming(inspected.delegate, HEIGHT)).toBe('expired');
    // The structure is still judged without a height.
    expect(inspectPayDelegate(await signDelegate(signer, { senderId: 'mallory.testnet' }), structureOnly)).toEqual({
      ok: false,
      reason: 'wrong_sender',
    });

    const decode = (b64: string) => decodeSignedDelegate(b64) ?? expect.unreachable('a delegate');
    expect(payDelegateTiming(decode(await signDelegate(signer)), HEIGHT)).toBeNull();
    expect(payDelegateTiming(decode(await signDelegate(signer, { maxBlockHeight: BigInt(HEIGHT + RELAY_MIN_TTL_BLOCKS) })), HEIGHT)).toBeNull();
    expect(
      payDelegateTiming(decode(await signDelegate(signer, { maxBlockHeight: BigInt(HEIGHT + RELAY_MIN_TTL_BLOCKS - 1) })), HEIGHT),
    ).toBe('expired');
    expect(payDelegateTiming(decode(await signDelegate(signer, { nonce: BigInt(HEIGHT) * 1_000_000n })), HEIGHT)).toBe(
      'nonce_too_large',
    );
  });

  it('judges the structure only: a forged signature passes inspect, verifyDelegateSignature refuses it', async () => {
    const { signer } = newSigner();
    const bytes = bytesOf(await signDelegate(signer));
    bytes[bytes.length - 1]! ^= 0x01; // the last byte of the 64-byte ed25519 signature
    const forged = bytes.toString('base64');
    const inspected = inspectPayDelegate(forged, EXPECT);
    expect(inspected).toMatchObject({ ok: true });
    if (!inspected.ok) throw new Error('unreachable');
    expect(verifyDelegateSignature(inspected.delegate)).toBe(false);
  });
});

describe('verifyDelegateSignature (R58 §1): ed25519 over near-api-js\'s own delegate encoding', () => {
  it('true for the key\'s own signature', async () => {
    const { signer } = newSigner();
    expect(verifyDelegateSignature(decodeSignedDelegate(await signDelegate(signer))!)).toBe(true);
  });

  it('false once a signed field changes (the invoice nonce in the args)', async () => {
    const { signer } = newSigner();
    const bytes = bytesOf(await signDelegate(signer));
    const at = bytes.indexOf(Buffer.from('"4242"', 'utf8'));
    expect(at).toBeGreaterThan(0);
    bytes[at + 4] = '3'.charCodeAt(0); // "4242" → "4243"
    const tampered = decodeSignedDelegate(bytes.toString('base64'));
    expect(tampered).not.toBeNull();
    expect(verifyDelegateSignature(tampered!)).toBe(false);
  });

  it('false when another key signed a delegate naming this public key', async () => {
    const owner = KeyPair.fromRandom('ed25519');
    const thief = KeyPair.fromRandom('ed25519');
    const delegateAction = buildDelegateAction({
      senderId: BUYER,
      receiverId: REGISTRY,
      actions: [payCall()],
      nonce: KEY_NONCE + 1n,
      maxBlockHeight: BigInt(HEIGHT + 100),
      publicKey: owner.getPublicKey(),
    });
    const digest = new Uint8Array(createHash('sha256').update(encodeDelegateAction(delegateAction)).digest());
    // near-api-js exports no SignedDelegate value; borsh encodes the plain object the same way.
    const signedDelegate = {
      delegateAction,
      signature: new Signature({ keyType: KeyType.ED25519, data: thief.sign(digest).signature }),
    };
    const decoded = decodeSignedDelegate(Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64'));
    expect(decoded?.publicKey).toBe(owner.getPublicKey().toString());
    expect(verifyDelegateSignature(decoded!)).toBe(false);
  });
});

describe('judgeRelayOutcome: never trust the outer status (task-10c context, R58 §2)', () => {
  it('paid when the registry ran the inner pay_from_escrow receipt successfully', () => {
    expect(judgeRelayOutcome(outcome('tx-relay-ok.json'), REGISTRY)).toEqual({ status: 'paid' });
  });

  it('the inner pay_from_escrow receipt failing while the outer Delegate succeeds is NOT paid', () => {
    const failed = outcome('tx-relay-inner-failed.json');
    expect(failed.status).toEqual({ SuccessValue: '' }); // the outer tx looks fine
    const verdict = judgeRelayOutcome(failed, REGISTRY);
    expect(verdict.status).toBe('failed');
    if (verdict.status !== 'failed') throw new Error('unreachable');
    expect(verdict.error.code).toBe('ERR_ESCROW_INSUFFICIENT');
    expect(verdict.error.message).toMatch(/^ERR_ESCROW_INSUFFICIENT: the escrow holds/);
  });

  it('a failed delegate receipt (NEAR refused the delegate itself) is a definitive failure', () => {
    const refused = outcome('tx-relay-ok.json');
    refused.receipts_outcome[0].outcome.status = {
      Failure: { ActionError: { index: 0, kind: { DelegateActionInvalidNonce: { ak_nonce: 13, delegate_nonce: 13 } } } },
    };
    const verdict = judgeRelayOutcome(refused, REGISTRY);
    expect(verdict.status).toBe('failed');
    if (verdict.status !== 'failed') throw new Error('unreachable');
    expect(verdict.error.code).toBe('TX_FAILED');
    expect(verdict.error.message).toMatch(/DelegateActionInvalidNonce/);
  });

  it('unknown, never paid, when the outcome does not show the inner receipt or it has not run', () => {
    const missing = outcome('tx-relay-ok.json');
    missing.receipts_outcome.splice(1, 1); // the registry's receipt
    expect(judgeRelayOutcome(missing, REGISTRY)).toMatchObject({ status: 'unknown' });

    const otherRegistry = outcome('tx-relay-ok.json');
    expect(judgeRelayOutcome(otherRegistry, 'another-registry.testnet')).toMatchObject({ status: 'unknown' });

    const running = outcome('tx-relay-ok.json');
    running.receipts_outcome[1].outcome.status = 'Started';
    expect(judgeRelayOutcome(running, REGISTRY)).toMatchObject({ status: 'unknown' });

    for (const garbage of [null, 'tx', {}, { transaction_outcome: {} }]) {
      expect(judgeRelayOutcome(garbage, REGISTRY)).toMatchObject({ status: 'unknown' });
    }
  });
});
