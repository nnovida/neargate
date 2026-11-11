import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootGateway, startUpstream, type TestGateway, type TestUpstream } from './helpers';

// TODO(Task 4): NEAR-key self-map — 204 for a valid signature by the owner's
// full-access key; 403 not_service_owner / key_not_full_access; 401 for a bad
// signature or a replay to another service id; 400 stale_timestamp.
describe('self-service mapping POST /services/:id/map (disabled until the NEAR-key flow)', () => {
  let gw: TestGateway;
  let upstream: TestUpstream;

  beforeAll(async () => {
    gw = await bootGateway();
    upstream = await startUpstream();
    gw.fake.addService({ id: 1, name: 'Owned Feed', owner: 'owner.mock' });
  });

  afterAll(async () => {
    await gw.close();
    await upstream.close();
  });

  it('answers 501 self_map_pending_task4 and maps nothing', async () => {
    const res = await fetch(`${gw.baseUrl}/services/1/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamUrl: `${upstream.url}/data`, timestamp: Date.now() }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'self_map_pending_task4' });
    expect((await fetch(`${gw.baseUrl}/svc/1`)).status).toBe(503); // still unmapped
  });
});
