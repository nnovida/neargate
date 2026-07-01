import { describe, expect, it } from 'vitest';
import { buildSelfMapMessage, SELF_MAP_WINDOW_MS } from '../src/index';

const BASE = { network: 'casper-test', serviceId: 1, upstreamUrl: 'https://api.example.com/x', timestamp: 123 };
const decode = (o: Parameters<typeof buildSelfMapMessage>[0]) =>
  new TextDecoder().decode(buildSelfMapMessage(o));

describe('buildSelfMapMessage', () => {
  it('produces the exact domain-separated byte layout', () => {
    expect(decode(BASE)).toBe(
      'AgentGate/self-map/v1\ncasper-test\n1\nhttps://api.example.com/x\n123',
    );
  });

  it('is deterministic for identical input', () => {
    expect(decode(BASE)).toBe(decode({ ...BASE }));
  });

  it('changes when any signed field changes', () => {
    expect(decode(BASE)).not.toBe(decode({ ...BASE, serviceId: 2 }));
    expect(decode(BASE)).not.toBe(decode({ ...BASE, network: 'casper' }));
    expect(decode(BASE)).not.toBe(decode({ ...BASE, upstreamUrl: 'https://api.example.com/y' }));
    expect(decode(BASE)).not.toBe(decode({ ...BASE, timestamp: 124 }));
  });

  it('freshness window is 2 minutes', () => {
    expect(SELF_MAP_WINDOW_MS).toBe(120_000);
  });
});
