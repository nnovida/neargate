import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '@agentgate/shared';

/** Default JSONL decision-trace location (relative to cwd, i.e. the repo root). */
export const DEFAULT_DECISIONS_LOG = 'logs/decisions.jsonl';

export type PrintFn = (text: string) => void;

/**
 * Appends one structured decision per line to logs/decisions.jsonl (SPEC §8).
 * Failures to write never crash the agent run — they degrade to a logger warning.
 */
export class DecisionLog {
  private readonly path: string;
  private readonly logger: Logger | undefined;
  private dirReady = false;

  constructor(path: string = DEFAULT_DECISIONS_LOG, logger?: Logger) {
    this.path = path;
    this.logger = logger;
  }

  append(step: string, fields: Record<string, unknown> = {}): void {
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), step, ...fields });
      appendFileSync(this.path, `${line}\n`, 'utf8');
    } catch (err) {
      this.logger?.warn('failed to append decision log', {
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// --- Pretty console blocks (plain ANSI, chalk-free) -------------------------

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const BLOCK_WIDTH = 72;

/**
 * Renders a bordered console block:
 * ┌─ TITLE ────────────────
 * │ line
 * └────────────────────────
 */
export function renderBlock(title: string, lines: string[]): string {
  const head = `┌─ ${title} `;
  const pad = Math.max(0, BLOCK_WIDTH - head.length);
  const out: string[] = [];
  out.push(`${CYAN}┌─ ${BOLD}${title}${RESET}${CYAN} ${'─'.repeat(pad)}${RESET}`);
  for (const line of lines) {
    out.push(`${CYAN}│${RESET} ${line}`);
  }
  out.push(`${CYAN}└${'─'.repeat(BLOCK_WIDTH)}${RESET}`);
  return out.join('\n');
}

/** Left-pads/pads table cells without ANSI codes so widths line up. */
export function padCell(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}
