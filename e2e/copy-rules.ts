/**
 * e2e/copy-rules.ts — the copy rules shared by the repo-wide copy guard (copy-guard.test.ts) and
 * the README checks (readme.test.ts).
 *
 * This is the one file that spells out the retired vocabulary, and names the guard files that
 * must spell it too in order to refuse it. The word guard skips it for that reason. The host
 * patterns are written with escaped dots and slashes, so no file needs a host exemption.
 */

/**
 * The vocabulary of the chain AgentGate ran on before the port (ruling R5): the chain, its token,
 * its unit, its account and deploy terms. `motes` must be a whole word, so "remotes" passes.
 */
export const RETIRED_WORDS = /casper|cspr|\bmotes\b|account-hash|deploy hash/i;

/**
 * Fetching the CLI from npm: NearGate publishes nothing there, so a package of that name on npm
 * would be someone else's. Every npx, `npm install`, `npm i` and `npm exec` form counts, whatever
 * flags come between the command and the name (`--yes`, `-g`, …). The workspace's name alone (a
 * manifest, an import, `npm run build -w`) does not.
 */
export const NPM_CLI_FETCH = /(?:\bnpx|\bnpm\s+(?:i|install|exec))\b[^\n]*@neargate\/cli/i;

/**
 * The README section that discloses the AgentGate origin (the event asks for it). It is the only
 * place the retired words may appear; it runs from this heading to the next `## ` heading.
 */
export const DISCLOSURE_HEADING = '## Built on AgentGate';

/** The full heading line of that section, which names the previous chain. */
export const DISCLOSURE_TITLE = '## Built on AgentGate (Casper)';

/**
 * Never scanned: dependency metadata and build output (never tracked; listed so a stray
 * `git add -f` cannot fail the guard).
 */
export const UNSCANNED_PREFIXES: readonly string[] = ['node_modules/', 'contracts/target/'];
export const UNSCANNED_FILES: readonly string[] = ['package-lock.json'];

/**
 * Files that spell a retired word in order to refuse it, and why each one is skipped by the word
 * guard. Each is a guard test pinning the same refusal, so its spelling is the point.
 */
export const WORD_GUARD_FILES: Readonly<Record<string, string>> = {
  'e2e/copy-rules.ts': 'this file defines the patterns',
  'dashboard/test/no-casper-copy.test.ts': "the dashboard's own copy guard spells the words it refuses",
  'e2e/deploy-config.test.ts': "the hosting files' copy guard spells the words it refuses",
};

export interface NumberedLine {
  /** 1-based line number. */
  n: number;
  line: string;
}

/**
 * The README's lines outside the disclosure section: everything before the `## Built on
 * AgentGate` heading, and everything from the next `## ` heading on. A README without the
 * heading has no exempt lines.
 */
export function linesOutsideDisclosure(readme: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  let inside = false;
  readme.split('\n').forEach((line, i) => {
    if (line.startsWith(DISCLOSURE_HEADING)) inside = true;
    else if (inside && line.startsWith('## ')) inside = false;
    if (!inside) out.push({ n: i + 1, line });
  });
  return out;
}

/** The disclosure section itself, heading included ('' when the README has none). */
export function disclosureSection(readme: string): string {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.startsWith(DISCLOSURE_HEADING));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : start + 1 + end).join('\n');
}
