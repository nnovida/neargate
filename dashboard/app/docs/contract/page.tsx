import type { Metadata } from 'next';
import { DEFAULT_REGISTRY_CONTRACT_ID } from '@agentgate/shared';
import { Callout, CodeBlock, DocHeader, DocLink, DocTable, H2, H3, M, NextLinks, P, Sub } from '@/components/docs';
import { accountHref, explorerBaseFromEnv } from '@/lib/explorer';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/contract' },
  title: 'Registry contract',
  description:
    'Reference for the neargate-registry NEAR contract (Rust, near-sdk): constants and limits, change methods including the prepaid escrow, views and their JSON shapes, NEP-297 events, every ERR_* code, and what an agent key restricted to pay_from_escrow can and cannot do.',
};

/** A field list that may wrap (unlike M, which never breaks). */
function Fields({ children }: { children: string }) {
  return <code className="break-words font-mono text-[12px] text-zinc-200">{children}</code>;
}

/** The registry's explorer page, once a default registry id is set; null until then. */
function registryLink(): string | null {
  if (DEFAULT_REGISTRY_CONTRACT_ID === '') return null;
  // Real-network explorer link: the docs describe the testnet deployment.
  return accountHref({
    network: 'near-testnet',
    explorerUrl: explorerBaseFromEnv(),
    accountId: DEFAULT_REGISTRY_CONTRACT_ID,
  });
}

