import type { GatewayReceipt, ReceiptAttestation } from '@agentgate/shared';

/** How many paid calls the gateway remembers; the oldest is dropped first. */
export const RECEIPT_CAP = 1000;

/**
 * Bounded in-memory record of recent paid calls, keyed by invoice nonce, behind
 * `GET /receipts/:nonce`. A contract view cannot know the tx that produced its event, and the
 * RPC has no tx-by-account index, so the attesting gateway is the only party that knows the
 * attestation tx: this is where a buyer (or the seed script) learns it.
 *
 * Process memory only. It is gone after a restart; the attestations a durable queue replays
 * on the next boot open a fresh receipt of their own.
 */
export class ReceiptStore {
  private readonly receipts = new Map<string, GatewayReceipt>();

  constructor(private readonly cap = RECEIPT_CAP) {}

  get size(): number {
    return this.receipts.size;
  }

  /** Records a paid call. Past the cap the oldest receipt goes (Map keeps insertion order). */
  open(call: { nonce: string; serviceId: number; paymentTxHash: string }, attestation: ReceiptAttestation): void {
    this.receipts.delete(call.nonce);
    this.receipts.set(call.nonce, { ...call, attestation: { ...attestation } });
    while (this.receipts.size > this.cap) {
      const oldest = this.receipts.keys().next();
      if (oldest.done) break;
      this.receipts.delete(oldest.value);
    }
  }

  /** Settles a pending receipt. A receipt that is gone or already has its verdict is left alone. */
  settle(nonce: string, attestation: ReceiptAttestation): void {
    const receipt = this.receipts.get(nonce);
    if (receipt?.attestation.status !== 'pending') return;
    receipt.attestation = { ...attestation };
  }

  /** A copy of the receipt, or undefined for a nonce the gateway never served (or has forgotten). */
  get(nonce: string): GatewayReceipt | undefined {
    const receipt = this.receipts.get(nonce);
    return receipt === undefined ? undefined : { ...receipt, attestation: { ...receipt.attestation } };
  }
}
