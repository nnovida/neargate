import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import { DOC_GROUPS, DOC_LINKS } from '@/lib/doc-links';

/**
 * R47: the docs shrank to six pages (overview, quickstart, cli, protocol, security, contract);
 * the step-by-step guide (sell & buy) came back as a seventh.
 * Every link that used to point at a deleted page (sitemap, sidebar, search, in-page links) must
 * be gone, and every remaining docs link must resolve to a real page.
 */
const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(DASHBOARD_DIR, 'app');
const KEPT = ['', 'cli', 'contract', 'guide', 'protocol', 'quickstart', 'security'];
const DELETED = [
  'api',
  'architecture',
  'buyers',
  'changelog',
  'configuration',
  'deployment',
  'errors',
  'installation',
  'sdk',
  'sellers',
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next' && entry !== 'test') yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

/** The page file behind a `/docs…` path, or null when there is none. */
function docsPageFile(href: string): string | null {
  const p = path.join(APP_DIR, href.replace(/^\//, ''), 'page.tsx');
  return existsSync(p) ? p : null;
}

describe('docs pages', () => {
  it('keeps exactly the six rewritten pages and deletes the other ten (R47)', () => {
    const onDisk = readdirSync(path.join(APP_DIR, 'docs'))
      .filter((e) => statSync(path.join(APP_DIR, 'docs', e)).isDirectory())
      .sort();
    expect(onDisk).toEqual(KEPT.filter((k) => k !== ''));
    for (const gone of DELETED) expect(existsSync(path.join(APP_DIR, 'docs', gone))).toBe(false);
  });
});

describe('docs navigation (doc-links.ts)', () => {
  it('every docs link resolves to a page, and every page is in the navigation', () => {
    for (const link of DOC_LINKS) expect(docsPageFile(link.href), link.href).not.toBeNull();
    expect(DOC_LINKS.map((l) => l.href).sort()).toEqual(
      KEPT.map((k) => (k === '' ? '/docs' : `/docs/${k}`)).sort(),
    );
  });

  it('has no duplicate hrefs and every group lists at least one page', () => {
    const hrefs = DOC_LINKS.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const g of DOC_GROUPS) expect(g.links.length).toBeGreaterThan(0);
  });

  it('search keywords never name a deleted page or a removed flag', () => {
    const keywords = DOC_LINKS.flatMap((l) => l.keywords ?? []).join(' ').toLowerCase();
    for (const gone of ['priceexceeded', 'no_signer', 'agentgate_', 'publickeyhex', 'stale_request']) {
      expect(keywords).not.toContain(gone);
    }
  });
});

describe('sitemap', () => {
  it('lists the home, catalog and activity pages plus exactly the docs pages', () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths.sort()).toEqual(
      ['/', '/catalog', '/activity', ...KEPT.map((k) => (k === '' ? '/docs' : `/docs/${k}`))].sort(),
    );
  });
});

describe('in-page links', () => {
  it('no source file links to a deleted docs page', () => {
    const dead: string[] = [];
    const docsRef = /(?<![\w.-])\/docs\/([a-z0-9-]+)/g;
    for (const file of walk(DASHBOARD_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(docsRef)) {
        const slug = m[1] ?? '';
        if (!KEPT.includes(slug)) dead.push(`${path.relative(DASHBOARD_DIR, file)}: /docs/${slug}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('every in-page #anchor a docs page links to on another docs page exists as an id there', () => {
    const missing: string[] = [];
    const ref = /(?<![\w.-])\/docs\/(cli|contract|guide|protocol|quickstart|security)#([a-z0-9-]+)/g;
    for (const file of walk(DASHBOARD_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(ref)) {
        const page = docsPageFile(`/docs/${m[1]}`);
        const anchor = m[2] ?? '';
        if (page === null || !readFileSync(page, 'utf8').includes(`id="${anchor}"`)) {
          missing.push(`${path.relative(DASHBOARD_DIR, file)} -> /docs/${m[1]}#${anchor}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
