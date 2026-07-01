import { describe, expect, it } from 'vitest';
import { isPrivateHost, resolvePinnedIp, validateUpstreamUrl } from '../src/index';

describe('isPrivateHost', () => {
  const privateHosts = [
    'localhost',
    'LOCALHOST',
    'api.localhost',
    'localhost.',
    '127.0.0.1',
    '127.255.255.255',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.0.0.170',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '[::1]',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1', // canonical mapped 127.0.0.1
    '::ffff:c0a8:101', // canonical mapped 192.168.1.1
    '',
  ];
  it.each(privateHosts)('flags %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  const publicHosts = [
    'example.com',
    'api.example.com',
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1', // just outside 172.16/12
    '100.128.0.1', // just outside 100.64/10
    '2606:4700:4700::1111',
    '::ffff:808:808', // mapped 8.8.8.8 — public
  ];
  it.each(publicHosts)('allows %s', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe('validateUpstreamUrl', () => {
  it('accepts http/https URLs', () => {
    for (const url of ['http://example.com/a?b=1', 'https://api.example.com:8443/feed']) {
      expect(validateUpstreamUrl(url, { rejectPrivateHosts: true })).toMatchObject({ ok: true });
    }
  });

  it('rejects non-strings, oversized, unparseable, wrong-protocol and credentialed URLs', () => {
    const invalid: unknown[] = [
      42,
      null,
      undefined,
      '',
      `http://example.com/${'x'.repeat(3000)}`,
      'nope',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://user:pass@example.com/',
    ];
    for (const url of invalid) {
      expect(validateUpstreamUrl(url, { rejectPrivateHosts: false })).toEqual({
        ok: false,
        error: 'invalid_upstream_url',
      });
    }
  });

  it('rejects private hosts only when rejectPrivateHosts is set (live mode)', () => {
    expect(validateUpstreamUrl('http://127.0.0.1:4010/feed', { rejectPrivateHosts: true })).toEqual({
      ok: false,
      error: 'forbidden_upstream_host',
    });
    // WHATWG URL canonicalises decimal IPv4 spellings → caught.
    expect(validateUpstreamUrl('http://2130706433/feed', { rejectPrivateHosts: true })).toEqual({
      ok: false,
      error: 'forbidden_upstream_host',
    });
    expect(
      validateUpstreamUrl('http://127.0.0.1:4010/feed', { rejectPrivateHosts: false }),
    ).toMatchObject({ ok: true });
  });
});

describe('resolvePinnedIp — F6 DNS-rebinding pin', () => {
  it('returns null for empty and localhost hosts', async () => {
    expect(await resolvePinnedIp('')).toBeNull();
    expect(await resolvePinnedIp('localhost')).toBeNull();
    expect(await resolvePinnedIp('api.localhost')).toBeNull();
  });

  it('refuses private/loopback/link-local IP literals (no pin target)', async () => {
    expect(await resolvePinnedIp('127.0.0.1')).toBeNull();
    expect(await resolvePinnedIp('169.254.169.254')).toBeNull(); // cloud metadata
    expect(await resolvePinnedIp('10.0.0.5')).toBeNull();
    expect(await resolvePinnedIp('::1')).toBeNull();
    expect(await resolvePinnedIp('[fd00::1]')).toBeNull();
  });

  it('pins a public IP literal to itself', async () => {
    expect(await resolvePinnedIp('8.8.8.8')).toEqual({ address: '8.8.8.8', family: 4 });
    expect(await resolvePinnedIp('[2606:4700:4700::1111]')).toEqual({
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });
});
