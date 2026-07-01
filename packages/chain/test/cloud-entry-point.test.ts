import { describe, expect, it } from 'vitest';
import { cloudEntryPoint } from '../src/live';

/** Build a CSPR.cloud deploy with the given arg keys (values wrapped in {parsed}). */
const dep = (keys: string[]): { args: Record<string, { parsed?: unknown }> } => ({
  args: Object.fromEntries(keys.map((k) => [k, { parsed: 1 }])),
});

describe('cloudEntryPoint — args-inferred when CSPR.cloud omits the entry-point name', () => {
  it('record_attestation ← payment_deploy_hash', () => {
    expect(cloudEntryPoint(dep(['payment_deploy_hash', 'service_id', 'success']))).toBe(
      'record_attestation',
    );
  });

  it('register_service ← name + price', () => {
    expect(
      cloudEntryPoint(dep(['attestor', 'description', 'gateway_base_url', 'name', 'payment_target', 'price'])),
    ).toBe('register_service');
  });

  it('set_active ← active', () => {
    expect(cloudEntryPoint(dep(['active', 'service_id']))).toBe('set_active');
  });

  it('set_attestor ← attestor without name', () => {
    expect(cloudEntryPoint(dep(['attestor', 'service_id']))).toBe('set_attestor');
  });

  it('prefers an explicit name when CSPR.cloud still provides it', () => {
    expect(cloudEntryPoint({ entry_point_name: 'record_attestation', args: {} })).toBe(
      'record_attestation',
    );
  });

  it('returns "" for an unknown/argless deploy', () => {
    expect(cloudEntryPoint(dep([]))).toBe('');
  });
});
