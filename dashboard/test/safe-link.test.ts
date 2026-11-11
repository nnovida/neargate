import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeLink } from '@/components/safe-link';
import { ENDPOINT_PLACEHOLDER, httpUrl, shellUrl } from '@/lib/links';

/**
 * R35: the registry stores gateway_base_url as arbitrary bytes, so a seller can register
 * `javascript:…` as an endpoint. The dashboard links a URL only when its scheme is http or https.
 */
describe('R35 httpUrl', () => {
  it('passes http and https URLs through', () => {
    expect(httpUrl('https://gateway.example.org/svc/1')).toBe('https://gateway.example.org/svc/1');
    expect(httpUrl('http://localhost:4021/svc/1')).toBe('http://localhost:4021/svc/1');
  });

  it('is case-insensitive about the scheme', () => {
    expect(httpUrl('HTTPS://gateway.example.org/svc/1')).not.toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://gateway.example.org/svc/1',
    'file:///etc/passwd',
    'blob:https://x.example/uuid',
    '//gateway.example.org/svc/1',
    '/svc/1',
    'gateway.example.org/svc/1',
    ' javascript:alert(1)',
    '',
    'not a url',
  ])('refuses %j', (raw) => {
    expect(httpUrl(raw)).toBeNull();
  });
});

describe('R35 SafeLink', () => {
  const html = (href: string): string =>
    renderToStaticMarkup(createElement(SafeLink, { href, className: 'x', children: href }));

  it('renders an external anchor for an https endpoint', () => {
    const out = html('https://gateway.example.org/svc/1');
    expect(out).toContain('<a ');
    expect(out).toContain('href="https://gateway.example.org/svc/1"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('renders plain text, never an anchor, for any other scheme', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://h/x', 'relative/path']) {
      const out = html(bad);
      expect(out).not.toContain('<a');
      expect(out).not.toContain('href');
      expect(out).toContain('<span');
    }
  });
});

describe('R35 shellUrl (the endpoint inside the "try it" curl snippet)', () => {
  it('quotes an http(s) endpoint as a single shell word', () => {
    expect(shellUrl('https://gateway.example.org/svc/1')).toBe("'https://gateway.example.org/svc/1'");
    expect(shellUrl('http://localhost:4021/svc/1')).toBe("'http://localhost:4021/svc/1'");
  });

  it('keeps a hostile endpoint inert: no quote can close the word, and substitutions stay literal', () => {
    const quoted = shellUrl("https://x.example/'; rm -rf ~ #");
    // A single quote may not survive unescaped inside the quoted word.
    expect(quoted.slice(1, -1).replace(/'\\''/g, '')).not.toContain("'");
    expect(shellUrl('https://x.example/$(id)')).toBe("'https://x.example/$(id)'");
    expect(shellUrl('https://x.example/`id`')).not.toContain('`');
  });

  it('never embeds a non-http(s) value', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://h/x', '$(id)', '; rm -rf ~', '']) {
      expect(shellUrl(bad)).toBe(ENDPOINT_PLACEHOLDER);
    }
  });
});
