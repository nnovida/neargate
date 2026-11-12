/**
 * e2e/hosted-defaults.test.ts — until the team hosts NearGate, the shared defaults name no gateway
 * and no dashboard, so nothing points at a host that does not exist yet. Set both once the hosts are
 * up (packages/shared/src/config.ts) and update this test with them.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DASHBOARD_URL, DEFAULT_GATEWAY_URL } from '@agentgate/shared';

describe('the hosted defaults', () => {
  it('the shared defaults are empty until NearGate is hosted', () => {
    expect(DEFAULT_GATEWAY_URL).toBe('');
    expect(DEFAULT_DASHBOARD_URL).toBe('');
  });
});
