import type { Metadata } from 'next';
import { CommandBlock } from '@/components/copy';
import {
  Callout,
  CodeBlock,
  DocHeader,
  DocLink,
  DocTable,
  H2,
  H3,
  M,
  NextLinks,
  P,
} from '@/components/docs';

export const metadata: Metadata = {
  title: 'Docs — Contract',
  description:
    'AgentGateRegistry smart-contract reference: entrypoints, structs, events, error codes, storage layout, id and attestation semantics, build/test commands and deploy status.',
};

export default function ContractPage() {
  return (
    <>
      <DocHeader
        kicker="docs / contract"
        title="AgentGateRegistry"
        lede="The on-chain heart of AgentGate: a Rust/Odra contract holding the service registry, per-service scores and the attestation history. Source: contracts/agentgate-registry/src/registry.rs."
      />

      <H2 id="entrypoints">Entrypoints</H2>
      <DocTable
        head={['Entrypoint', 'Auth', 'Reverts']}
        rows={[
          [
            <span key="s">
              <M>register_service(name, description, gateway_base_url, price, payment_target,
              attestor) → u64</M>
            </span>,
            'anyone (caller becomes owner)',
            <span key="r">
              <M>EmptyName</M> (6) if name empty/whitespace · <M>InvalidPrice</M> (5) if price
              &lt; 1000 motes
            </span>,
          ],
          [
            <span key="s">
              <M>record_attestation(service_id, payment_deploy_hash, success)</M>
            </span>,
            'attestor or owner',
            <span key="r">
              <M>ServiceNotFound</M> (2) · <M>NotAuthorized</M> (1) · <M>ServiceInactive</M> (3)
              · <M>DuplicateAttestation</M> (4) if the deploy hash was already attested for
              this service
            </span>,
          ],
          [
            <span key="s">
              <M>set_active(service_id, active)</M>
            </span>,
            'owner only — the attestor explicitly cannot toggle',
            <span key="r">
              <M>ServiceNotFound</M> (2) · <M>NotAuthorized</M> (1)
            </span>,
          ],
          [
            <span key="s">
              <M>get_service(service_id) → Option&lt;Service&gt;</M>
            </span>,
            'read',
            'never — None for unknown ids',
          ],
          [
            <span key="s">
              <M>get_score(service_id) → (u64, u64)</M>
            </span>,
            'read',
            'never — (0, 0) for unknown ids; counters keep full history beyond the attestation cap',
          ],
          [
            <span key="s">
              <M>services_count() → u64</M>
            </span>,
            'read',
            'never — equals the id of the most recently registered service (0 if none)',
          ],
          [
            <span key="s">
              <M>get_attestations(service_id) → Vec&lt;Attestation&gt;</M>
            </span>,
            'read',
            'never — last (up to) 100 entries, newest first; empty for unknown ids',
          ],
        ]}
      />
      <P>
        <M>register_service</M> increments <M>services_count</M> first and assigns that value
        as the id (1-based allocation), stores the record with the caller as owner and{' '}
        <M>active=true</M>, and emits <M>ServiceRegistered</M>.
      </P>

      <H2 id="structs">Structs</H2>
      <H3 id="service-struct">Service</H3>
      <DocTable
        head={['Field', 'Type', 'Meaning']}
        rows={[
          [<M key="f">name</M>, <M key="t">String</M>, 'Human-readable, non-empty (enforced at registration).'],
          [<M key="f">description</M>, <M key="t">String</M>, 'Short description for catalog listings.'],
          [
            <M key="f">gateway_base_url</M>,
            <M key="t">String</M>,
            <span key="d">
              Gateway base URL stored as-is; readers compute the public endpoint as{' '}
              <M>{'{gateway_base_url}/svc/{id}'}</M> — the full path is never stored.
            </span>,
          ],
          [<M key="f">price</M>, <M key="t">U512</M>, 'Per-call price in motes (≥ 1000).'],
          [
            <M key="f">payment_target</M>,
            <M key="t">Address</M>,
            'Account receiving 402 payments (the x402 payTo).',
          ],
          [
            <M key="f">owner</M>,
            <M key="t">Address</M>,
            'Caller at registration; may toggle active and record attestations.',
          ],
          [
            <M key="f">attestor</M>,
            <M key="t">Address</M>,
            'Key allowed to record attestations (the middleware signer).',
          ],
          [
            <M key="f">active</M>,
            <M key="t">bool</M>,
            'Discovery flag; true at registration. Inactive services reject attestations and are filtered by buyers.',
          ],
          [<M key="f">created_at</M>, <M key="t">u64</M>, 'Block time (ms) at registration.'],
        ]}
      />
      <H3 id="attestation-struct">Attestation</H3>
      <DocTable
        head={['Field', 'Type', 'Meaning']}
        rows={[
          [
            <M key="f">payment_deploy_hash</M>,
            <M key="t">String</M>,
            'Deploy hash of the CSPR payment transfer this attestation settles.',
          ],
          [
            <M key="f">success</M>,
            <M key="t">bool</M>,
            'Whether the upstream call was served successfully.',
          ],
          [<M key="f">timestamp</M>, <M key="t">u64</M>, 'Block time (ms) when recorded.'],
        ]}
      />

      <H2 id="events">Events</H2>
      <DocTable
        head={['Event', 'Fields', 'Emitted on']}
        rows={[
          [
            <M key="e">ServiceRegistered</M>,
            'service_id (== services_count after the call), owner, name, price, payment_target, attestor',
            <M key="o">register_service</M>,
          ],
          [
            <M key="e">AttestationRecorded</M>,
            'service_id, payment_deploy_hash, success, total_calls (after), success_calls (after)',
            <M key="o">record_attestation</M>,
          ],
          [
            <M key="e">ServiceStatusChanged</M>,
            'service_id, active (new value)',
            <M key="o">set_active</M>,
          ],
        ]}
      />

      <H2 id="errors">Error codes</H2>
      <DocTable
        head={['Code', 'Error', 'Trigger']}
        rows={[
          [<M key="c">1</M>, <M key="e">NotAuthorized</M>, 'Caller is neither attestor nor owner (attestations), or not the owner (set_active).'],
          [<M key="c">2</M>, <M key="e">ServiceNotFound</M>, 'Unknown service_id.'],
          [<M key="c">3</M>, <M key="e">ServiceInactive</M>, 'Attestation against a service with active=false.'],
          [<M key="c">4</M>, <M key="e">DuplicateAttestation</M>, 'payment_deploy_hash already attested for this service (seen_payments guard).'],
          [<M key="c">5</M>, <M key="e">InvalidPrice</M>, 'price < 1000 motes at registration.'],
          [<M key="c">6</M>, <M key="e">EmptyName</M>, 'name empty or whitespace-only at registration.'],
        ]}
      />

      <H2 id="constants">Constants &amp; storage layout</H2>
      <DocTable
        head={['Constant', 'Value', 'Purpose']}
        rows={[
          [
            <M key="c">MIN_PRICE_MOTES</M>,
            <M key="v">1000</M>,
            'Minimum service price (1e-6 CSPR) — keeps dust out.',
          ],
          [
            <M key="c">MAX_ATTESTATIONS</M>,
            <M key="v">100</M>,
            'Cap on the stored attestation list per service (oldest dropped); score counters keep full history.',
          ],
        ]}
      />
      <DocTable
        head={['Storage', 'Type', 'Holds']}
        rows={[
          [<M key="s">services_count</M>, <M key="t">Var&lt;u64&gt;</M>, 'Counter (0 initially); equals the latest service id.'],
          [<M key="s">services</M>, <M key="t">Mapping&lt;u64, Service&gt;</M>, 'service_id → record.'],
          [<M key="s">scores</M>, <M key="t">Mapping&lt;u64, (u64, u64)&gt;</M>, 'service_id → (total_calls, success_calls).'],
          [
            <M key="s">seen_payments</M>,
            <M key="t">Mapping&lt;(u64, String), bool&gt;</M>,
            '(service_id, payment_deploy_hash) → attested? — the duplicate guard.',
          ],
          [
            <M key="s">attestations</M>,
            <M key="t">Mapping&lt;u64, Vec&lt;Attestation&gt;&gt;</M>,
            'service_id → last MAX_ATTESTATIONS entries, newest first.',
          ],
        ]}
      />

      <H2 id="semantics">Semantics worth knowing</H2>
      <DocTable
        head={['Behavior', 'Detail']}
        rows={[
          [
            'Service ids are 1-based',
            <span key="d">
              Ids run <M>1..=services_count</M>; id 0 is reserved for “absent” by all off-chain
              readers. The counter is bumped first, then assigned, so it always equals the
              latest id.
            </span>,
          ],
          [
            'Attestations are newest-first',
            <span key="d">
              New entries are prepended (<M>insert(0, …)</M>) and the list is truncated to 100 —
              matching the SPEC, the devnet and this dashboard.
            </span>,
          ],
          [
            'Score counters saturate',
            <span key="d">
              <M>saturating_add</M> on both counters caps at <M>u64::MAX</M> instead of
              wrapping — a hot service can never brick its own score.
            </span>,
          ],
          [
            'One attestation per payment',
            <span key="d">
              The <M>seen_payments</M> guard makes (service_id, payment_deploy_hash) unique;
              the same hash is fine on a different service.
            </span>,
          ],
          [
            'Inactive ⇒ frozen',
            'Inactive services reject attestations until reactivated; the score is preserved across toggles.',
          ],
        ]}
      />

      <H2 id="build-test">Testing &amp; building the wasm</H2>
      <CommandBlock text="cd contracts/agentgate-registry && cargo odra test" />
      <P>
        Runs the 17 OdraVM tests: registration happy path and sequential ids, empty-name and
        below-minimum-price reverts (with the exact 1000-mote boundary accepted), read defaults
        for unknown ids, attestation auth (owner and attestor pass, strangers revert), the
        duplicate guard, the inactive flag, score math, the 100-entry cap with counters keeping
        a 105+ history, <M>set_active</M> auth, and event emission for all three events.
      </P>
      <CommandBlock text="cd contracts/agentgate-registry && cargo odra build" />
      <P>
        Writes <M>wasm/AgentGateRegistry.wasm</M> (~288 KiB after wasm-opt 123 + wasm-strip).
        Toolchain: pinned <M>nightly-2026-01-01</M> via <M>rust-toolchain.toml</M>{' '}
        (auto-selects the <M>wasm32-unknown-unknown</M> target); requires{' '}
        <M>cargo-odra --locked</M> (verified 0.1.7), wabt (<M>wasm-strip</M>) and binaryen ≥
        121 (<M>wasm-opt</M> with <M>--llvm-memory-copy-fill-lowering</M> support).{' '}
        <M>cargo odra schema</M> writes{' '}
        <M>resources/casper_contract_schemas/agent_gate_registry_schema.json</M>.
      </P>

      <H2 id="deploy-status">Deploy status: pending</H2>
      <Callout tone="warn" title="not deployed yet — by design">
        Testnet deployment is documented but intentionally not executed in this build. Until{' '}
        <M>REGISTRY_CONTRACT_PACKAGE_HASH</M> is set, the live chain client throws{' '}
        <M>AgentGateError(&apos;NOT_DEPLOYED&apos;, …, 503)</M> from every registry path. Mock
        mode is unaffected — the devnet mirrors the contract rules exactly.
      </Callout>
      <DocTable
        head={['NOT_DEPLOYED-gated paths', 'Works without the contract']}
        rows={[
          [
            <span key="g">
              <M>getService</M> · <M>listServices</M> · <M>getScore</M> ·{' '}
              <M>listAttestations</M> · <M>listRecentActivity</M> · <M>registerService</M> ·{' '}
              <M>recordAttestation</M> · <M>setActive</M>
            </span>,
            <span key="w">
              <M>transfer</M> · <M>verifyTransfer</M> · <M>getBalance</M> (native Casper RPC)
            </span>,
          ],
        ]}
      />
      <P>
        The full runbook — keys and faucet, CSPR.cloud API key, <M>casper-client put-deploy</M>{' '}
        vs the Odra deploy bin, recording the package hash, and the
        verify-against-deployed-contract checklist — lives in <M>docs/DEPLOY.md</M> in the
        repo. The root <M>README.md</M> keeps the “Deployed addresses (Casper Testnet)”
        placeholder table (package hash, example register/payment/attestation txs) to be filled
        in after the first deploy.
      </P>
      <H3 id="gas">Gas constants (live client)</H3>
      <DocTable
        head={['Operation', 'Constant', 'Motes']}
        rows={[
          [
            'Native transfer',
            <M key="c">GAS_NATIVE_TRANSFER_MOTES</M>,
            <M key="v">100,000,000</M>,
          ],
          [
            'register_service',
            <M key="c">GAS_REGISTER_SERVICE_MOTES</M>,
            <M key="v">5,000,000,000</M>,
          ],
          [
            'record_attestation',
            <M key="c">GAS_RECORD_ATTESTATION_MOTES</M>,
            <M key="v">2,500,000,000</M>,
          ],
          ['set_active', <M key="c">GAS_SET_ACTIVE_MOTES</M>, <M key="v">1,500,000,000</M>],
        ]}
      />
      <P>
        These are deliberately generous estimates marked “verify against deployed contract” in{' '}
        <M>packages/chain/src/live.ts</M> — actual costs get measured and recorded after the
        first deploy.
      </P>

      <NextLinks
        links={[
          { href: '/docs/protocol', label: 'Protocol reference' },
          { href: '/docs/configuration', label: 'Configuration' },
          { href: '/docs', label: 'Docs overview' },
        ]}
      />
    </>
  );
}
