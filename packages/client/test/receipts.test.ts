import { describe, expect, it, vi } from 'vitest';
import { AgentGateError, type GatewayReceipt } from '@agentgate/shared';
import { MAX_GATEWAY_BODY_BYTES, fetchReceipt, readCappedText, receiptUrl, waitForReceipt } from '@agentgate/client';

const PAYMENT_TX = 'D'.repeat(44);
const ATTEST_TX = 'E'.repeat(44);
const NONCE = '424242';
const ENDPOINT = 'http://gateway.test/svc/7';

function receipt(status: GatewayReceipt['attestation']['status'], txHash?: string): GatewayReceipt {
  return {
    nonce: NONCE,
    serviceId: 7,
    paymentTxHash: PAYMENT_TX,
    attestation: { status, ...(txHash !== undefined ? { txHash } : {}) },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetchImpl answering queued responses in order and recording the URLs asked. */
function queued(responses: Array<Response | Error>) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    urls.push(String(input));
    const next = responses.shift();
    if (next === undefined) throw new Error('queued fetch: nothing left');
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const LOCAL = { rejectPrivateHosts: false } as const;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return err instanceof AgentGateError ? err.code : `non-agentgate: ${String(err)}`;
  }
  return undefined;
}

describe('receiptUrl', () => {
  it('turns the service endpoint into the gateway receipts URL', () => {
    expect(receiptUrl(ENDPOINT, NONCE)).toBe('http://gateway.test/receipts/424242');
    expect(receiptUrl('https://gw.example.com/prefix/svc/12', NONCE)).toBe(
      'https://gw.example.com/prefix/receipts/424242',
    );
    expect(receiptUrl('https://gw.example.com/svc/3/', NONCE)).toBe('https://gw.example.com/receipts/424242');
  });

  it('refuses an endpoint that is not <gateway>/svc/<id>, and a nonce that is not a nonce', () => {
    expect(() => receiptUrl('https://gw.example.com/other', NONCE)).toThrow(/svc/);
    expect(() => receiptUrl('https://gw.example.com/svc/abc', NONCE)).toThrow(/svc/);
    expect(() => receiptUrl(ENDPOINT, '12ab')).toThrow(/nonce/);
  });
});

describe('fetchReceipt', () => {
  it('GETs <gateway>/receipts/<nonce> and returns the parsed receipt', async () => {
    const { impl, urls } = queued([json(receipt('recorded', ATTEST_TX))]);
    const got = await fetchReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL });
    expect(urls).toEqual(['http://gateway.test/receipts/424242']);
    expect(got).toEqual(receipt('recorded', ATTEST_TX));
  });

  it('answers null for a nonce the gateway does not know (404)', async () => {
    const { impl } = queued([json({ error: 'receipt_not_found' }, 404)]);
    expect(await fetchReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL })).toBeNull();
  });

  it('refuses a body that is not a receipt for this nonce (BAD_RECEIPT)', async () => {
    const wrongNonce = queued([json({ ...receipt('pending'), nonce: '999' })]);
    expect(await codeOf(fetchReceipt(ENDPOINT, NONCE, { fetchImpl: wrongNonce.impl, ...LOCAL }))).toBe('BAD_RECEIPT');
    const garbage = queued([json({ hello: 'world' })]);
    expect(await codeOf(fetchReceipt(ENDPOINT, NONCE, { fetchImpl: garbage.impl, ...LOCAL }))).toBe('BAD_RECEIPT');
    const notJson = queued([new Response('<html>', { status: 200 })]);
    expect(await codeOf(fetchReceipt(ENDPOINT, NONCE, { fetchImpl: notJson.impl, ...LOCAL }))).toBe('BAD_RECEIPT');
  });

  it('names any other HTTP status (RECEIPT_UNAVAILABLE)', async () => {
    const { impl } = queued([json({ error: 'rate_limited' }, 429)]);
    expect(await codeOf(fetchReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL }))).toBe('RECEIPT_UNAVAILABLE');
  });

  it('never follows a redirect (REDIRECT_REFUSED)', async () => {
    const { impl } = queued([new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } })]);
    expect(await codeOf(fetchReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL }))).toBe('REDIRECT_REFUSED');
  });

  it('keeps the private-host guard on unless told otherwise (FORBIDDEN_HOST, nothing fetched)', async () => {
    const { impl, urls } = queued([json(receipt('pending'))]);
    expect(await codeOf(fetchReceipt('http://127.0.0.1:4021/svc/7', NONCE, { fetchImpl: impl }))).toBe(
      'FORBIDDEN_HOST',
    );
    expect(urls).toEqual([]);
  });

  it('asks with redirect: manual', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const impl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(init);
      return json(receipt('pending'));
    }) as unknown as typeof fetch;
    await fetchReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL });
    expect(seen[0]?.redirect).toBe('manual');
  });
});

