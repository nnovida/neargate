import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { base58Encode, buildSelfMapMessage } from '@agentgate/shared';
import { verifyNearSignature } from '../src/index';

/** A fresh ed25519 key plus a signer that returns the base64 signature the gateway expects. */
function newKey() {
  const keyPair = KeyPair.fromRandom('ed25519');
  return {
    publicKey: keyPair.getPublicKey().toString(),
    sign: (message: Uint8Array): string => Buffer.from(keyPair.sign(message).signature).toString('base64'),
  };
}

const message = buildSelfMapMessage({
  network: 'near-testnet',
  serviceId: 7,
  upstreamUrl: 'https://api.example.com/gold',
  timestamp: 1_700_000_000_000,
});

describe('verifyNearSignature', () => {
  it('accepts a message signed by the matching ed25519 key', () => {
    const key = newKey();
    expect(key.publicKey).toMatch(/^ed25519:/);
    expect(verifyNearSignature(key.publicKey, message, key.sign(message))).toBe(true);
  });

  it('rejects a signature with one flipped byte', () => {
    const key = newKey();
    const sig = Buffer.from(key.sign(message), 'base64');
    for (const index of [0, 31, 63]) {
      const flipped = Buffer.from(sig);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      expect(verifyNearSignature(key.publicKey, message, flipped.toString('base64'))).toBe(false);
    }
  });

  it('rejects a message with one flipped byte', () => {
    const key = newKey();
    const sig = key.sign(message);
    const tampered = new Uint8Array(message);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(verifyNearSignature(key.publicKey, tampered, sig)).toBe(false);
  });

  it("rejects another key's signature", () => {
    const signer = newKey();
    const other = newKey();
    expect(verifyNearSignature(other.publicKey, message, signer.sign(message))).toBe(false);
  });

  it('returns false (never throws) for a malformed public key', () => {
    const key = newKey();
    const sig = key.sign(message);
    const shortKey = `ed25519:${base58Encode(new Uint8Array(31).fill(7))}`;
    for (const bad of ['', 'not a key', 'ed25519:', 'ed25519:0OIl', shortKey, key.publicKey.slice('ed25519:'.length), 'rsa:abc']) {
      expect(verifyNearSignature(bad, message, sig), JSON.stringify(bad)).toBe(false);
    }
    expect(verifyNearSignature(undefined as unknown as string, message, sig)).toBe(false);
  });

  it('returns false (never throws) for a non-base64 signature', () => {
    const key = newKey();
    for (const bad of ['', '!!!not base64!!!', 'AAAA AAAA', 'a-b_c', key.publicKey]) {
      expect(verifyNearSignature(key.publicKey, message, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(verifyNearSignature(key.publicKey, message, undefined as unknown as string)).toBe(false);
  });

  it('returns false (never throws) for a signature that is not 64 bytes', () => {
    const key = newKey();
    const sig = Buffer.from(key.sign(message), 'base64');
    for (const bad of [sig.subarray(0, 63), Buffer.concat([sig, Buffer.from([0])]), Buffer.alloc(0), Buffer.alloc(32)]) {
      expect(verifyNearSignature(key.publicKey, message, bad.toString('base64')), `${bad.length} bytes`).toBe(false);
    }
  });

  it('only accepts ed25519 keys', () => {
    const secp = KeyPair.fromRandom('secp256k1');
    const sig = Buffer.from(secp.sign(message).signature).toString('base64');
    expect(verifyNearSignature(secp.getPublicKey().toString(), message, sig)).toBe(false);
  });

  it('returns false for a message that is not bytes', () => {
    const key = newKey();
    expect(verifyNearSignature(key.publicKey, 'text' as unknown as Uint8Array, key.sign(message))).toBe(false);
  });
});
