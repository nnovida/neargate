import type { Metadata } from 'next';
import { DEFAULT_REGISTRY_CONTRACT_ID } from '@agentgate/shared';
import { Callout, CodeBlock, DocHeader, DocLink, DocTable, H2, H3, M, NextLinks, P, Sub } from '@/components/docs';
import { accountHref, explorerBaseFromEnv } from '@/lib/explorer';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/contract' },
  title: 'Registry contract',
  description:
    'Reference for the neargate-registry NEAR contract (Rust, near-sdk): constants and limits, change methods, views and their JSON shapes, NEP-297 events and every ERR_* code.',
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
      <H3 id="m-attest">record_attestation</H3>
      <CodeBlock code="record_attestation(service_id: u64, nonce: String, payment_tx_hash: String, success: bool)" />
      <P>
        Records the outcome of the call that followed a payment. The caller must be the service’s
        attestor or owner and the service active. The payment must exist for that service, not yet
        be attested and not be self-paid. It marks the payment attested, bumps the score (
        <M>total + 1</M>, and <M>success + 1</M> when <M>success</M>), prepends the attestation (the
        list is truncated at 100) and writes an activity entry. <M>payment_tx_hash</M> is
        informational, at most 64 bytes. Not payable: its storage is prepaid by the registration
        deposit.
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
        ]}
      />
      <H3 id="shapes">JSON shapes</H3>
      <P>Views are snake_case JSON; <M>U128</M> amounts are decimal strings.</P>
      <CodeBlock
        label="ServiceView"
        code={JSON.stringify(
          {
            id: 1,
            name: 'RWA FX & Gold Oracle',
            description: '…',
            gateway_base_url: 'https://gateway.example.org',
            accepts: [{ asset: 'near', amount: '500000000000000000000000', decimals: 24, symbol: 'NEAR' }],
            payment_target: 'seller.testnet',
            owner: 'seller.testnet',
            attestor: 'gateway.testnet',
            active: true,
            created_at_ms: 1794407336851,
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
              <M>account</M> is the owner, the payer or the attestor accordingly.
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
        ]}
      />

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
          [<span key="4"><M>ERR_DEPOSIT_TOO_LOW</M><Sub>register_service, pay</Sub></span>, 'Attached below 0.12 NEAR (registration) or below price + 0.002 NEAR (pay). The message states the required yocto for pay.'],
          [<span key="5"><M>ERR_STORAGE_EXCEEDED</M><Sub>register_service, pay</Sub></span>, 'The call’s measured storage cost is above its budget (the deposit, or the fee).'],
          [<span key="6"><M>ERR_SERVICE_NOT_FOUND</M><Sub>pay, record_attestation, set_active, set_attestor</Sub></span>, 'No service with that id.'],
          [<span key="7"><M>ERR_SERVICE_INACTIVE</M><Sub>pay, record_attestation</Sub></span>, 'The owner switched the service off.'],
          [<span key="8"><M>ERR_NO_NATIVE_PRICE</M><Sub>pay</Sub></span>, 'The service has no "near" price option to settle.'],
          [<span key="9"><M>ERR_INVALID_NONCE</M><Sub>pay</Sub></span>, 'The nonce is not 1 to 20 decimal digits.'],
          [<span key="10"><M>ERR_NONCE_USED</M><Sub>pay</Sub></span>, 'The nonce was already paid. Nonces are single-use across the registry.'],
          [<span key="11"><M>ERR_NOT_AUTHORIZED</M><Sub>record_attestation, set_active, set_attestor</Sub></span>, 'The caller is not the service owner (set_active, set_attestor) or the attestor or owner (record_attestation).'],
          [<span key="12"><M>ERR_PAYMENT_NOT_FOUND</M><Sub>record_attestation</Sub></span>, 'The registry holds no payment with that nonce.'],
          [<span key="13"><M>ERR_PAYMENT_WRONG_SERVICE</M><Sub>record_attestation</Sub></span>, 'The payment belongs to another service.'],
          [<span key="14"><M>ERR_ALREADY_ATTESTED</M><Sub>record_attestation</Sub></span>, 'That payment was already attested. The gateway treats this as done, not failed.'],
          [<span key="15"><M>ERR_SELF_PAYMENT</M><Sub>record_attestation</Sub></span>, 'The owner or the payment target paid; it cannot be attested.'],
        ]}
      />
      <P>
        One more code is NEAR’s, not the contract’s: <M>ERR_INSUFFICIENT_BALANCE</M> means the signer
        cannot fund the deposit plus gas.
      </P>

      <H2 id="build">Build, test and deploy</H2>
      <CodeBlock
        label="from the repository root"
        code={[
          '(cd contracts/registry && cargo near build non-reproducible-wasm)',
          '# -> contracts/target/near/neargate_registry/neargate_registry.wasm',
          '(cd contracts && cargo test)',
        ].join('\n')}
      />
      <P>
        The toolchain is pinned in <M>contracts/rust-toolchain.toml</M>; <M>cargo-near</M> is a
        separate install. <M>npm run near:deploy</M> builds and deploys the contract onto the
        registry account and reads <M>services_count</M> back; see the{' '}
        <DocLink href="/docs/quickstart#testnet">quickstart</DocLink>. Reads need no key:
      </P>
      <CodeBlock
        label="with the near CLI"
        code={`near contract call-function as-read-only <registry account> get_service json-args '{"service_id":1}' network-config testnet now`}
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
