/**
 * e2e/hosted-defaults.test.ts — the shared defaults name the hosted gateway and dashboard (Railway,
 * deploy/README.md), both or neither. The registry stores a service's gateway URL for good, so a
 * change here must be deliberate: update this test with the new hosts.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DASHBOARD_URL, DEFAULT_GATEWAY_URL } from '@agentgate/shared';

describe('the hosted defaults', () => {
  it('name the hosted gateway and dashboard', () => {
    expect(DEFAULT_GATEWAY_URL).toBe('https://neargate-gateway-production.up.railway.app');
    expect(DEFAULT_DASHBOARD_URL).toBe('https://neargate-dashboard-production.up.railway.app');
  });
});
