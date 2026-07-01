import { describe, expect, it } from 'vitest';
import { KeyAlgorithm, PrivateKey } from '../src/sdk';
import { verifyOwnerSignature } from '../src/signature';

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const MSG = new TextEncoder().encode('AgentGate/self-map/v1\ncasper-test\n1\nhttps://x\n123');

describe('verifyOwnerSignature', () => {
  for (const algo of [KeyAlgorithm.SECP256K1, KeyAlgorithm.ED25519]) {
    it(`accepts a valid algorithm-tagged signature (${String(algo)}) and derives the owner account-hash`, () => {
      const priv = PrivateKey.generate(algo);
      const sigHex = bytesToHex(priv.signAndAddAlgorithmBytes(MSG));
      const res = verifyOwnerSignature(priv.publicKey.toHex(), MSG, sigHex);
      expect(res.valid).toBe(true);
      expect(res.accountHash).toBe(priv.publicKey.accountHash().toPrefixedString());
    });
  }

  it('rejects a signature made over a different message', () => {
    const priv = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    const sigHex = bytesToHex(priv.signAndAddAlgorithmBytes(MSG));
    const res = verifyOwnerSignature(priv.publicKey.toHex(), new TextEncoder().encode('other'), sigHex);
    expect(res.valid).toBe(false);
  });

  it('rejects a tampered signature WITHOUT throwing', () => {
    const priv = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    const sig = priv.signAndAddAlgorithmBytes(MSG);
    sig[5] = (sig[5] ?? 0) ^ 0xff;
    const res = verifyOwnerSignature(priv.publicKey.toHex(), MSG, bytesToHex(sig));
    expect(res.valid).toBe(false);
  });

  it('returns { accountHash: "", valid: false } for a malformed public key', () => {
    expect(verifyOwnerSignature('not-a-key', MSG, 'aabb')).toEqual({ accountHash: '', valid: false });
  });

  it('rejects malformed signature hex without throwing', () => {
    const priv = PrivateKey.generate(KeyAlgorithm.SECP256K1);
    const res = verifyOwnerSignature(priv.publicKey.toHex(), MSG, 'zz');
    expect(res.valid).toBe(false);
    expect(res.accountHash).toBe(priv.publicKey.accountHash().toPrefixedString());
  });
});
