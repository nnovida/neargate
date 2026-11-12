import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dashboard builds offline. next/font/google downloads its fonts during `next build`, so a
 * build without network access (a screening sandbox, a firewalled host) fails on it. The fonts are
 * bundled in app/fonts instead, each beside its SIL Open Font License.
 */
const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_DIR = path.join(DASHBOARD_DIR, 'app', 'fonts');
const THIS_FILE = fileURLToPath(import.meta.url);

const BUNDLED: Record<string, string> = {
  'SpaceGrotesk-Variable.woff2': 'OFL-SpaceGrotesk.txt',
  'Inter-Variable.woff2': 'OFL-Inter.txt',
  'JetBrainsMono-Variable.woff2': 'OFL-JetBrainsMono.txt',
};

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') yield* sources(full);
    } else if (/\.(ts|tsx|mjs|js|css)$/.test(entry) && full !== THIS_FILE) {
      yield full;
    }
  }
}

describe('dashboard fonts', () => {
  it('nothing under dashboard/ loads a font from Google at build time', () => {
    const offenders = [...sources(DASHBOARD_DIR)].filter((f) =>
      /next\/font\/google|fonts\.googleapis\.com/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(DASHBOARD_DIR, f))).toEqual([]);
  });

  it('each bundled font is a woff2 file and ships with its OFL license', () => {
    for (const [font, license] of Object.entries(BUNDLED)) {
      const bytes = readFileSync(path.join(FONTS_DIR, font));
      expect(bytes.subarray(0, 4).toString('latin1'), font).toBe('wOF2');
      expect(readFileSync(path.join(FONTS_DIR, license), 'utf8'), license).toContain('SIL OPEN FONT LICENSE');
    }
  });

  it('the root layout loads every bundled font through next/font/local', () => {
    const layout = readFileSync(path.join(DASHBOARD_DIR, 'app', 'layout.tsx'), 'utf8');
    expect(layout).toContain("from 'next/font/local'");
    for (const font of Object.keys(BUNDLED)) {
      expect(layout, font).toContain(`./fonts/${font}`);
      expect(existsSync(path.join(FONTS_DIR, font)), font).toBe(true);
    }
  });
});
