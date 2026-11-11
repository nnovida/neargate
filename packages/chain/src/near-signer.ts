import { PublicKey, Signer, baseEncode } from 'near-api-js';
import type { Transaction } from 'near-api-js';
import type { LoadedNearSigner } from './near-keys';

/**
 * Signs one change call's transactions with a key resolved by `loadNearSigner`: it signs through
 * the loader's `sign` and never holds the secret key itself.
 *
 * It records the hash of each transaction it signs (near-api-js's own tx hash, which is what
 * gets signed) before `Account.signAndSendTransaction` sends it, so a call that times out can
 * name the tx that may still land. Once the call is given up (`close()`), it signs nothing
 * more, so no transaction goes out after the caller has its answer.
 */
export class CallSigner extends Signer {
  /** The base58 hash of the last transaction signed for this call; undefined until one is. */
  txHash: string | undefined;
  private closed = false;
  private readonly publicKey: PublicKey;

  constructor(private readonly loaded: LoadedNearSigner) {
    super();
    this.publicKey = PublicKey.fromString(loaded.publicKey);
  }

  /** The call has been answered: refuse to sign (and so to send) anything for it from now on. */
  close(): void {
    this.closed = true;
  }

  async getPublicKey(): Promise<PublicKey> {
    return this.publicKey;
  }

  override async signTransaction(transaction: Transaction): ReturnType<Signer['signTransaction']> {
    if (this.closed) throw new Error('the call was given up before this transaction was signed');
    const signed = await super.signTransaction(transaction);
    // Given up while signing: never hand the signed tx to the sender.
    if (this.closed) throw new Error('the call was given up while this transaction was being signed');
    this.txHash = baseEncode(signed.txHash);
    return signed;
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(this.loaded.sign(bytes), 'base64'));
  }
}
