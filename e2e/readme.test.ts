/**
 * e2e/readme.test.ts — the submission README and its companion drafts (Task 11).
 *
 * The README is what the event's AI screeners and the judges read first, so it is checked like
 * code:
 *   - the two-command offline path, the six lines it prints, the diff link and the disclosure;
 *   - every live value is its placeholder while the shared default is empty, and the value itself
 *     (placeholder gone) once it is set, so the testnet deploy and the hosting cannot forget the
 *     README;
 *   - the retired chain vocabulary only inside the `## Built on AgentGate` section;
 *   - every `npm run` script, relative link and #anchor it shows exists;
 *   - the X post fits one post and carries the event's tags; the demo-video script runs 90–120 s;
 *   - the LICENSE keeps both holders, and the root package is the private `neargate`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DASHBOARD_URL, DEFAULT_GATEWAY_URL, DEFAULT_REGISTRY_CONTRACT_ID } from '@agentgate/shared';
import {
  DISCLOSURE_HEADING,
  DISCLOSURE_TITLE,
  RETIRED_WORDS,
  disclosureSection,
  linesOutsideDisclosure,
} from './copy-rules';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

/** A file the checks below read, as '' when it does not exist yet (each check then fails on its own). */
function readOrEmpty(file: string): string {
  return existsSync(path.join(REPO_ROOT, file)) ? read(file) : '';
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(read(file)) as Record<string, unknown>;
}

const README = read('README.md');

/** The live values the testnet deploy (Task 7b) and the hosting (Task 9b) fill in. */
const LIVE_VALUES = [
  { constant: 'DEFAULT_REGISTRY_CONTRACT_ID', value: DEFAULT_REGISTRY_CONTRACT_ID, placeholder: '<registry-account>' },
  { constant: 'DEFAULT_GATEWAY_URL', value: DEFAULT_GATEWAY_URL, placeholder: '<gateway-host>' },
  { constant: 'DEFAULT_DASHBOARD_URL', value: DEFAULT_DASHBOARD_URL, placeholder: '<dashboard-host>' },
] as const;

const TX_PLACEHOLDERS = ['<tx-register>', '<tx-pay>', '<tx-attest>'] as const;

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
function githubSlug(heading: string): string {
  const text = heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}

