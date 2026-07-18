/**
 * Live end-to-end test of the OFFICIAL x402 facilitator rail (Phase 3b).
 *
 * Self-contained + isolated from the public gateway: boots an in-process
 * middleware on an ephemeral port with a TEMP upstream file, a live chain
 * client, and the real CSPR.cloud facilitator; flags service #5 as
 * facilitator-enabled (pays in the AGXUSD test token), then drives the real
 * client through the full loop:
 *   buyer signs EIP-712 -> PAYMENT-SIGNATURE -> gateway verify+settle via the
 *   facilitator -> proxy -> on-chain attestation (settle tx as the payment id).
 *
 * Prereq: buyer holds AGXUSD (funded separately). Env from `.env` (live).
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';
import { startServer } from '@agentgate/middleware';
import { createAgentGateClient } from '@agentgate/client';

const SERVICE_ID = 5;
const AGXUSD = 'f38458b4a595a03b84a924330b3e25bd136d53562c7eb0c9ab602aef2ab8f9be';

process.env.FACILITATOR_SERVICES = JSON.stringify({
  [SERVICE_ID]: {
    asset: AGXUSD,
    amount: '100000000', // 0.1 AGXUSD (9 decimals)
    token: { name: 'AgentGate X402 Test USD', version: '1', decimals: 9, symbol: 'AGXUSD' },
  },
});

const config = loadConfig(process.env);
if (config.mode !== 'live') throw new Error('run with AGENTGATE_MODE=live');
const chain = createChainClient(config);

const upstreamsFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'agx-e2e-')), 'upstreams.json');
const server = await startServer({ port: 0, config, chain, upstreamsFile });
const base = `http://127.0.0.1:${server.port}`;

try {
  // Map #5's upstream (isolated temp store — the public gateway is untouched).
  const mapRes = await fetch(`${base}/admin/services`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ serviceId: SERVICE_ID, upstreamUrl: 'https://example.com' }),
  });
  console.log('admin map:', mapRes.status);

  // Real buyer client — rejectPrivateHosts:false so it can hit the local gateway.
  const client = createAgentGateClient({
    chain,
    signer: { kind: 'pem', pemPath: process.env.BUYER_SIGNER_PEM_PATH ?? '' },
    rejectPrivateHosts: false,
    buyerKeyAlgo: 'secp256k1',
  });

  console.log(`\nbuying service #${SERVICE_ID} via the facilitator rail...`);
  const result = await client.fetchPaid(`${base}/svc/${SERVICE_ID}`);

  console.log('\n================ RESULT ================');
  console.log('status:     ', result.status);
  console.log('paid:       ', result.paid);
  console.log('settle tx:  ', result.settlement?.transaction);
  console.log('settle ok:  ', result.settlement?.success);
  console.log('payer:      ', result.settlement?.payer);
  console.log('explorer:   ', result.settlement?.transaction ? `https://testnet.cspr.live/transaction/${result.settlement.transaction}` : '(none)');
  console.log('body (head):', typeof result.body === 'string' ? result.body.slice(0, 80) : JSON.stringify(result.body).slice(0, 80));
  console.log('========================================');
  const ok = result.status === 200 && result.paid && result.settlement?.success === true;
  console.log(ok ? 'PASS ✅ full facilitator workflow settled on-chain' : 'FAIL ❌');
} finally {
  await server.close();
}