/** A 200 whose body is an endless stream of 16 KiB chunks; `pulled()` says how many were asked for. */
function endlessBody(): { response: Response; pulled: () => number } {
  let pulls = 0;
  const chunk = new Uint8Array(16 * 1024).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
      if (pulls >= 10_000) controller.close();
    },
  });
  return { response: new Response(stream, { status: 200 }), pulled: () => pulls };
}

describe('readCappedText', () => {
  it('reads a body within the cap whole, multi-byte characters included', async () => {
    expect(await readCappedText(new Response('{"é":"✓"}'))).toBe('{"é":"✓"}');
    expect(await readCappedText(new Response(null, { status: 204 }))).toBe('');
  });

  it('refuses a body over the cap and stops reading it (BODY_TOO_LARGE)', async () => {
    const { response, pulled } = endlessBody();
    expect(await codeOf(readCappedText(response))).toBe('BODY_TOO_LARGE');
    // 64 KiB of 16 KiB chunks, plus what the stream queues ahead: nowhere near the 160 MB on offer.
    expect(pulled()).toBeLessThan(40);
    expect(MAX_GATEWAY_BODY_BYTES).toBe(64 * 1024);
  });

  it('refuses a declared content-length over the cap before reading anything', async () => {
    const response = new Response('x', { headers: { 'content-length': String(MAX_GATEWAY_BODY_BYTES + 1) } });
    expect(await codeOf(readCappedText(response))).toBe('BODY_TOO_LARGE');
  });
});

describe('fetchReceipt · oversized answers', () => {
  it('does not read an endless body (BODY_TOO_LARGE)', async () => {
    const { response, pulled } = endlessBody();
    const impl = (async () => response) as unknown as typeof fetch;
    expect(await codeOf(fetchReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL }))).toBe('BODY_TOO_LARGE');
    expect(pulled()).toBeLessThan(40);
  });

  it('waitForReceipt stops at once on it: a gateway that misbehaves is not retried', async () => {
    let asked = 0;
    const impl = (async () => {
      asked += 1;
      return endlessBody().response;
    }) as unknown as typeof fetch;
    expect(
      await codeOf(waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL, pollIntervalMs: 1, timeoutMs: 2_000 })),
    ).toBe('BODY_TOO_LARGE');
    expect(asked).toBe(1);
  });
});

describe('waitForReceipt', () => {
  const fast = { ...LOCAL, pollIntervalMs: 1, timeoutMs: 2_000 } as const;

  it('polls while the attestation is pending and returns the verdict', async () => {
    const { impl, urls } = queued([
      json(receipt('pending')),
      json(receipt('pending')),
      json(receipt('recorded', ATTEST_TX)),
    ]);
    const got = await waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...fast });
    expect(got).toEqual(receipt('recorded', ATTEST_TX));
    expect(urls).toHaveLength(3);
  });

  it('returns a final non-recorded verdict at once', async () => {
    const { impl, urls } = queued([json(receipt('skipped_self_paid'))]);
    expect((await waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...fast }))?.attestation.status).toBe(
      'skipped_self_paid',
    );
    expect(urls).toHaveLength(1);
  });

  it('gives up on an unknown nonce at once (null)', async () => {
    const { impl, urls } = queued([json({ error: 'receipt_not_found' }, 404)]);
    expect(await waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...fast })).toBeNull();
    expect(urls).toHaveLength(1);
  });

  it('on timeout returns the last receipt it saw, still pending', async () => {
    const impl = (async () => json(receipt('pending'))) as unknown as typeof fetch;
    const got = await waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL, pollIntervalMs: 5, timeoutMs: 40 });
    expect(got?.attestation.status).toBe('pending');
  });

  it('rides out a transient failure between polls', async () => {
    const { impl, urls } = queued([
      new TypeError('fetch failed'),
      json({ error: 'rate_limited' }, 429),
      json(receipt('recorded', ATTEST_TX)),
    ]);
    const got = await waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...fast });
    expect(got?.attestation.status).toBe('recorded');
    expect(urls).toHaveLength(3);
  });

  it('throws the last failure when it never got a receipt before the timeout', async () => {
    const impl = (async () => json({ error: 'down' }, 503)) as unknown as typeof fetch;
    expect(
      await codeOf(waitForReceipt(ENDPOINT, NONCE, { fetchImpl: impl, ...LOCAL, pollIntervalMs: 5, timeoutMs: 40 })),
    ).toBe('RECEIPT_UNAVAILABLE');
  });

  it('stops at once on a failure retrying cannot fix (a forbidden host, a bad receipt)', async () => {
    const forbidden = queued([]);
    expect(
      await codeOf(waitForReceipt('http://127.0.0.1:4021/svc/7', NONCE, { fetchImpl: forbidden.impl, ...fast, rejectPrivateHosts: true })),
    ).toBe('FORBIDDEN_HOST');
    const bad = queued([json({ hello: 'world' }), json(receipt('recorded', ATTEST_TX))]);
    expect(await codeOf(waitForReceipt(ENDPOINT, NONCE, { fetchImpl: bad.impl, ...fast }))).toBe('BAD_RECEIPT');
    expect(bad.urls).toHaveLength(1);
  });
});
