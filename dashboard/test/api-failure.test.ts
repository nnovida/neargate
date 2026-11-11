import { describe, expect, it } from 'vitest';
import { AgentGateError } from '@agentgate/shared';
import { toApiFailure } from '@/lib/server/chain';

describe('toApiFailure (chain errors → the dashboard API error shape)', () => {
  it('a bad config is a 500 config_invalid', () => {
    expect(toApiFailure(new AgentGateError('CONFIG_INVALID', 'x', 500), '/api/stats')).toEqual({
      status: 500,
      body: { error: 'config_invalid' },
    });
  });

  it('a rate-limited NEAR RPC is a 429 rate_limited (the feed then serves its cached copy)', () => {
    const err = new AgentGateError('RPC_ERROR', 'the NEAR RPC rate-limited the get_recent_activity view', 502);
    expect(toApiFailure(err, '/api/activity')).toEqual({ status: 429, body: { error: 'rate_limited' } });
  });

  it('every other chain failure is a 503 chain_unreachable', () => {
    const cases: unknown[] = [
      new AgentGateError('RPC_ERROR', 'the NEAR RPC was unreachable for the list_services view (ECONNREFUSED)', 502),
      new AgentGateError('RPC_TIMEOUT', 'the NEAR RPC did not answer the get_score view within 10 s', 504),
      new AgentGateError('NOT_DEPLOYED', 'x is not a deployed neargate-registry contract', 503),
      new Error('boom'),
      'nope',
    ];
    for (const err of cases) {
      expect(toApiFailure(err, '/api/services')).toEqual({ status: 503, body: { error: 'chain_unreachable' } });
    }
  });
});