/** The README's markdown lines outside fenced code blocks. */
function proseLines(text: string): string[] {
  let fenced = false;
  return text.split('\n').filter((line) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

describe('README.md: the first screen', () => {
  it('names NearGate and puts the two-command offline path near the top', () => {
    const top = README.split('\n').slice(0, 40).join('\n');
    expect(top).toMatch(/^# NearGate\b/m);
    expect(top).toContain('npm install && npm run demo');
  });

  it('shows the six lines `npm run demo` prints (e2e/demo.test.ts pins them)', () => {
    for (const line of [
      'registered service #1',
      '402 invoice: 0.5 NEAR + 0.002 NEAR storage',
      'paid: tx ',
      'served: 200',
      'attested: tx ',
      'score: 1/1 (new)',
    ]) {
      expect(README).toContain(line);
    }
  });

  it('states the Node floor near-api-js 7.4.0 needs', () => {
    expect(README).toContain('22.22.2');
  });
});

describe('README.md: live values (filled in by the testnet deploy and the hosting)', () => {
  for (const { constant, value, placeholder } of LIVE_VALUES) {
    it(`${constant}: the placeholder ${placeholder} while it is empty, the value (and no placeholder) once set`, () => {
      if (value === '') {
        expect(README).toContain(placeholder);
      } else {
        expect(README).toContain(value);
        expect(README).not.toContain(placeholder);
      }
    });
  }

  it('the gateway account: a placeholder until the registry is deployed (its accounts exist from then on)', () => {
    if (DEFAULT_REGISTRY_CONTRACT_ID === '') expect(README).toContain('<gateway-account>');
    else expect(README).not.toContain('<gateway-account>');
  });

  it('the register / pay / attest transactions: placeholders until a registry exists, links once it is seeded on the hosted gateway', () => {
    const present = TX_PLACEHOLDERS.filter((p) => README.includes(p));
    if (DEFAULT_REGISTRY_CONTRACT_ID === '') {
      // No transaction can exist before the registry does.
      expect(present).toEqual([...TX_PLACEHOLDERS]);
    } else if (DEFAULT_GATEWAY_URL !== '') {
      // The seed needs both: by now the triple is on chain and belongs in the README.
      expect(present).toEqual([]);
      const txLinks = README.match(/https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}/g) ?? [];
      expect(new Set(txLinks).size).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('README.md: the disclosure (Built on AgentGate)', () => {
  it('has exactly one disclosure section', () => {
    const headings = README.split('\n').filter((line) => line.startsWith(DISCLOSURE_HEADING));
    expect(headings).toEqual([DISCLOSURE_TITLE]);
  });

  it('names the baseline, the window, the diff, the libraries and the AI assistance', () => {
    const section = disclosureSection(README);
    expect(section).toContain('`pre-hackathon`');
    expect(section).toContain('8dba09a');
    expect(section).toContain('2026-07-24');
    expect(section).toContain('compare/pre-hackathon...hackathon-submission');
    for (const lib of ['near-sdk', 'near-workspaces', 'near-api-js', 'Next.js', 'Express', 'MCP', 'vitest']) {
      expect(section).toContain(lib);
    }
    expect(section).toMatch(/AI coding assistants/);
    // Ruling R59: the internal names that keep the old prefix are named, not hidden.
    expect(section).toContain('@agentgate/*');
  });

  it('links the diff and does not link the old repository (the in-repo history is the disclosure)', () => {
    expect(README).toContain('compare/pre-hackathon...hackathon-submission');
    expect(README).not.toMatch(/github\.com\/[^\s)]*agentgate/i);
  });

  it('uses the retired chain vocabulary nowhere outside that section', () => {
    const hits = linesOutsideDisclosure(README)
      .filter(({ line }) => RETIRED_WORDS.test(line))
      .map(({ n, line }) => `README.md:${n}: ${line.trim()}`);
    expect(hits).toEqual([]);
  });
});

describe('README.md: everything it points at exists', () => {
  it('has exactly one mermaid diagram', () => {
    expect(README.match(/^```mermaid$/gm) ?? []).toHaveLength(1);
  });

  it('every `npm run <script>` is a script of the root package.json', () => {
    const scripts = Object.keys((readJson('package.json')['scripts'] ?? {}) as Record<string, string>);
    const used = [...README.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((s) => !scripts.includes(s))).toEqual([]);
  });

  it('every relative link resolves to a tracked path', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0');
    const targets = [...proseLines(README).join('\n').matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1]!)
      .filter((t) => !/^(https?:|mailto:|#)/.test(t))
      .map((t) => t.replace(/#.*$/, '').replace(/\/$/, ''));
    expect(targets.length).toBeGreaterThan(3);
    const missing = targets.filter((t) => !tracked.some((f) => f === t || f.startsWith(`${t}/`)) || !existsSync(path.join(REPO_ROOT, t)));
    expect(missing).toEqual([]);
  });

  it('every #anchor link names a heading or an explicit anchor', () => {
    const prose = proseLines(README);
    const anchors = new Set<string>();
    for (const line of prose) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) anchors.add(githubSlug(heading[1]!));
      for (const m of line.matchAll(/<a id="([^"]+)"/g)) anchors.add(m[1]!);
    }
    const links = [...prose.join('\n').matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(3);
    expect(links.filter((a) => !anchors.has(a))).toEqual([]);
  });
});

describe('docs/X-POST.md', () => {
  const doc = readOrEmpty('docs/X-POST.md');
  const post = /```text\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? '';

  it('holds one post, in plain ASCII so its length is exactly what X counts', () => {
    expect(post).not.toBe('');
    expect(post).toMatch(/^[\x20-\x7E\n]+$/);
  });

  it('says it was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, and leaves REPO_URL and VIDEO to fill', () => {
    for (const s of ['Built at NEAR HACKATHON', '@NEARProtocol', '#NEARHackathon', 'REPO_URL', 'VIDEO']) {
      expect(post).toContain(s);
    }
  });

  it('fits in 280 characters once the two links are in (X counts each link as 23)', () => {
    const filled = post.replace('REPO_URL', 'x'.repeat(23)).replace('VIDEO', 'x'.repeat(23));
    expect(filled.length).toBeLessThanOrEqual(280);
  });
});

describe('docs/DEMO-VIDEO.md', () => {
  const doc = readOrEmpty('docs/DEMO-VIDEO.md');

  it('runs 90 to 120 seconds in back-to-back scenes', () => {
    const ranges = [...doc.matchAll(/\b(\d):([0-5]\d)\s*[–-]\s*(\d):([0-5]\d)\b/g)].map((m) => ({
      start: Number(m[1]) * 60 + Number(m[2]),
      end: Number(m[3]) * 60 + Number(m[4]),
    }));
    expect(ranges.length).toBeGreaterThanOrEqual(5);
    expect(ranges[0]!.start).toBe(0);
    ranges.forEach((r, i) => {
      expect(r.end).toBeGreaterThan(r.start);
      if (i > 0) expect(r.start).toBe(ranges[i - 1]!.end);
    });
    const total = ranges[ranges.length - 1]!.end;
    expect(total).toBeGreaterThanOrEqual(90);
    expect(total).toBeLessThanOrEqual(120);
  });

  it('shows the problem, a `npm run neargate -- buy`, the dashboard score ticking and the tx on nearblocks', () => {
    expect(doc).toMatch(/problem/i);
    expect(doc).toContain('npm run neargate -- buy');
    expect(doc).toMatch(/score/i);
    expect(doc).toContain('nearblocks');
  });
});

describe('LICENSE and the root package', () => {
  it('LICENSE stays MIT and adds the NearGate contributors next to the original holder', () => {
    const license = read('LICENSE');
    expect(license).toMatch(/^MIT License$/m);
    expect(license).toContain('Copyright (c) 2026 AgentGate contributors');
    expect(license).toContain('Copyright (c) 2026 NearGate contributors');
  });

  it('the root package is the private `neargate`, in package.json and in the lockfile (npm prints it in the demo)', () => {
    const pkg = readJson('package.json');
    expect(pkg['name']).toBe('neargate');
    expect(pkg['private']).toBe(true);
    const lock = readJson('package-lock.json');
    expect(lock['name']).toBe('neargate');
    const root = (lock['packages'] as Record<string, Record<string, unknown>>)[''];
    expect(root?.['name']).toBe('neargate');
  });

  it('CONTRIBUTING.md states the Node floor and the neargate script', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('22.22.2');
    expect(contributing).toContain('npm run neargate --');
  });
});
