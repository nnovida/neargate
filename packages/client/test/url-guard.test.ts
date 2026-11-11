import { describe, expect, it, vi } from 'vitest';

// Every name resolves to a private address here, so the DNS branch of the guard is exercised
// without network access.
vi.mock('@agentgate/shared/net-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentgate/shared/net-guard')>();
  return { ...actual, resolvedHostIsPublic: vi.fn(async () => false) };
});

import { assertFetchableUrl } from '@agentgate/client';

describe('assertFetchableUrl · a host name that resolves to a private address', () => {
  it('refuses it with FORBIDDEN_HOST, naming the URL JSON-quoted and cut to 200 characters', async () => {
    const url = `http://rebind.example/${'a'.repeat(400)}`;
    const err = await assertFetchableUrl(url, { rejectPrivateHosts: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'FORBIDDEN_HOST' });
    const message = (err as Error).message;
    expect(message).toContain(JSON.stringify(url.slice(0, 200)));
    expect(message).not.toContain('a'.repeat(250));
  });
});
