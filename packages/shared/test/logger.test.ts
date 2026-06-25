import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';

function captureLine(fn: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines[0] ?? '{}');
}

describe('createLogger — secret redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts sensitive field keys (case-insensitive substring match)', () => {
    const log = createLogger('test', { LOG_LEVEL: 'info' });
    const line = captureLine(() =>
      log.info('boot', {
        adminToken: 'super-secret-admin-token-value',
        csprCloudApiKey: 'abcd-1234-secret-key',
        Authorization: 'Bearer xyz',
        privateKey: 'deadbeef'.repeat(8),
        port: 4021,
        name: 'svc',
      }),
    );
    expect(String(line.adminToken)).toContain('[redacted');
    expect(String(line.adminToken)).not.toContain('super-secret');
    expect(String(line.csprCloudApiKey)).toContain('[redacted');
    expect(String(line.Authorization)).toContain('[redacted');
    expect(String(line.privateKey)).toContain('[redacted');
    // Non-sensitive fields pass through untouched.
    expect(line.port).toBe(4021);
  });

  it('redacts sensitive keys nested in objects/arrays', () => {
    const log = createLogger('test', { LOG_LEVEL: 'info' });
    const line = captureLine(() =>
      log.info('nested', { config: { secret: 'top-secret-value-here', mode: 'live' } }),
    );
    const config = line.config as Record<string, unknown>;
    expect(String(config.secret)).toContain('[redacted');
    expect(config.mode).toBe('live');
  });

  it('does not throw on circular structures', () => {
    const log = createLogger('test', { LOG_LEVEL: 'info' });
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => captureLine(() => log.info('circular', { circular }))).not.toThrow();
  });
});
