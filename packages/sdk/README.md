# @neargate/sdk — pay x402 APIs in native NEAR

The NearGate client SDK for Node. Read the on-chain `neargate-registry` catalog, pay a gateway's **HTTP 402** invoice in native NEAR and get the response, with the same code the [`neargate` CLI](https://www.npmjs.com/package/@neargate/cli) runs. Three ways to pay:

- **deposit** (default): call the registry's `pay` with price + the 0.002 NEAR storage fee attached;
- **escrow**: `pay_from_escrow` debits a balance you prepaid, so a restricted agent key can pay;
- **gasless**: sign that `pay_from_escrow` as a NEP-366 delegate and let the gateway relay it and pay the gas.

The defaults target the live deployment on NEAR testnet: the registry `neargate-app-registry.testnet` and the gateway `https://neargate-gateway-production.up.railway.app`.

```bash
npm install @neargate/sdk
```

Node 22.22.2 or later, ESM only.

## Read the catalog (no key)

```ts
import { createNearGateChain, formatNear } from '@neargate/sdk';

// Live mode on NEAR testnet and the deployed registry. Options: mode, network, rpcUrl, registryId.
const chain = createNearGateChain();

for (const s of await chain.listServices()) {
  const score = await chain.getScore(s.id);
  console.log(s.id, s.name, formatNear(s.priceYocto), `${score.successCalls}/${score.totalCalls}`, s.endpointUrl);
}
```

## Pay for a call

```ts
import { createAgentGateClient, createNearGateChain, nearToYocto } from '@neargate/sdk';

const chain = createNearGateChain();
const client = createAgentGateClient({
  chain,
  // The key is read from ~/.near-credentials/testnet/you.testnet.json; or pass keyPath / secretKey.
  signer: { kind: 'near', accountId: 'you.testnet' },
  maxYocto: nearToYocto('0.02'), // refuse any invoice above 0.02 NEAR in total
  expectedServiceId: 1,
});

const res = await client.fetchPaid('https://neargate-gateway-production.up.railway.app/svc/1');
console.log(res.status, res.txHash, res.body);
```

`fetchPaid` requests the URL, validates the 402 invoice (network, registry, service, budget), pays it, retries with the `X-PAYMENT` proof and returns the response. Every refusal before paying throws an `AgentGateError` with a stable `code` (`BUDGET_EXCEEDED`, `NETWORK_MISMATCH`, `REGISTRY_MISMATCH`, `FORBIDDEN_HOST`, …).

**Never pay twice for one call.** If the payment went through but the gateway did not serve the call, `fetchPaid` throws `PaidNotServedError` (`PAID_NOT_SERVED`), or `GaslessNotServedError` on the gasless rail, carrying the proof to present again. Do not pay a fresh invoice for it.

### From an escrow, or gasless

```ts
const signer = { kind: 'near', accountId: 'you.testnet' } as const;
const maxYocto = nearToYocto('0.02');
// The first deposit keeps 0.002 NEAR as the escrow's storage fee.
await chain.depositEscrow(nearToYocto('1'), signer);

const escrowClient = createAgentGateClient({ chain, signer, maxYocto, payFrom: 'escrow' });
const gaslessClient = createAgentGateClient({ chain, signer, maxYocto, payFrom: 'escrow', gasless: true });
```

`chain.escrowOf(accountId)` reads the balance. A gasless call needs a gateway that offers a relayer (`extra.relayer` in its 402); the hosted gateway does.

## What is in the package

One bundled ES module with its types:

- the paying client: `createAgentGateClient`, `PaidNotServedError`, `GaslessNotServedError`, `parsePaymentRequired`, `fetchReceipt`, `waitForReceipt`;
- the chain clients: `createNearGateChain` (from options; `{ mode: 'mock' }` uses the offline devnet of the repository's `npm run dev`), `createChainClient` (from a full `loadConfig` configuration), `LiveNearClient` and `MockChainHttpClient`;
- the shared vocabulary: `loadConfig`, the hosted defaults (`DEFAULT_REGISTRY_CONTRACT_ID`, `DEFAULT_GATEWAY_URL`), NEAR amounts (`nearToYocto`, `formatNear`), the x402 types and `AgentGateError`.

The protocol, every error code and the security model are documented at <https://neargate-dashboard-production.up.railway.app/docs>. Source: <https://github.com/nnovida/neargate>.

## License

MIT