export default function Page() {
  const link = registryLink();
  return (
    <>
      <DocHeader
        kicker="REFERENCE"
        title="Registry contract"
        lede="neargate-registry is the on-chain layer of NearGate: a pay-through service registry with payment-backed attestations, written in Rust on near-sdk. This page is its ABI, from contracts/registry/src."
      />

      <H2 id="overview">Overview</H2>
      <P>
        Buyers pay <em>through</em> the registry. <M>pay(service_id, nonce)</M> forwards exactly the
        service price to the seller’s <M>payment_target</M>, keeps a small storage fee, refunds the
        rest and stores a payment record. <M>record_attestation</M> is accepted only for a payment
        this contract itself received, once, and never when the payer is the service owner or the
        payment target — so a score can only come from real transfers between distinct parties (see
        the <DocLink href="/docs/security#trust-model">trust model</DocLink>, including what it does
        not prove).
      </P>
      <P>
        A buyer can also <em>prepay</em>: <M>deposit_escrow</M> puts NEAR into a per-account escrow,
        and <M>pay_from_escrow(service_id, nonce)</M> settles a payment out of it exactly like{' '}
        <M>pay</M> but attaches nothing, so a NEAR function-call access key restricted to that one
        method can sign it (see <DocLink href="#escrow">escrow and agent keys</DocLink>).
      </P>
      <P>
        The contract has <strong className="text-white">no owner and no admin</strong>. The only
        privileged roles are per service: its <M>owner</M> (the registering account: switches the
        service on and off, rotates the attestor) and its <M>attestor</M> (records outcomes; the
        owner may too). Every panic message starts with a stable <M>ERR_*</M> code, so clients map
        errors by that prefix. Source: <M>contracts/registry/src/lib.rs</M> and{' '}
        <M>types.rs</M>.
      </P>
      {link === null ? (
        <Callout tone="warn" title="NOT DEPLOYED YET">
          No default registry account is set, so the registry badge at the top of this page reads{' '}
          <M>not deployed</M>. Deploy your own with <M>npm run near:deploy</M> (see the{' '}
          <DocLink href="/docs/quickstart#testnet">quickstart</DocLink>) and point{' '}
          <M>REGISTRY_CONTRACT_ID</M> or <M>--registry</M> at it.
        </Callout>
      ) : (
        <Callout tone="ok" title="DEPLOYED">
          The default registry is{' '}
          <a href={link} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
            {DEFAULT_REGISTRY_CONTRACT_ID}
          </a>
          . Point <M>REGISTRY_CONTRACT_ID</M> or <M>--registry</M> elsewhere to use another one.
        </Callout>
      )}
      <P>
        All amounts are yoctoNEAR (1 NEAR = 10<sup>24</sup> yocto): <M>u128</M> in Rust, decimal
        strings in JSON. Service ids are 1-based.
      </P>

      <H2 id="constants">Constants and limits</H2>
      <DocTable
        head={['Constant', 'Meaning']}
        rows={[
          [
            <span key="1"><M>MIN_PRICE_YOCTO</M><Sub>10^18 yocto · 0.000001 NEAR</Sub></span>,
            'Floor for the "near" price option. Other assets are priced in their own base units: any amount above zero.',
          ],
          [
            <span key="2"><M>PAYMENT_STORAGE_FEE_YOCTO</M><Sub>2 × 10^21 yocto · 0.002 NEAR</Sub></span>,
            'Kept by the registry on every pay, to cover the payment record’s storage.',
          ],
          [
            <span key="3"><M>REGISTRATION_DEPOSIT_YOCTO</M><Sub>1.2 × 10^23 yocto · 0.12 NEAR</Sub></span>,
            'Kept on every register_service (anything above is refunded). It prepays the service record and the storage for a full attestation list.',
          ],
          [
            <span key="3b"><M>ESCROW_STORAGE_FEE_YOCTO</M><Sub>2 × 10^21 yocto · 0.002 NEAR</Sub></span>,
            'Kept from an account’s first deposit_escrow, which creates its escrow entry (the fee prepays that entry’s storage, about 125 bytes at most). The first deposit must be more than this; later deposits are credited in full.',
          ],
          [<span key="4"><M>MAX_ATTESTATIONS</M><Sub>100</Sub></span>, 'Attestations kept per service, newest first.'],
          [<span key="5"><M>ACTIVITY_CAP</M><Sub>200</Sub></span>, 'Events kept in the activity ring buffer.'],
          [<span key="6"><M>NAME_MAX</M><Sub>64 bytes</Sub></span>, 'Service name. Also the limit of accepts[].asset and accepts[].symbol.'],
          [<span key="7"><M>DESC_MAX</M><Sub>280 bytes</Sub></span>, 'Service description.'],
          [<span key="8"><M>URL_MAX</M><Sub>200 bytes</Sub></span>, 'gateway_base_url.'],
          [<span key="9"><M>ACCEPTS_MAX</M><Sub>4</Sub></span>, 'Price options per service.'],
          [<span key="10"><M>TX_HASH_MAX</M><Sub>64 bytes</Sub></span>, 'payment_tx_hash of an attestation.'],
          [<span key="11"><M>NONCE_MAX</M><Sub>20</Sub></span>, 'A nonce is 1 to 20 decimal digits.'],
          [<span key="12"><M>LIST_LIMIT_MAX</M><Sub>50</Sub></span>, 'list_services page size (larger limits are clamped).'],
        ]}
      />
      <P>
        Every length limit counts <strong>UTF-8 bytes</strong>, not characters: storage is paid per
        byte, and one character can take four.
      </P>

      <H2 id="methods">Change methods</H2>
      <H3 id="m-new">new()</H3>
      <P>
        One-time <M>#[init]</M> with no arguments, so there is nothing to front-run; it sets no
        admin. It pre-writes every activity slot with a one-byte placeholder, so a later pay replaces
        a record instead of creating one and its storage cost stays inside the fee.
      </P>
      <H3 id="m-register">register_service — payable</H3>
      <CodeBlock
        code={'register_service(name: String, description: String, gateway_base_url: String,\n                 accepts: Vec<PaymentOption>, payment_target: AccountId,\n                 attestor: AccountId) -> u64'}
      />
      <P>
        Registers a service owned by the caller and returns its id. The name is trimmed and must not
        be empty; the length limits apply; <M>accepts</M> holds 1 to 4 options, at most one with{' '}
        <M>asset: "near"</M> (the only one <M>pay</M> settles), whose amount is at least{' '}
        <M>MIN_PRICE_YOCTO</M>, every other amount above zero. Attach at least{' '}
        <M>0.12 NEAR</M>; the registry keeps that and refunds the rest. The service starts{' '}
        <M>active</M>. The call panics <M>ERR_STORAGE_EXCEEDED</M> if the registration plus the
        attestation reserve would not fit in the deposit.
      </P>
      <H3 id="m-pay">pay — payable</H3>
      <CodeBlock code="pay(service_id: u64, nonce: String)" />
      <P>
        Pays for one call. The service must exist, be active and have a <M>"near"</M> option at
        price <M>p</M>. Attach at least <M>p + 0.002 NEAR</M>. The nonce must be 1 to 20 digits and
        never seen before (single-use across the whole registry). Transfers exactly <M>p</M> to the
        payment target, keeps the fee, refunds <M>attached − p − fee</M> to the payer, and stores
        the payment with <M>self_paid = payer is the owner or the payment target</M>. The
        measured storage cost must fit inside the fee.
      </P>
      <H3 id="m-pay-escrow">pay_from_escrow — takes no deposit</H3>
      <CodeBlock code="pay_from_escrow(service_id: u64, nonce: String)" />
      <P>
        <M>pay</M>, funded by the caller’s escrow. It is marked <M>payable</M> in the ABI but rejects any
        attached deposit (<M>ERR_DEPOSIT_NOT_ALLOWED</M>, the first check). Then the checks of{' '}
        <M>pay</M>, in the same order, except that the escrow check replaces <M>pay</M>’s deposit
        check and comes before the nonce checks: the escrow must hold at least{' '}
        <M>price + 0.002 NEAR</M>. It debits exactly that from the escrow, sends the price to the payment target, keeps the fee and refunds nothing.
        The payment record, activity entry and <M>payment</M> event are the ones{' '}
        <M>pay</M> writes: the payer is the caller, so a score built on escrow payments is
        built on the same real transfers, and the same self-payment rule applies.
      </P>
      <H3 id="m-deposit-escrow">deposit_escrow — payable</H3>
      <CodeBlock code="deposit_escrow()" />
      <P>
        Credits the attached deposit to the caller’s escrow. The first deposit creates the entry:
        it must be <strong className="text-white">more than</strong>{' '}
        <M>0.002 NEAR</M>, the registry keeps that as <M>ESCROW_STORAGE_FEE_YOCTO</M> and credits
        the rest. Later deposits are credited in full and must attach something. Entries are never
        deleted, so an emptied escrow takes top-ups without a second fee.
      </P>
      <H3 id="m-withdraw-escrow">withdraw_escrow — payable, exactly 1 yocto</H3>
      <CodeBlock code="withdraw_escrow(amount: U128)" />
      <P>
        Sends <M>amount</M> of the caller’s escrow back to the caller. It needs exactly{' '}
        <M>1 yocto</M> attached, which a function-call key cannot attach, so{' '}
        <strong className="text-white">only a full-access key can withdraw</strong>. The amount must
        be between 1 and the balance. The escrow is debited before the transfer; the private callback{' '}
        <M>on_escrow_withdraw(account_id, amount)</M> puts the amount back, once, if the transfer
        fails (a direct call to it from anyone else panics). The 1 yocto stays in the registry.
      </P>
      <H3 id="m-attest">record_attestation</H3>
      <CodeBlock code="record_attestation(service_id: u64, nonce: String, payment_tx_hash: String, success: bool)" />
      <P>
        Records the outcome of the call that followed a payment. The caller must be the service’s
        attestor or owner and the service active. The payment must exist for that service, not yet
        be attested and not be self-paid. It marks the payment attested, bumps the score (
        <M>total + 1</M>, and <M>success + 1</M> when <M>success</M>), prepends the attestation (the
        list is truncated at 100) and writes an activity entry. <M>payment_tx_hash</M> is
        informational, at most 64 bytes. Not payable: the score and the attestation list are
        prepaid by the registration deposit, while the activity entry overwrites a slot of the
        200-slot ring and any growth of that slot is paid from the registry account’s own balance
        (at most about 0.5 NEAR in all; <M>near:deploy</M> wants 3 NEAR on the account for this).
      </P>
      <H3 id="m-set-active">set_active · set_attestor</H3>
      <CodeBlock code={'set_active(service_id: u64, active: bool)\nset_attestor(service_id: u64, attestor: AccountId)'} />
      <P>
        Owner only. An inactive service accepts no new payments and no attestations.{' '}
        <M>set_attestor</M> replaces the account that may attest (the owner always may).
      </P>

      <H2 id="views">Views</H2>
      <DocTable
        head={['View', 'Returns']}
        rows={[
          [<M key="1">get_service(service_id)</M>, <span key="1d"><M>ServiceView</M> or <M>null</M>.</span>],
          [<M key="2">list_services(from_index, limit)</M>, <span key="2d"><M>ServiceView[]</M> with ids <M>from_index..</M> ascending (1-based; 0 starts at 1); <M>limit</M> is clamped to 50.</span>],
          [<M key="3">services_count()</M>, <span key="3d">The number of services, which is also the newest id.</span>],
          [<M key="4">get_score(service_id)</M>, <span key="4d"><M>{'{ total_calls, success_calls }'}</M>; zeros for an unknown id.</span>],
          [<M key="5">get_attestations(service_id)</M>, <span key="5d"><M>AttestationView[]</M>, newest first, at most 100; empty for an unknown id.</span>],
          [<M key="6">get_payment(nonce)</M>, <span key="6d"><M>PaymentView</M> or <M>null</M>. This is what the gateway verifies a proof against.</span>],
          [<M key="7">get_recent_activity(limit)</M>, <span key="7d"><M>ActivityView[]</M>, newest first; <M>limit</M> is clamped to 200.</span>],
          [<M key="8">escrow_of(account_id)</M>, <span key="8d">The account’s escrow as a <M>U128</M> decimal string; <M>"0"</M> for an account that never deposited.</span>],
        ]}
      />
      <H3 id="shapes">JSON shapes</H3>
      <P>Views are snake_case JSON; <M>U128</M> amounts are decimal strings.</P>
      <CodeBlock
        label="ServiceView (get_service of service #1 on the deployed registry)"
        code={JSON.stringify(
          {
            id: 1,
            name: 'USD exchange rates',
            description:
              'Latest USD exchange rates from open.er-api.com, wrapped by the NearGate testnet seed script',
            gateway_base_url: 'https://neargate-gateway-production.up.railway.app',
            accepts: [{ asset: 'near', amount: '10000000000000000000000', decimals: 24, symbol: 'NEAR' }],
            payment_target: 'neargate-app-seller.testnet',
            owner: 'neargate-app-seller.testnet',
            attestor: 'neargate-app-gateway.testnet',
            active: true,
            created_at_ms: 1794495083358,
          },
          null,
          2,
        )}
      />
      <DocTable
        head={['Type', 'Fields']}
        rows={[
          [<M key="1">PaymentOption</M>, <Fields key="1f">{'{ asset, amount, decimals, symbol }'}</Fields>],
          [<M key="2">ScoreView</M>, <Fields key="2f">{'{ total_calls, success_calls }'}</Fields>],
          [<M key="3">AttestationView</M>, <Fields key="3f">{'{ nonce, payment_tx_hash, success, timestamp_ms }'}</Fields>],
          [<M key="4">PaymentView</M>, <Fields key="4f">{'{ nonce, service_id, payer, amount, timestamp_ms, block_height, self_paid, attested }'}</Fields>],
          [
            <M key="5">ActivityView</M>,
            <span key="5f">
              <Fields>{'{ kind, service_id, account, amount?, success?, nonce?, payment_tx_hash?, timestamp_ms, block_height }'}</Fields>
              ; <M>kind</M> is <M>service_registered</M>, <M>payment</M> or <M>attestation</M>, and{' '}
              <M>account</M> is the owner, the payer, or whoever recorded the attestation (the
              attestor or the owner) accordingly.
            </span>,
          ],
        ]}
      />
      <P>
        The public endpoint is never stored: the contract keeps only <M>gateway_base_url</M>, and
        every reader computes <M>{'<gateway_base_url>/svc/<id>'}</M>. An activity view cannot name its
        own transaction, which is why the dashboard’s live feed links to the event’s block and the
        gateway serves <DocLink href="/docs/protocol#receipts">receipts</DocLink>.
      </P>

      <H2 id="events">Events</H2>
      <P>
        Change methods emit NEP-297 events with <M>standard: "neargate"</M> and{' '}
        <M>version: "1.0.0"</M>:
      </P>
      <DocTable
        head={['Event', 'Data']}
        rows={[
          [<M key="1">service_registered</M>, <M key="1d">{'{ service_id, owner, name, payment_target, attestor }'}</M>],
          [<M key="2">payment</M>, <M key="2d">{'{ service_id, nonce, payer, amount, self_paid }'}</M>],
          [<M key="3">attestation</M>, <M key="3d">{'{ service_id, nonce, payment_tx_hash, success, caller }'}</M>],
          [<M key="4">service_status</M>, <M key="4d">{'{ service_id, active }'}</M>],
          [<M key="5">attestor_changed</M>, <M key="5d">{'{ service_id, attestor }'}</M>],
          [
            <M key="6">escrow_deposit</M>,
            <span key="6d">
              <M>{'{ account_id, amount, balance }'}</M>: <M>amount</M> is what was credited (net of
              the storage fee on a first deposit, or a failed withdrawal put back) and{' '}
              <M>balance</M> the escrow after it.
            </span>,
          ],
          [
            <M key="7">escrow_withdraw</M>,
            <span key="7d">
              <M>{'{ account_id, amount, balance }'}</M>: the amount debited and the escrow after the
              debit.
            </span>,
          ],
        ]}
      />
      <P>
        The activity ring has no escrow entries: an escrow payment is a <M>payment</M> entry like any
        other, and deposits and withdrawals appear in the events only.
      </P>

      <H2 id="escrow">Escrow and agent keys</H2>
      <P>
        An AI agent should not hold a key that can empty its owner’s account. NEAR offers a
        function-call access key, restricted to one receiver and a list of methods, that can attach
        no deposit. The registry’s escrow is built around that:
      </P>
      <DocTable
        head={['Call', 'Attaches', 'Who can sign it']}
        rows={[
          [<M key="1">deposit_escrow</M>, 'the amount to prepay', 'a full-access key'],
          [<M key="2">withdraw_escrow</M>, 'exactly 1 yocto', 'a full-access key only'],
          [<M key="3">pay_from_escrow</M>, 'nothing', 'a full-access key, or a function-call key restricted to pay_from_escrow on the registry'],
        ]}
      />
      <Callout tone="warn" title="THE SECURITY PROPERTY">
        An agent key restricted to <M>pay_from_escrow</M> on the registry can spend the escrow and
        nothing else. It cannot withdraw (that attaches 1 yocto), deposit, register or pause a
        service, or move any other balance, and NEAR rejects any other call from it. Withdrawing
        needs a full-access key. <strong className="text-white">The escrow is the spending
        limit</strong>: a leaked agent key can spend all of it, on any active service, and no more
        NEAR than that. Its gas is paid by the account, not the escrow, so a leaked key can also burn
        gas from the account balance up to its allowance. Keep in the escrow only what the agent may
        spend, keep the allowance low, and top the escrow up from the full-access key.
      </Callout>
      <P>
        Create such a key with <DocLink href="/docs/cli#agent-key">neargate agent-key add</DocLink>{' '}
        and fund the escrow with <DocLink href="/docs/cli#escrow">neargate escrow deposit</DocLink>.
        The key’s <M>allowance</M> only pays its gas, and that gas comes from the account balance
        (not the escrow): it caps how much gas a leaked key can burn there.
      </P>

      <H2 id="errors">Error codes</H2>
      <P>
        A panic message is <M>ERR_CODE: text</M>. The clients keep the code as the error’s{' '}
        <M>code</M>, in mock and live mode alike. Failures that are not contract rejections
        (transport, a sent transaction without an outcome, a missing key) have their own codes on the{' '}
        <DocLink href="/docs/cli#error-codes">CLI page</DocLink>.
      </P>
      <DocTable
        head={['Code', 'When']}
        rows={[
          [<span key="1"><M>ERR_EMPTY_NAME</M><Sub>register_service</Sub></span>, 'The trimmed name is empty.'],
          [<span key="2"><M>ERR_FIELD_TOO_LONG</M><Sub>register_service, record_attestation</Sub></span>, 'A field is over its byte limit: name, description, gateway_base_url, accepts.asset, accepts.symbol, payment_tx_hash.'],
          [<span key="3"><M>ERR_INVALID_PRICE</M><Sub>register_service</Sub></span>, 'accepts has fewer than 1 or more than 4 options, a "near" amount is below 10^18 yocto, another amount is zero, or more than one option is "near".'],
          [<span key="4"><M>ERR_DEPOSIT_TOO_LOW</M><Sub>register_service, pay, deposit_escrow</Sub></span>, 'Attached below 0.12 NEAR (registration) or below price + 0.002 NEAR (pay; the message states the required yocto). deposit_escrow: a first deposit that is not more than 0.002 NEAR, or a top-up that attaches nothing.'],
          [<span key="5"><M>ERR_STORAGE_EXCEEDED</M><Sub>register_service, pay, pay_from_escrow, deposit_escrow</Sub></span>, 'The call’s measured storage cost is above its budget (the deposit, or the fee).'],
          [<span key="6"><M>ERR_SERVICE_NOT_FOUND</M><Sub>pay, pay_from_escrow, record_attestation, set_active, set_attestor</Sub></span>, 'No service with that id.'],
          [<span key="7"><M>ERR_SERVICE_INACTIVE</M><Sub>pay, pay_from_escrow, record_attestation</Sub></span>, 'The owner switched the service off.'],
          [<span key="8"><M>ERR_NO_NATIVE_PRICE</M><Sub>pay, pay_from_escrow</Sub></span>, 'The service has no "near" price option to settle.'],
          [<span key="9"><M>ERR_INVALID_NONCE</M><Sub>pay, pay_from_escrow</Sub></span>, 'The nonce is not 1 to 20 decimal digits.'],
          [<span key="10"><M>ERR_NONCE_USED</M><Sub>pay, pay_from_escrow</Sub></span>, 'The nonce was already paid. Nonces are single-use across the registry.'],
          [<span key="11"><M>ERR_NOT_AUTHORIZED</M><Sub>record_attestation, set_active, set_attestor</Sub></span>, 'The caller is not the service owner (set_active, set_attestor) or the attestor or owner (record_attestation).'],
          [<span key="12"><M>ERR_PAYMENT_NOT_FOUND</M><Sub>record_attestation</Sub></span>, 'The registry holds no payment with that nonce.'],
          [<span key="13"><M>ERR_PAYMENT_WRONG_SERVICE</M><Sub>record_attestation</Sub></span>, 'The payment belongs to another service.'],
          [<span key="14"><M>ERR_ALREADY_ATTESTED</M><Sub>record_attestation</Sub></span>, 'That payment was already attested. The gateway treats this as done, not failed.'],
          [<span key="15"><M>ERR_SELF_PAYMENT</M><Sub>record_attestation</Sub></span>, 'The owner or the payment target paid; it cannot be attested.'],
          [<span key="16"><M>ERR_ESCROW_INSUFFICIENT</M><Sub>pay_from_escrow, withdraw_escrow</Sub></span>, 'pay_from_escrow: the escrow holds less than price + 0.002 NEAR (an account that never deposited holds 0). withdraw_escrow: the amount is 0 or above the balance. The message states the balance.'],
          [<span key="17"><M>ERR_ONE_YOCTO_REQUIRED</M><Sub>withdraw_escrow</Sub></span>, 'Not exactly 1 yocto attached. It is the first check, and the reason a function-call key cannot withdraw.'],
          [<span key="18"><M>ERR_DEPOSIT_NOT_ALLOWED</M><Sub>pay_from_escrow</Sub></span>, 'Any deposit attached. pay_from_escrow spends the escrow and takes none; it is the first check.'],
        ]}
      />
      <P>
        One more code is NEAR’s, not the contract’s: <M>ERR_INSUFFICIENT_BALANCE</M> means the signer
        cannot fund the deposit plus gas, or would be left short of its storage stake after the
        transaction. <M>pay_from_escrow</M> checks, in this order:{' '}
        <M>ERR_DEPOSIT_NOT_ALLOWED</M>, <M>ERR_SERVICE_NOT_FOUND</M>, <M>ERR_SERVICE_INACTIVE</M>,{' '}
        <M>ERR_NO_NATIVE_PRICE</M>, <M>ERR_ESCROW_INSUFFICIENT</M>, <M>ERR_INVALID_NONCE</M>,{' '}
        <M>ERR_NONCE_USED</M>; <M>withdraw_escrow</M>: <M>ERR_ONE_YOCTO_REQUIRED</M>, then{' '}
        <M>ERR_ESCROW_INSUFFICIENT</M>.
      </P>

      <H2 id="build">Build, test and deploy</H2>
      <CodeBlock
        label="from the repository root"
        code={[
          `(cd contracts/registry && cargo near build non-reproducible-wasm --env 'RUSTFLAGS=-C link-arg=-s --remap-path-prefix=$HOME=/build')`,
          '# -> contracts/target/near/neargate_registry/neargate_registry.wasm',
          '(cd contracts && cargo test)',
        ].join('\n')}
      />
      <P>
        The toolchain is pinned in <M>contracts/rust-toolchain.toml</M>; <M>cargo-near</M> is a
        separate install. <M>npm run near:deploy</M> builds and deploys the contract onto the
        registry account and reads <M>services_count</M> back; see the{' '}
        <DocLink href="/docs/quickstart#testnet">quickstart</DocLink>. The build above is the one it
        runs: the path remap keeps the builder’s home directory out of the wasm published on-chain,
        and <M>near:deploy</M> refuses a wasm that still holds a path under <M>$HOME</M> (including
        one passed in <M>NEARGATE_REGISTRY_WASM</M>). Reads need no key:
      </P>
      <CodeBlock
        label="with the near CLI"
        code={`near contract call-function as-read-only ${DEFAULT_REGISTRY_CONTRACT_ID || '<registry account>'} get_service json-args '{"service_id":1}' network-config testnet now`}
      />

      <NextLinks
        links={[
          { href: '/docs/protocol', label: 'How it works' },
          { href: '/docs/cli', label: 'CLI & MCP' },
        ]}
      />
    </>
  );
}
