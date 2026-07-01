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
  PropList,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/contract' },
  title: 'Smart contracts',
  description:
    'Reference for the AgentGate Odra/Rust contracts: AgentGateRegistry (service registry + attestation reputation) and SpendGuard (x402 spend-firewall escrow) — storage, entrypoints, events, error codes, and build/deploy.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Smart contracts"
        lede="The on-chain layer of AgentGate: two Rust/Odra contracts — AgentGateRegistry (live, wired into the product) and SpendGuard (implemented and unit-tested, not yet wired in)."
      />

      <H2 id="overview">Overview</H2>
      <P>
        AgentGate ships two contracts under <M>contracts/</M>, each a standalone Odra crate
        following the <M>cargo odra new --template full</M> layout (one crate, an{' '}
        <M>Odra.toml</M>, and the generated build/schema bins). Source:{' '}
        <M>contracts/agentgate-registry/src/registry.rs</M> and{' '}
        <M>contracts/spend-guard/src/spend_guard.rs</M>.
      </P>
      <DocTable
        head={['Contract', 'Role', 'Status']}
        rows={[
          [
            <M key="c">AgentGateRegistry</M>,
            'Service discovery catalog + per-service payment-attestation reputation ledger.',
            'Deployed to Casper Testnet (casper-test, Casper 2.0) and wired into the off-chain product (a live registry client). Package hash: hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9',
          ],
          [
            <M key="c">SpendGuard</M>,
            'x402 spend-firewall: per-policy CSPR escrow with on-chain budget, per-call cap, rate-window and trust-tier enforcement.',
            'Implemented and unit-tested only — NOT integrated into the running product (no off-chain client, middleware never calls debit).',
          ],
        ]}
      />
      <P>
        Both contracts share the same idioms: <M>odra::prelude::*</M> for the storage primitives,{' '}
        <M>U512</M> motes pulled from <M>odra::casper_types</M> (not the prelude), 1-based
        sequential ids (the counter is bumped first, then assigned, so it always equals the latest
        id and id <M>0</M> means &ldquo;absent&rdquo; to every off-chain reader), a{' '}
        <M>seen_*</M> dedup mapping, <M>saturating_*</M> counter math, and a private{' '}
        <M>load_*</M> helper that reverts when an id is unknown. Money is always native CSPR motes,
        never CEP-18.
      </P>

      <H2 id="registry">AgentGateRegistry</H2>
      <P>
        The registry is the catalog and the reputation source of truth. A seller calls{' '}
        <M>register_service</M> to list a wrapped HTTP API; the caller becomes the service{' '}
        <M>owner</M> and the service starts <M>active</M>. After each paid call the AgentGate
        middleware (the service&rsquo;s <M>attestor</M>) calls <M>record_attestation</M>, which
        bumps a <M>(total_calls, success_calls)</M> score and appends to a capped attestation
        history. The contract has no constructor args and no privileged admin — there is no global
        owner, only per-service owners.
      </P>
      <P>
        The full public endpoint is never stored on-chain: the contract keeps only{' '}
        <M>gateway_base_url</M>, and every reader (devnet, chain client, dashboard) computes the
        endpoint as <M>{'{gateway_base_url}/svc/{id}'}</M>.
      </P>

      <H3 id="registry-storage">Storage</H3>
      <DocTable
        head={['Field', 'Type', 'Holds']}
        rows={[
          [
            <M key="s">services_count</M>,
            <M key="t">Var&lt;u64&gt;</M>,
            'Number of services registered (0 initially); equals the id of the most recently registered service. Ids run 1..=services_count.',
          ],
          [
            <M key="s">services</M>,
            <M key="t">Mapping&lt;u64, Service&gt;</M>,
            'service_id → the stored Service record.',
          ],
          [
            <M key="s">scores</M>,
            <M key="t">Mapping&lt;u64, (u64, u64)&gt;</M>,
            'service_id → (total_calls, success_calls). Keeps the FULL history even after the attestation list is capped.',
          ],
          [
            <M key="s">seen_payments</M>,
            <M key="t">Mapping&lt;(u64, String), bool&gt;</M>,
            '(service_id, payment_deploy_hash) → attested? The per-service duplicate guard — one attestation per payment.',
          ],
          [
            <M key="s">attestations</M>,
            <M key="t">Mapping&lt;u64, Vec&lt;Attestation&gt;&gt;</M>,
            'service_id → the last MAX_ATTESTATIONS (100) attestations, newest first (oldest dropped when the cap is hit).',
          ],
        ]}
      />
      <P>
        Two module constants govern the policy: <M>MIN_PRICE_MOTES = 1000</M> (the price floor,
        1e-6 CSPR, keeps dust out of the catalog) and <M>MAX_ATTESTATIONS = 100</M> (the per-service
        attestation-list cap; the <M>scores</M> counters are unbounded and keep full history).
      </P>
      <H3 id="registry-service-struct">Service record</H3>
      <PropList
        items={[
          { name: 'name', type: 'String', desc: <>Human-readable service name; non-empty (enforced at registration).</> },
          { name: 'description', type: 'String', desc: <>Short description shown in catalog listings.</> },
          {
            name: 'gateway_base_url',
            type: 'String',
            desc: (
              <>
                Base URL of the AgentGate middleware fronting this service, stored verbatim. Readers
                compute the public endpoint as <M>{'{gateway_base_url}/svc/{id}'}</M>.
              </>
            ),
          },
          { name: 'price', type: 'U512', desc: <>Price per call in motes of native CSPR (&ge; 1000).</> },
          { name: 'payment_target', type: 'Address', desc: <>Account that receives the 402 payments (the x402 payTo).</> },
          {
            name: 'owner',
            type: 'Address',
            desc: <>The registration caller. May toggle <M>active</M>, rotate the attestor, and record attestations.</>,
          },
          { name: 'attestor', type: 'Address', desc: <>Key allowed to record attestations (the AgentGate middleware signer).</> },
          {
            name: 'active',
            type: 'bool',
            desc: <>Discovery flag; <M>true</M> at registration. Inactive services reject attestations and are filtered out by buyers.</>,
          },
          { name: 'created_at', type: 'u64', desc: <>Block time in milliseconds at registration.</> },
        ]}
      />
      <H3 id="registry-attestation-struct">Attestation record</H3>
      <PropList
        items={[
          { name: 'payment_deploy_hash', type: 'String', desc: <>Deploy hash of the CSPR payment transfer this attestation settles.</> },
          { name: 'success', type: 'bool', desc: <>Whether the upstream call was served successfully.</> },
          { name: 'timestamp', type: 'u64', desc: <>Block time in milliseconds when the attestation was recorded.</> },
        ]}
      />

      <H3 id="registry-entrypoints">Entrypoints</H3>
      <DocTable
        head={['Signature', 'Auth', 'Behavior & reverts']}
        rows={[
          [
            <M key="s">register_service(name, description, gateway_base_url, price, payment_target, attestor) → u64</M>,
            'anyone (caller becomes owner)',
            <span key="b">
              Bumps <M>services_count</M>, assigns it as the 1-based id, stores the record with{' '}
              <M>active=true</M>, emits <M>ServiceRegistered</M>, returns the id. Reverts{' '}
              <M>EmptyName</M> (6) if the name is empty/whitespace-only, <M>InvalidPrice</M> (5) if{' '}
              <M>price &lt; 1000</M> motes.
            </span>,
          ],
          [
            <M key="s">record_attestation(service_id, payment_deploy_hash, success)</M>,
            'attestor OR owner',
            <span key="b">
              Marks <M>seen_payments</M>, saturating-bumps the <M>(total, success)</M> score,
              prepends to the attestation list and truncates to 100, emits{' '}
              <M>AttestationRecorded</M> (carrying the post-update counters). Reverts{' '}
              <M>ServiceNotFound</M> (2), then <M>NotAuthorized</M> (1) for strangers,{' '}
              <M>ServiceInactive</M> (3) if paused, <M>DuplicateAttestation</M> (4) if this hash was
              already attested for this service.
            </span>,
          ],
          [
            <M key="s">set_active(service_id, active)</M>,
            'owner only',
            <span key="b">
              Toggles the <M>active</M> flag, emits <M>ServiceStatusChanged</M>. The attestor
              explicitly may NOT toggle. Reverts <M>ServiceNotFound</M> (2) for unknown ids,{' '}
              <M>NotAuthorized</M> (1) for non-owners.
            </span>,
          ],
          [
            <M key="s">set_attestor(service_id, attestor)</M>,
            'owner only',
            <span key="b">
              <strong>NEW.</strong> Rotates the authorised attestor key, emits{' '}
              <M>ServiceAttestorChanged</M>. Lets an owner replace a compromised/rotated middleware
              signer without re-registering (which would mint a new id and reset the score) and
              without disabling the service. Reverts <M>ServiceNotFound</M> (2),{' '}
              <M>NotAuthorized</M> (1) for non-owners.
            </span>,
          ],
          [
            <M key="s">get_service(service_id) → Option&lt;Service&gt;</M>,
            'read',
            'Never reverts — None for unknown ids.',
          ],
          [
            <M key="s">get_score(service_id) → (u64, u64)</M>,
            'read',
            'Never reverts — (0, 0) for unknown or never-attested ids; counters keep full history beyond the 100-entry attestation cap.',
          ],
          [
            <M key="s">get_attestations(service_id) → Vec&lt;Attestation&gt;</M>,
            'read',
            'Never reverts — the last (up to) 100 attestations, newest first; empty for unknown ids.',
          ],
          [
            <M key="s">services_count() → u64</M>,
            'read',
            'Never reverts — equals the id of the most recently registered service (0 if none).',
          ],
        ]}
      />
      <Callout tone="info" title="ATTESTATION CAP">
        <M>record_attestation</M> prepends each new entry with <M>insert(0, …)</M> then{' '}
        <M>truncate(100)</M>, so the stored list is newest-first and bounded — but the{' '}
        <M>scores</M> mapping uses <M>saturating_add</M> and keeps the full count. After 105 calls,{' '}
        <M>get_attestations</M> returns the most recent 100 while <M>get_score</M> reports all 105.
      </Callout>

      <H3 id="registry-events">Events</H3>
      <P>
        Emitted via the Casper Event Standard (through Odra). The module declares four events:
      </P>
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
          [
            <M key="e">ServiceAttestorChanged</M>,
            'service_id, attestor (the new authorised key)',
            <M key="o">set_attestor</M>,
          ],
        ]}
      />

      <H3 id="registry-errors">Errors</H3>
      <P>
        Declared with <M>#[odra::odra_error]</M> (the Odra 2.x replacement for the legacy{' '}
        <M>execution_error!</M> macro), user-error codes <M>1..=6</M>.
      </P>
      <DocTable
        head={['Code', 'Variant', 'Trigger']}
        rows={[
          [<M key="c">1</M>, <M key="e">NotAuthorized</M>, 'Caller is neither attestor nor owner (record_attestation), or not the owner (set_active / set_attestor).'],
          [<M key="c">2</M>, <M key="e">ServiceNotFound</M>, 'Unknown service_id.'],
          [<M key="c">3</M>, <M key="e">ServiceInactive</M>, 'Attestation against a service with active=false.'],
          [<M key="c">4</M>, <M key="e">DuplicateAttestation</M>, 'payment_deploy_hash already attested for this service (seen_payments guard; the guard is per-service).'],
          [<M key="c">5</M>, <M key="e">InvalidPrice</M>, 'price < 1000 motes at registration.'],
          [<M key="c">6</M>, <M key="e">EmptyName</M>, 'name empty or whitespace-only at registration.'],
        ]}
      />

      <H2 id="spendguard">SpendGuard</H2>
      <Callout tone="warn" title="NOT YET WIRED INTO THE PRODUCT">
        SpendGuard is implemented and fully unit-tested, but it is <strong>not</strong> integrated
        into the running AgentGate product. There is no off-chain <M>SpendGuardClient</M> (
        <M>packages/chain/</M> ships only the registry client), the middleware{' '}
        <strong>does not call <M>debit</M></strong> before proxying (<M>/svc/:id</M> in{' '}
        <M>packages/middleware/src/app.ts</M> has no policy hook), and{' '}
        <M>loadConfig()</M> does not read a <M>SPENDGUARD_CONTRACT_PACKAGE_HASH</M> (it is absent
        from <M>.env.example</M>). Until that wiring exists, SpendGuard must not be presented as an
        active spend-firewall — the contract is real and tested, but the live spend-control path it
        would enable is not yet built. The roadmap lives in <M>contracts/DEPLOY-DAY1.md</M> §5.
      </Callout>
      <P>
        Conceptually: an agent calls <M>open_policy</M> to mint a budget + rate + trust mandate,
        pre-funds the per-policy escrow with <M>deposit</M>, and (in the intended design) before
        serving a paid call the policy&rsquo;s <M>gate</M> calls <M>debit</M>. Every rule is
        enforced on-chain; a violation <M>revert</M>s atomically so the escrow is untouched and the
        payment never settles. On success the escrowed motes move to <M>pay_to</M> in the same
        transaction. The owner can reclaim unspent escrow with <M>withdraw</M> and flip a
        kill-switch with <M>pause</M>.
      </P>

      <H3 id="spendguard-storage">Storage</H3>
      <DocTable
        head={['Field', 'Type', 'Holds']}
        rows={[
          [
            <M key="s">policies_count</M>,
            <M key="t">Var&lt;u64&gt;</M>,
            'Number of policies opened (0 initially); equals the id of the most recent one. Ids run 1..=policies_count.',
          ],
          [<M key="s">policies</M>, <M key="t">Mapping&lt;u64, Policy&gt;</M>, 'policy_id → the Policy record.'],
          [
            <M key="s">seen_refs</M>,
            <M key="t">Mapping&lt;(u64, String), bool&gt;</M>,
            '(policy_id, payment_ref) → debited? The per-policy replay guard.',
          ],
          [
            <M key="s">call_times</M>,
            <M key="t">Mapping&lt;u64, Vec&lt;u64&gt;&gt;</M>,
            'policy_id → approved-debit timestamps inside the live rate window (pruned on each debit).',
          ],
        ]}
      />
      <P>
        The <M>Policy</M> record carries: <M>owner</M> and <M>gate</M> (only the gate may{' '}
        <M>debit</M>; only the owner may <M>pause</M> / <M>withdraw</M>), <M>budget</M> (cumulative
        spend ceiling), <M>spent</M>, <M>balance</M> (escrowed motes available), <M>per_call_cap</M>
        , <M>window_ms</M> + <M>max_calls_in_window</M> (the sliding rate limit),{' '}
        <M>min_trust_tier</M> (a <M>u8</M> 0..=255 mandate), <M>paused</M>, and{' '}
        <M>created_at</M>.
      </P>

      <H3 id="spendguard-entrypoints">Entrypoints</H3>
      <DocTable
        head={['Signature', 'Auth', 'Behavior & reverts']}
        rows={[
          [
            <M key="s">open_policy(gate, budget, per_call_cap, window_ms, max_calls_in_window, min_trust_tier) → u64</M>,
            'anyone (caller becomes owner)',
            <span key="b">
              Mints a 1-based policy with <M>spent=0</M>, <M>balance=0</M>, <M>paused=false</M>;
              emits <M>PolicyOpened</M>. Reverts <M>InvalidConfig</M> (10) if{' '}
              <M>per_call_cap == 0</M>, <M>max_calls_in_window == 0</M>, <M>budget == 0</M>, or{' '}
              <M>per_call_cap &gt; budget</M>.
            </span>,
          ],
          [
            <M key="s">deposit(policy_id)</M>,
            'anyone (payable)',
            <span key="b">
              Adds the attached CSPR (<M>attached_value</M>) to the escrow <M>balance</M>; emits{' '}
              <M>Deposited</M>. Reverts <M>PolicyNotFound</M> (1), <M>ZeroAmount</M> (4).
            </span>,
          ],
          [
            <M key="s">debit(policy_id, service_id, amount, pay_to, payment_ref, trust_tier)</M>,
            'gate only',
            <span key="b">
              The firewall. Enforces every rule, writes all state, then transfers atomically and
              emits <M>DebitApproved</M>. Revert order: <M>PolicyNotFound</M> (1) →{' '}
              <M>NotAuthorized</M> (2, caller ≠ gate) → <M>Paused</M> (3) → <M>ZeroAmount</M> (4) →{' '}
              <M>PerCallExceeded</M> (5) → <M>UntrustedService</M> (6) → <M>DuplicateRef</M> (7) →{' '}
              <M>OverBudget</M> (8, exceeds balance or pushes spent past budget) →{' '}
              <M>RateExceeded</M> (9). A blocked debit reverts and emits nothing.
            </span>,
          ],
          [
            <M key="s">withdraw(policy_id, amount)</M>,
            'owner only',
            <span key="b">
              <strong>NEW.</strong> Reclaims unspent escrow to the owner (works even while paused, so
              funds are never locked); emits <M>Withdrawn</M>. Reverts <M>PolicyNotFound</M> (1),{' '}
              <M>NotAuthorized</M> (2), <M>ZeroAmount</M> (4), <M>OverBudget</M> (8) if{' '}
              <M>amount &gt; balance</M>.
            </span>,
          ],
          [
            <M key="s">pause(policy_id, paused)</M>,
            'owner only',
            <span key="b">
              Flips the kill-switch; emits <M>PolicyPaused</M>. Reverts <M>PolicyNotFound</M> (1),{' '}
              <M>NotAuthorized</M> (2).
            </span>,
          ],
          [
            <M key="s">get_policy(policy_id) → Option&lt;Policy&gt;</M>,
            'read',
            'Never reverts — None if never opened.',
          ],
          [
            <M key="s">get_remaining(policy_id) → U512</M>,
            'read',
            'Never reverts — the escrow balance available; 0 for unknown ids.',
          ],
          [
            <M key="s">policies_count() → u64</M>,
            'read',
            'Never reverts — equals the id of the most recent policy (0 if none).',
          ],
        ]}
      />

      <H3 id="spendguard-events-errors">Events &amp; errors</H3>
      <P>
        Events: <M>PolicyOpened</M>, <M>Deposited</M>, <M>DebitApproved</M> (only on an approved
        debit — a blocked one reverts and emits nothing, so the failed deploy is itself the
        on-chain &ldquo;blocked&rdquo; signal), <M>PolicyPaused</M>, <M>Withdrawn</M>.
      </P>
      <DocTable
        head={['Code', 'Variant', 'Trigger']}
        rows={[
          [<M key="c">1</M>, <M key="e">PolicyNotFound</M>, 'Unknown policy_id.'],
          [<M key="c">2</M>, <M key="e">NotAuthorized</M>, 'debit by a non-gate, or pause/withdraw by a non-owner.'],
          [<M key="c">3</M>, <M key="e">Paused</M>, 'debit while the policy is paused.'],
          [<M key="c">4</M>, <M key="e">ZeroAmount</M>, 'deposit/debit/withdraw amount was zero.'],
          [<M key="c">5</M>, <M key="e">PerCallExceeded</M>, 'Single-call amount exceeds per_call_cap.'],
          [<M key="c">6</M>, <M key="e">UntrustedService</M>, 'Counterparty trust_tier below the policy min_trust_tier.'],
          [<M key="c">7</M>, <M key="e">DuplicateRef</M>, 'payment_ref already debited for this policy (replay guard).'],
          [<M key="c">8</M>, <M key="e">OverBudget</M>, 'Amount exceeds escrow balance, or would push spent past budget (also: withdraw amount > balance).'],
          [<M key="c">9</M>, <M key="e">RateExceeded</M>, 'Too many approved debits inside the current rate window.'],
          [<M key="c">10</M>, <M key="e">InvalidConfig</M>, 'open_policy with zero per_call_cap / max_calls_in_window / budget, or per_call_cap > budget.'],
        ]}
      />

      <H2 id="build-deploy">Build and deploy</H2>
      <P>
        Each contract is a standalone Rust workspace (not an npm workspace). All commands run from
        the contract&rsquo;s crate directory. The pinned nightly toolchain and{' '}
        <M>wasm32-unknown-unknown</M> target auto-install from <M>rust-toolchain.toml</M>{' '}
        (channel <M>nightly-2026-01-01</M>) on first invocation — nightly is mandatory.
      </P>
      <CommandBlock text="cd contracts/agentgate-registry && cargo odra test" />
      <P>
        Runs the in-process OdraVM unit suite (no WASM, no network) — 20 tests for the registry
        covering the register/get happy path, sequential ids and <M>services_count</M>,
        empty/whitespace-name and below-minimum-price reverts (incl. the exact 1000-motes
        boundary), default reads for unknown ids, attestor-or-owner auth (strangers revert), the
        per-service duplicate guard, the inactive-flag freeze and reactivation, score math, the
        100-entry cap dropping oldest entries while counters keep full history, owner-only{' '}
        <M>set_active</M> / <M>set_attestor</M> (attestor rejected), and event emission. SpendGuard
        has its own equivalent suite under <M>contracts/spend-guard/</M>.
      </P>
      <CommandBlock text="cd contracts/agentgate-registry && cargo odra build" />
      <P>
        Writes <M>wasm/AgentGateRegistry.wasm</M> (~288 KiB after cargo-odra&rsquo;s automatic{' '}
        <M>wasm-opt</M> + <M>wasm-strip</M> pass; requires <M>cargo-odra --locked</M>, wabt for{' '}
        <M>wasm-strip</M>, and binaryen &ge; 121 for <M>wasm-opt</M> with{' '}
        <M>--llvm-memory-copy-fill-lowering</M> support). <M>cargo odra schema</M> emits the
        entrypoint/type/event JSON under <M>resources/casper_contract_schemas/</M>. Any committed
        wasm in the repo is rebuilt at deploy time from source.
      </P>
      <Callout tone="info" title="DEPLOYED TO CASPER TESTNET">
        AgentGateRegistry is live on Casper Testnet (network <M>casper-test</M>, Casper 2.0). The
        full loop &mdash; <M>register_service</M> &rarr; pay (native CSPR transfer, transfer_id =
        invoice nonce) &rarr; <M>record_attestation</M> &rarr; trust-score reads (1,1) &mdash; runs
        on-chain. Real transaction links are in the repo README under &ldquo;Deployed addresses
        (Casper Testnet)&rdquo;. The deploy runbook (keys, faucet,{' '}
        <M>casper-client put-deploy</M> session args) is in <M>contracts/README.md</M> and{' '}
        <M>contracts/DEPLOY-DAY1.md</M>.
      </Callout>
      <CodeBlock
        label="root .env"
        code={'REGISTRY_CONTRACT_PACKAGE_HASH=hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9'}
      />

      <NextLinks
        links={[
          { href: '/docs/architecture', label: 'Architecture' },
          { href: '/docs/errors', label: 'Error codes' },
        ]}
      />
    </>
  );
}
