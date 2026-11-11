import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * seo.ts reads NEXT_PUBLIC_* once at module load (Next inlines them at build time), so each test
 * sets the environment first and imports the module fresh.
 */
async function seo(env: Record<string, string>): Promise<typeof import('@/lib/seo')> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', env['NEXT_PUBLIC_SITE_URL'] ?? '');
  vi.stubEnv('NEXT_PUBLIC_REPO_URL', env['NEXT_PUBLIC_REPO_URL'] ?? '');
  return import('@/lib/seo');
}

describe('SITE_URL (the origin for canonical links, the sitemap and metadataBase)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is the configured origin without a trailing slash', async () => {
    expect((await seo({ NEXT_PUBLIC_SITE_URL: 'https://dash.example/' })).SITE_URL).toBe('https://dash.example');
  });

  it('falls back to the dashboard dev origin, never to an empty string or an old host', async () => {
    const unset: Array<Record<string, string>> = [{}, { NEXT_PUBLIC_SITE_URL: '' }, { NEXT_PUBLIC_SITE_URL: '   ' }];
    for (const env of unset) {
      const { SITE_URL } = await seo(env);
      expect(SITE_URL).toBe('http://localhost:3000');
      expect(() => new URL(SITE_URL)).not.toThrow();
    }
  });
});

describe('REPO_URL (the source repository link)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is unset by default: there is no repository to link to yet', async () => {
    expect((await seo({})).REPO_URL).toBeNull();
    expect((await seo({ NEXT_PUBLIC_REPO_URL: '  ' })).REPO_URL).toBeNull();
  });

  it('is NEXT_PUBLIC_REPO_URL when that is an http(s) URL, and null for anything else', async () => {
    expect((await seo({ NEXT_PUBLIC_REPO_URL: 'https://git.example/org/neargate' })).REPO_URL).toBe(
      'https://git.example/org/neargate',
    );
    expect((await seo({ NEXT_PUBLIC_REPO_URL: 'javascript:alert(1)' })).REPO_URL).toBeNull();
    expect((await seo({ NEXT_PUBLIC_REPO_URL: 'not a url' })).REPO_URL).toBeNull();
  });
});

describe('repository links in the page chrome', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('next/navigation');
  });

  /** Renders the nav, the footer and the home page against a fresh module graph. */
  async function chrome(repoUrl: string): Promise<{ nav: string; footer: string; home: string }> {
    vi.stubEnv('NEXT_PUBLIC_REPO_URL', repoUrl);
    vi.doMock('next/navigation', () => ({ usePathname: () => '/' })); // outside the app router it is null
    const [{ Nav }, { Footer }, { default: Home }] = await Promise.all([
      import('@/components/nav'),
      import('@/components/footer'),
      import('@/app/page'),
    ]);
    return {
      nav: renderToStaticMarkup(createElement(Nav)),
      footer: renderToStaticMarkup(createElement(Footer)),
      home: renderToStaticMarkup(createElement(Home)),
    };
  }

  it('shows the GitHub links and the footer source line when NEXT_PUBLIC_REPO_URL is set', async () => {
    const { nav, footer, home } = await chrome('https://git.example/org/neargate');

    expect(nav).toContain('href="https://git.example/org/neargate"');
    expect(footer).toContain('href="https://git.example/org/neargate"');
    expect(footer).toContain('git.example/org/neargate');
    expect(home).toContain('href="https://git.example/org/neargate"');
  });

  it('hides every one of them, and links nothing to the old repository, when it is unset', async () => {
    const { nav, footer, home } = await chrome('');

    for (const html of [nav, footer, home]) {
      expect(html).not.toMatch(/github/i);
      expect(html).not.toContain('example/AgentGate');
    }
    expect(footer).toContain('MIT licensed');
  });
});
