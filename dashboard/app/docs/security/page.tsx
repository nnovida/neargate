import type { Metadata } from 'next';
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
  Sub,
} from '@/components/docs';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/security' },
  title: 'Security model',
  description:
    'What the registry enforces and what the gateway reports: payment-backed scores, the owner-signed self-map request, single-use nonces, the SSRF and redirect guards, budget caps, restricted agent keys and their blast radius, the gasless relayer’s exposure and front-running, keys and a go-live checklist.',
};

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="CONCEPTS"
        title="Security model"
        lede="NearGate splits trust deliberately: the registry contract enforces what it can see on-chain, and the gateway reports what only it can observe. This page states which is which, then covers the guards on the money, the owner-signed mapping, outbound requests and keys."
      />

      <H2 id="trust-model">Trust model</H2>
      <P>
        Read a service’s score as two different kinds of statement:
      </P>
      <DocTable
        head={['Claim, and who guarantees it', 'How']}
        rows={[
          [
            <span key="1">
              <strong className="text-white">Every counted call has a real payment</strong>
              <Sub>The registry, on-chain — trustless</Sub>
            </span>,
            <span key="1h">
              <M>record_attestation</M> only accepts a nonce the registry itself holds a payment
              for, once, and never for a self-paid payment (payer is the service owner or payment
              target). The registry also forwards the price itself, so a payment record means the
              price really moved.
            </span>,
          ],
          [
            <span key="2">
              <strong className="text-white">The call succeeded or failed</strong>
              <Sub>The service’s attestor or owner — reported</Sub>
            </span>,
            <span key="2h">
              The <M>success</M> flag is whatever the attestor (the gateway, by default) or the
              owner submits; the registry lets both attest. The gateway sets it from the upstream’s
              HTTP status (2xx is success) and the registry cannot check that it did.
            </span>,
          ],
          [
            <span key="3">
              <strong className="text-white">A nonce pays once</strong>
              <Sub>The registry and the gateway</Sub>
            </span>,
            <span key="3h">
              <M>pay</M> refuses a used nonce (<M>ERR_NONCE_USED</M>); the gateway burns it before
              proxying. See <DocLink href="/docs/protocol#single-use">single-use nonce</DocLink>.
            </span>,
          ],
          [
            <span key="4">
              <strong className="text-white">Only the owner controls a service</strong>
              <Sub>The registry</Sub>
            </span>,
            <span key="4h">
              <M>set_active</M> and <M>set_attestor</M> are owner-only. The contract has no admin and
              no owner of its own.
            </span>,
          ],
        ]}
      />
      <Callout tone="warn" title="WHAT THE SCORE DOES NOT PROVE">
        A seller who controls the attestor can report any success flag for a payment that really
        happened, and the self-payment guard compares <em>accounts</em>, not people: a seller that
        pays from a second account makes a real payment. That payment costs at least the{' '}
        <M>0.002 NEAR</M> storage fee, and the price returns to the seller’s own payment target, so
        it is cheap, not free. Treat a trust tier as a signal backed by real transfers, not proof of
        independent buyers; the payment records and attestation history are public if you want to
        look.
      </Callout>

      <H2 id="payment-integrity">Payment integrity</H2>
      <H3 id="payment-verify">The gateway verifies against the chain</H3>
      <P>
        A proof is never trusted for what it claims. The gateway reads the registry’s payment record
        for the nonce (service, amount, age, not yet attested) and, in live mode, the transaction
        itself: signed by the named payer, received by the registry, holding a <M>pay</M> or{' '}
        <M>pay_from_escrow</M> action with the same service id and nonce, and succeeded (<M>tx_mismatch</M> otherwise). The full
        order is on <DocLink href="/docs/protocol#verification">How it works</DocLink>.
      </P>
      <H3 id="payment-client">The buyer’s client refuses a bad invoice</H3>
      <P>
        The client validates the invoice before it signs anything. It refuses, without paying, an
        invoice that is not valid x402 V1, is expired, has a storage fee other than the registry’s
        <M> 0.002 NEAR</M>, whose total is not <M>price + fee</M> (<M>BAD_INVOICE</M>), that is for
        another network (<M>NETWORK_MISMATCH</M>), whose <M>payTo</M> is not the registry it settles
        on (<M>REGISTRY_MISMATCH</M>) or that names another service than the one requested (
        <M>SERVICE_MISMATCH</M>). It never follows a redirect (<M>REDIRECT_REFUSED</M>).
      </P>
      <H3 id="payment-budget">Budget cap</H3>
      <P>
        <M>--max</M> (CLI), <M>maxNear</M> (MCP) and the buyer agent’s budget cap the{' '}
        <strong>total attached</strong>, price plus the storage fee, and are checked before the
        payment (<M>BUDGET_EXCEEDED</M>). The buyer agent checks price plus fee against its budget
        minus what it has already spent in the run, and then hands the client exactly that approved
        total as its cap, so an invoice that grew after the check is refused. The cap covers a{' '}
        <M>--from-escrow</M> payment the same way, and the client also reads the escrow first and
        refuses (<M>ERR_ESCROW_INSUFFICIENT</M>) before sending anything it cannot pay. Because{' '}
        <M>pay_from_escrow</M> carries no amount and debits the service’s on-chain price whatever the
        invoice says, the client first checks the invoice’s total against the registry and refuses a
        differing one (<M>PRICE_MISMATCH</M>), so the cap holds for escrow payments too.
      </P>
      <H3 id="payment-self">Self-payment guard</H3>
      <P>
        A payment whose payer is the service’s owner or payment target is recorded as{' '}
        <M>self_paid</M>. The gateway serves it (the buyer did pay) but does not attest it, and the
        registry would reject the attestation anyway (<M>ERR_SELF_PAYMENT</M>). See the caveat in the{' '}
        <DocLink href="#trust-model">trust model</DocLink>.
      </P>

      <H2 id="self-map">Owner-signed mapping (self-map)</H2>
      <P>
        The gateway holds the private upstream URL of each service. To let a service owner set it
        without a shared admin token, <M>POST /services/:id/map</M> accepts a request signed with
        the owner’s NEAR key. This is what <M>neargate wrap</M> and <M>neargate map</M> send in live
        mode.
      </P>
      <CodeBlock
        label="POST /services/<id>/map"
        code={JSON.stringify(
          {
            upstreamUrl: 'https://api.example.com/gold',
            accountId: '<service owner account id>',
            publicKey: 'ed25519:<owner key>',
            timestamp: 1794407336851,
            signature: '<base64 ed25519 signature>',
          },
          null,
          2,
        )}
      />
      <P>The signature is an ed25519 signature over these exact bytes (UTF-8, joined by newlines):</P>
      <CodeBlock
        label="signed message"
        code={['NearGate/self-map/v1', '<network>', '<serviceId>', '<upstreamUrl>', '<timestamp>'].join('\n')}
      />
      <P>
        The fixed prefix separates the message from any other use of the key, and <M>network</M> and{' '}
        <M>serviceId</M> stop a signature being replayed on another chain or for another service;{' '}
        <M>upstreamUrl</M> is the string exactly as sent. The gateway rebuilds the bytes itself and
        checks, cheapest first:
      </P>
      <DocTable
        head={['Check', 'Answer on failure']}
        rows={[
          ['The id is a valid service id; the body has the right shape', <span key="1"><M>400 invalid_service_id</M> <M>400 invalid_body</M></span>],
          ['The service exists on the registry', <M key="2">404 service_not_found</M>],
          ['The timestamp is within 120 seconds of the gateway’s clock', <M key="3">400 stale_timestamp</M>],
          ['The signature verifies for the public key over the rebuilt message', <M key="4">401 owner_signature_invalid</M>],
          ['The account is the service’s owner on the registry', <M key="5">403 not_service_owner</M>],
          [
            'The public key is a FullAccess key of that account (a function-call key, such as a dapp login key, is not the owner’s authority)',
            <span key="6">
              <M>403 key_not_full_access</M>
              <Sub>
                If the chain cannot answer: <M>503 chain_unavailable</M>. It fails closed and maps
                nothing.
              </Sub>
            </span>,
          ],
          ['The timestamp is newer than the last accepted mapping of this service', <M key="7">409 replayed</M>],
          ['The upstream URL passes the SSRF guard (below)', <span key="8"><M>400 invalid_upstream_url</M> <M>400 forbidden_upstream_host</M></span>],
        ]}
      />
      <P>
        Then it stores the mapping and answers <M>204</M>. Replays are bounded twice: the 120-second
        window, and a per-service monotonic timestamp (a rejected request never moves it). That second
        guard lives in the gateway’s memory, so across a restart the window is the bound. The route
        is rate limited to 20 requests per minute. In mock mode the mapping goes through the
        token-protected admin route instead.
      </P>

      <H2 id="ssrf">Outbound requests (SSRF)</H2>
      <P>
        Two parties fetch a URL a seller controls: the gateway, fetching the upstream, and the
        buyer’s client, fetching the endpoint it read from the registry.
      </P>
      <H3 id="ssrf-gateway">The gateway and the upstream</H3>
      <DocTable
        head={['Layer', 'What it does']}
        rows={[
          [
            'At mapping time',
            'The upstream must be an http(s) URL of at most 2048 characters with no user name or password in it; in live mode its host must not be private: localhost names, 0.0.0.0/8, loopback, RFC 1918, link-local (cloud metadata), CGNAT, 192.0.0.0/16, the 198.18.0.0/15 benchmark range, IPv4 multicast, reserved and broadcast (224.0.0.0 and up), and in IPv6 the unspecified and loopback addresses, unique-local, link-local and IPv4-mapped private addresses.',
          ],
          [
            'At request time (live)',
            'Before a payment is even challenged, the host is resolved again and refused if any address is private or it does not resolve (503 service_unavailable). This defeats a host that was public when mapped and re-pointed later.',
          ],
          [
            'On the connection (live)',
            'The proxy resolves the host once more right before it connects, refuses it if any address is private, and pins the connection to the first address of that lookup, so the address it checked is the one it uses. If the pinning connector cannot be built, it connects without the pin.',
          ],
          [
            'Redirects',
            'Live mode never follows an upstream redirect (it would let a public host bounce the gateway into a private network); the 3xx status passes through without its Location header. Mock mode follows them so local demos work.',
          ],
          [
            'What reaches the upstream',
            'Only accept, accept-language and user-agent, the JSON body and the query string. The payment proof, cookies, authorization and forwarding headers are never forwarded; bodies are capped at 1 MiB each way; the upstream URL never appears in any response.',
          ],
        ]}
      />
      <H3 id="ssrf-buyer">The buyer’s client and the endpoint</H3>
      <P>
        The endpoint comes from the registry, which accepts any bytes there. The client refuses one
        that is not http(s) (<M>BAD_URL</M>) and, off the offline devnet, one whose host is private
        or resolves to a private address (<M>FORBIDDEN_HOST</M>); it never follows a redirect, so the
        payment proof cannot be bounced to an unchecked address; and it caps each request at 30
        seconds. This dashboard applies the same distrust: it links a service’s endpoint only when it
        is http(s), and puts it into the copy-paste <M>curl</M> snippet only as a single quoted
        shell word.
      </P>

      <H2 id="agent-keys">Agent keys and the escrow</H2>
      <P>
        An AI agent that pays for calls needs a key, and a full-access key can drain its owner’s
        account. NearGate gives the agent a different kind of key instead: a NEAR{' '}
        <strong>function-call access key</strong> that the account’s owner adds with{' '}
        <DocLink href="/docs/cli#agent-key">neargate agent-key add</DocLink>. It is restricted, by
        NEAR itself, to one receiver (the registry) and one method (<M>pay_from_escrow</M>), and it
        can attach no deposit.
      </P>
      <Callout tone="warn" title="BLAST RADIUS">
        An agent key restricted to <M>pay_from_escrow</M> can spend the escrow and nothing else.
        Withdrawing needs a full-access key (<M>withdraw_escrow</M> attaches 1 yocto, which a
        function-call key cannot). The escrow is the spending limit: a leaked agent key can spend all
        of it, on any active service, and no more NEAR than that. Its gas, though, comes from the
        account’s own balance, not from the escrow: a leaked key can also burn gas from the account
        balance up to its allowance, so set the allowance low. Apart from that gas it cannot touch
        the rest of the account, change a service or move NEAR anywhere else.
      </Callout>
      <DocTable
        head={['What', 'How it is handled']}
        rows={[
          [
            'The spending limit',
            <span key="1">
              The escrow balance, funded from the full-access key (<M>neargate escrow deposit</M>).
              Keep in it what the agent may spend. <M>--max</M> and <M>maxNear</M> still cap each
              call’s total; they are per call, the escrow is the total.
            </span>,
          ],
          [
            'The key’s allowance',
            'Pays only the key’s gas, a small amount per call, and that gas is drawn from the account balance, not from the escrow. A leaked key can burn gas from the account balance up to its allowance, so set it low; it is not the spending limit.',
          ],
          [
            'The key file',
            <span key="3">
              <M>agent-key add</M> writes the secret to{' '}
              <M>~/.near-credentials/&lt;network&gt;/&lt;account&gt;.neargate-agent.json</M> with mode{' '}
              <M>0600</M>, refuses to overwrite an existing file and prints only the public key and
              the path, never the secret. Treat it like any key file: it is what the agent uses
              as <M>--key-file</M>.
            </span>,
          ],
          [
            'Revoking',
            'Delete the key from the account with its full-access key (for example with the near CLI). The escrow stays; take it back with neargate escrow withdraw.',
          ],
          [
            'What it does not limit',
            'The agent chooses the service: it can pay any active service for any price the escrow covers, including one that is not worth it. Choose the escrow size accordingly, and use maxNear / --max to bound a single call.',
          ],
        ]}
      />
      <P>
        The offline devnet models only one public, full-access key per account (it signs the mock
        gasless delegates), never a restricted one, so the restriction itself is a live-chain
        property (agent keys need live mode). The registry’s own rules around it are in the{' '}
        <DocLink href="/docs/contract#escrow">contract reference</DocLink>.
      </P>

      <H2 id="relayer">The gasless relayer</H2>
      <P>
        With <M>RELAYER_ENABLED</M> the gateway account (<M>GATEWAY_ACCOUNT_ID</M>) relays buyers’
        signed <M>pay_from_escrow</M> delegates and pays their gas: the{' '}
        <DocLink href="/docs/protocol#gasless">gasless rail</DocLink>. The buyer’s escrow pays the
        price and the fee, as for any <M>pay_from_escrow</M>.
      </P>
      <Callout tone="warn" title="RELAYER EXPOSURE">
        The relayer’s exposure is gas only. NEAR has a relayer pay any deposit that a relayed call
        attaches, so the gateway relays exactly one shape and nothing else: one zero-deposit
        pay_from_escrow to the registry, for an invoice it issued, with 30 TGas. It never relays a
        transfer, another method or another contract, and the escrow, not the relayer, pays the
        service.
      </Callout>
      <P>
        Every refusal below comes before the relay, so a delegate the gateway refuses there costs it
        nothing (the full list is on{' '}
        <DocLink href="/docs/protocol#gasless-checks">How it works</DocLink>):
      </P>
      <DocTable
        head={['A delegate that…', 'Refused as']}
        rows={[
          ['Is not a valid SignedDelegate, or has any other shape: another sender, receiver, method, arguments or gas, a deposit, a second action', 'delegate_* (e.g. delegate_wrong_action)'],
          ['Expires within 20 blocks, or carries a nonce NEAR would call too large', 'delegate_expired, delegate_nonce_too_large'],
          ['Is not signed by the key it names (a forged or altered delegate)', <M key="2">bad_signature</M>],
          ['Names a key the payer does not hold, or a function-call key not allowed to call pay_from_escrow on the registry', 'unknown_key, key_not_allowed'],
          ['Carries a nonce the key already used (read at optimistic finality, so a block not yet final counts), or one this gateway relayed for that key and that may still run, or is relaying now', <M key="4">stale_nonce</M>],
          ['Comes from an escrow that cannot pay price + 0.002 NEAR', <M key="5">escrow_insufficient</M>],
          ['Is for an invoice already paid, or whose relay is in flight or may still land', 'invoice_used, settlement_pending (never relayed twice)'],
        ]}
      />
      <P>
        What can still cost gas is a delegate that passes every check and then fails on chain — the
        buyer drained its escrow, or used or deleted the key, in between. The gateway answers{' '}
        <M>relay_failed</M> with a code that says whose failure it was: the registry’s{' '}
        <M>ERR_*</M> when NEAR ran the delegate (its nonce is then spent), <M>DELEGATE_REJECTED</M>{' '}
        when NEAR refused the delegate itself, <M>RELAYER_ERROR</M> when the relay failed on the
        gateway’s side (the detail stays in the gateway’s log, never in the answer). The relayer has
        paid at most one relay’s gas; the <DocLink href="#limits">rate limit</DocLink> on{' '}
        <M>/svc</M> bounds how often. Keep the gateway account funded for that gas, as for its
        attestations.
      </P>
      <H3 id="front-running">Front-running</H3>
      <P>
        On the tx rails (<M>pay</M>, and <M>pay_from_escrow</M> sent by the buyer) the payment is
        public on chain before the buyer presents its proof: someone watching the registry can
        present that transaction, nonce and payer first and receive the response, and the buyer then
        gets <M>invoice_used</M> (<M>PAID_NOT_SERVED</M>). That is inherent to paying first and
        proving after. On the gasless rail nothing a third party can redeem is public before the
        request reaches the gateway: the signed delegate travels only in the buyer’s own request, and
        the gateway burns the nonce for that request before it proxies. Between the relay landing
        and the burn the payment is already public on chain; the protection there is{' '}
        <M>invoice_used</M> for anything this gateway process did not relay. After a relay timeout the
        payment is public on chain, so the retry has the same front-running residual as the tx
        rails; so does any <M>settlement_pending</M> answer that names the relay transaction.
      </P>

      <H2 id="keys">Keys, secrets and the admin token</H2>
      <DocTable
        head={['Topic', 'Behaviour']}
        rows={[
          [
            'Key resolution (live)',
            'A secret key in the environment, else a key file, else ~/.near-credentials/<network>/<account>.json. The CLI resolves it before any chain call, so a missing or bad key fails fast. The gateway loads its key (GATEWAY_PRIVATE_KEY or a key file) only when it first signs, so it boots and verifies payments without one; a missing key then shows as failed attestations and relay_failed (RELAYER_ERROR) on the gasless rail.',
          ],
          [
            'Never printed',
            'Error messages name the source of a bad key, never its content, and no RPC URL or key reaches an error text. The CLI warns when a key file is readable by group or others.',
          ],
          [
            'Agent key file',
            'A restricted function-call key (see Agent keys and the escrow): mode 0600, never overwritten, secret never printed or logged. It can spend the escrow and nothing else.',
          ],
          [
            'Never committed',
            'The repository’s .gitignore covers .env files, keys/ and *.near-credentials*. Secrets belong in your environment or in an untracked .env.',
          ],
          [
            'Admin token',
            'Guards /admin/services. Live mode refuses the shipped default (dev-admin-token) at config load; the gateway compares tokens in constant time. Passing it as a CLI flag leaves it in shell history and ps — prefer the environment variable.',
          ],
          [
            'Gateway account',
            'Live mode refuses to start without GATEWAY_ACCOUNT_ID: it signs attestations (and, with RELAYER_ENABLED, the relays), and there is no mock-signer fallback.',
          ],
        ]}
      />

      <H2 id="limits">Gateway limits</H2>
      <DocTable
        head={['Route', 'Limit']}
        rows={[
          [<M key="1">/svc</M>, '60 requests per minute per client'],
          [<M key="2">/receipts</M>, '60 requests per minute per client'],
          [<M key="3">/services (self-map)</M>, '20 requests per minute per client'],
          [<M key="4">/admin</M>, '20 requests per minute per client'],
        ]}
      />
      <P>
        Limits key on the client IP. Behind one reverse proxy set <M>TRUST_PROXY=1</M> so that is the
        real client, never higher than the real number of hops, or <M>X-Forwarded-For</M> becomes
        spoofable. JSON request bodies to the gateway are capped at 256 KB; the gateway sets
        security headers (helmet) and has no CORS: it is a server-to-server API, and the dashboard
        reads through its own server routes.
      </P>

      <H2 id="checklist">Before you go live</H2>
      <DocTable
        head={['', 'Check']}
        rows={[
          ['☐', <span key="1">A strong, unique <M>AGENTGATE_ADMIN_TOKEN</M> (config refuses the default in live mode).</span>],
          ['☐', <span key="2"><M>REGISTRY_CONTRACT_ID</M> names your deployed registry, and <M>npm run smoke:live</M> passes.</span>],
          ['☐', <span key="3"><M>GATEWAY_ACCOUNT_ID</M> and its key are set, and each service you register names that account as its attestor.</span>],
          ['☐', <span key="4">The gateway is served over https; its public URL is final, because the registry stores it for good as the service’s <M>gateway_base_url</M>.</span>],
          ['☐', <span key="5"><M>TRUST_PROXY</M> matches your real proxy hop count.</span>],
          ['☐', <span key="6"><M>INVOICE_STORE_PATH</M> and <M>ATTESTATION_QUEUE_PATH</M> point at persistent files, so a restart keeps open invoices and replays unconfirmed attestations.</span>],
          ['☐', <span key="7">No key, <M>.env</M> or credentials file is committed.</span>],
          ['☐', <span key="8"><M>RELAYER_ENABLED=1</M> only if you mean to pay buyers’ gas; the gateway account then needs the balance for it.</span>],
        ]}
      />

      <NextLinks
        links={[
          { href: '/docs/protocol', label: 'How it works' },
          { href: '/docs/contract', label: 'Registry contract' },
        ]}
      />
    </>
  );
}
