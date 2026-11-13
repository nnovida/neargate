import type { Metadata } from 'next';
import {
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_ACCOUNT_ID,
  DEFAULT_GATEWAY_URL,
  DEFAULT_REGISTRY_CONTRACT_ID,
} from '@agentgate/shared';
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
  StepFlow,
} from '@/components/docs';
import { CLI_INSTALL } from '@/lib/cli';

export const metadata: Metadata = {
  alternates: { canonical: '/docs/guide' },
  title: 'Sell & buy',
  description:
    'Step by step on the live NEAR testnet deployment: get an account and put its key where the CLI finds it, sell an API behind the hosted gateway, and buy calls from your own account, as an agent with a restricted key (escrow, gasless), from Claude Desktop or from code with @neargate/sdk.',
};

const GATEWAY = DEFAULT_GATEWAY_URL || 'https://<gateway-host>';
const ATTESTOR = DEFAULT_GATEWAY_ACCOUNT_ID || '<gateway account>';
const AGENT_KEY = '~/.near-credentials/testnet/<you>.testnet.neargate-agent.json';

const SDK_EXAMPLE = `import { createAgentGateClient, createNearGateChain, nearToYocto } from '@neargate/sdk';

// Live mode on NEAR testnet and the deployed registry, by default.
const chain = createNearGateChain();
const client = createAgentGateClient({
  chain,
  // Reads ~/.near-credentials/testnet/you.testnet.json; or pass keyPath or secretKey.
  signer: { kind: 'near', accountId: 'you.testnet' },
  maxYocto: nearToYocto('0.02'), // refuse any invoice above 0.02 NEAR in total
  expectedServiceId: 1,
});

const res = await client.fetchPaid('${GATEWAY}/svc/1');
console.log(res.status, res.txHash, res.body);`;

const SDK_ESCROW = `// Pay out of a prepaid escrow, or gasless (the gateway relays and pays the gas).
const signer = { kind: 'near', accountId: 'you.testnet', keyPath: '${AGENT_KEY}' } as const;
const escrowClient = createAgentGateClient({ chain, signer, maxYocto: nearToYocto('0.02'), payFrom: 'escrow' });
const gaslessClient = createAgentGateClient({ chain, signer, maxYocto: nearToYocto('0.02'), payFrom: 'escrow', gasless: true });`;

export default function Page() {
  return (
    <>
      <DocHeader
        kicker="USE NEARGATE"
        title="Sell & buy"
        lede="Step by step on the live deployment on NEAR testnet: put your API behind the hosted gateway and get paid per call, or pay for calls yourself, from an agent with a restricted key, from Claude Desktop or from your own code. Every command uses the npm CLI."
      />

      {/* ───────────────────────────── account and key ───────────────────────────── */}
      <H2 id="before">Before you start: an account and its key</H2>
      <P>
        Both roles need the CLI and a funded NEAR testnet account whose key is on your machine:
      </P>
      <CommandBlock text={CLI_INSTALL} />
      <Callout tone="info" title="Your key never leaves your machine">
        The CLI and the SDK sign every transaction locally and send it to a NEAR RPC. NearGate never
        receives a key: the gateway sees the hash of the buyer’s <M>pay</M> transaction, the
        owner’s signature on a mapping request, or a signed gasless delegate. The dashboard only
        reads the chain; it has no wallet to connect.
      </Callout>

      <H3 id="new-account">A new account</H3>
      <P>
        The <DocLink href="https://github.com/near/near-cli-rs">near CLI</DocLink> creates one
        through the testnet faucet and saves its key where NearGate looks for it,{' '}
        <M>~/.near-credentials/testnet/&lt;you&gt;.testnet.json</M>:
      </P>
      <CommandBlock
        wrap
        text="near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet create"
      />

      <H3 id="existing-account">An account you already have</H3>
      <P>
        Import it into the same place. Run the command and answer its prompts, so no secret lands in
        your shell history:
      </P>
      <CommandBlock text="near account import-account" />
      <P>
        Choose <M>using-web-wallet</M> to sign in through your wallet in the browser (it adds a new
        key for the CLI, so you copy no secret), or <M>using-private-key</M> /{' '}
        <M>using-seed-phrase</M>; then the network <M>testnet</M> and{' '}
        <M>save-to-legacy-keychain</M>.
      </P>

      <H3 id="where-the-key-goes">Where the key goes</H3>
      <P>
        The CLI takes the account from <M>--account</M> and looks for its key in this order; the
        first one found wins. On <M>buy</M>, <M>escrow</M>, <M>agent-key</M> and <M>mcp</M> the
        variables start with <M>BUYER_</M>; on <M>wrap</M>, <M>map</M>, <M>pause</M> and{' '}
        <M>resume</M>, with <M>SELLER_</M>.
      </P>
      <DocTable
        head={['Order', 'Where', 'Use it for']}
        rows={[
          [
            '1',
            <M key="1">BUYER_PRIVATE_KEY=ed25519:…</M>,
            'a secret in the environment, e.g. from a secrets manager on a server',
          ],
          [
            '2',
            <span key="2">
              <M>--key-file &lt;path&gt;</M>, or <M>BUYER_KEY_PATH</M>
            </span>,
            'a near CLI credentials JSON elsewhere: an agent key, or a key kept outside the default folder',
          ],
          [
            '3',
            <M key="3">~/.near-credentials/testnet/&lt;account&gt;.json</M>,
            'the default: where the near CLI saved it above',
          ],
        ]}
      />
      <P>
        A key file is the near CLI’s JSON, <M>{'{ "account_id", "public_key", "private_key" }'}</M>.
        Keep it <M>chmod 600</M> (the CLI warns otherwise), never commit it, and never paste it into
        a chat or a form. Every flag and variable:{' '}
        <DocLink href="/docs/cli#signer-flags">CLI → signer flags</DocLink>.
      </P>

      {/* ───────────────────────────── sell ───────────────────────────── */}
      <H2 id="sell">Sell: put your API behind the gateway</H2>
      <P>
        You keep running your API. The hosted gateway answers callers with an invoice, checks each
        payment on chain, forwards the paid call to your API and records the result in the
        registry; the price goes straight to your account at payment time.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Check your API',
            body: (
              <>
                The gateway calls it over the internet, so it needs a public <M>https</M> URL with no
                user name or password in it. A <M>2xx</M> answer is a successful call; any other
                status is recorded as a failed one. The gateway does not follow redirects, forwards
                at most 1 MiB each way and waits up to 30 s. On the hosted gateway the API also
                needs an IPv6 address: the two IPv4-only APIs tried from it could not be reached.
                Check for an AAAA record:
              </>
            ),
            code: 'dig +short AAAA api.example.com',
          },
          {
            title: 'Wrap it',
            body: (
              <>
                One command registers the service on the registry and hands your API’s URL to the
                gateway in a request signed by your account’s full-access key; the URL never goes on
                chain. It attaches a <M>0.12 NEAR</M> deposit for the service’s storage and prints
                the service id, its public endpoint, its dashboard page and the{' '}
                <M>register_service</M> transaction. Name <M>{ATTESTOR}</M> as the attestor: the
                gateway records each call’s result as that account, and the registry refuses its
                attestations for a service that names another attestor, so those calls are never
                scored.
              </>
            ),
            code: `neargate wrap https://api.example.com/v1/rates --price 0.01 --name "My rates API" --description "What a caller gets" --account <you>.testnet --attestor ${ATTESTOR} --gateway ${GATEWAY}`,
          },
          {
            title: 'Check the invoice',
            body: (
              <>
                An unpaid call to the public endpoint answers <M>402</M> with the x402 invoice: your
                price plus the 0.002 NEAR storage fee, paid to the registry{' '}
                <M>{DEFAULT_REGISTRY_CONTRACT_ID || '<registry>'}</M>.
              </>
            ),
            code: `curl -i ${GATEWAY}/svc/<id>`,
          },
          {
            title: 'Test it from another account',
            body: (
              <>
                Buy one call with a different account. A call paid by the owner or the payment
                target is served but never counted (<M>ERR_SELF_PAYMENT</M>), so a self-test leaves
                the score at 0/0.
              </>
            ),
            code: 'neargate buy <id> --account <tester>.testnet --max 0.05',
          },
          {
            title: 'Watch it',
            body: (
              <>
                <M>status</M> prints the record, the score and the latest attestations;{' '}
                {DEFAULT_DASHBOARD_URL !== '' ? (
                  <>
                    the dashboard shows the same at <M>{DEFAULT_DASHBOARD_URL}/services/&lt;id&gt;</M>
                  </>
                ) : (
                  <>the dashboard shows the same on the service’s page</>
                )}
                . The score is the count of successful calls over all counted calls.
              </>
            ),
            code: 'neargate status <id>',
          },
        ]}
      />

      <H3 id="sell-options">Options worth knowing</H3>
      <DocTable
        head={['Option', 'What it does']}
        rows={[
          [
            <M key="p">--price &lt;near&gt;</M>,
            'The price per call in NEAR. Buyers attach it plus 0.002 NEAR for the payment record.',
          ],
          [
            <M key="t">--payment-target &lt;account&gt;</M>,
            'Where the price goes; by default the account that wraps.',
          ],
          [
            <span key="n">
              <M>--name</M>, <M>--description</M>
            </span>,
            'At most 64 and 280 bytes. Both are fixed once registered.',
          ],
        ]}
      />

      <H3 id="sell-manage">Change it later</H3>
      <DocTable
        head={['To', 'Run', 'Notes']}
        rows={[
          [
            'point the service at another URL',
            <M key="m">neargate map &lt;id&gt; &lt;new url&gt; --account &lt;you&gt;.testnet</M>,
            'A request to the gateway signed by your key; no transaction.',
          ],
          [
            'stop or restart sales',
            <span key="p">
              <M>neargate pause &lt;id&gt;</M> / <M>neargate resume &lt;id&gt;</M>, with{' '}
              <M>--account</M>
            </span>,
            'A set_active transaction. A paused service answers 403 and takes no payment.',
          ],
          [
            'change the name, description, price or gateway',
            'pause it and wrap a new service',
            'The registry has no method to edit them.',
          ],
        ]}
      />

      {/* ───────────────────────────── buy ───────────────────────────── */}
      <H2 id="buy">Buy: pay for a call</H2>
      <P>
        Every rail ends the same way: the payment is recorded in the registry, the gateway serves
        the call and records whether it succeeded. They differ in what pays and which key signs.
      </P>
      <DocTable
        head={['Rail', 'Flag', 'What pays', 'Key that signs']}
        rows={[
          ['Deposit (default)', '—', 'your account: price + 0.002 NEAR attached to pay', 'your full-access key'],
          [
            'Escrow',
            <M key="e">--from-escrow</M>,
            'a balance you prepaid in the registry',
            'a restricted agent key (or your full-access key)',
          ],
          [
            'Gasless',
            <M key="g">--gasless</M>,
            'the escrow; the gateway pays the gas',
            'a restricted agent key, as a signed delegate',
          ],
        ]}
      />

      <H3 id="buy-once">One call from your own account</H3>
      <StepFlow
        steps={[
          {
            title: 'Find a service',
            body: <>The catalog and one service in full, from the registry, with no key.</>,
            code: 'neargate list\nneargate status <id>',
          },
          {
            title: 'Buy one call',
            body: (
              <>
                The response goes to stdout; the receipt (amount, the <M>pay</M> transaction and its
                explorer link, the HTTP status) to stderr. Always pass <M>--max</M>: an invoice above
                it is refused with <M>BUDGET_EXCEEDED</M> before anything is paid.
              </>
            ),
            code: 'neargate buy <id> --account <you>.testnet --max 0.05',
          },
          {
            title: 'If it was paid but not served',
            body: (
              <>
                <M>PAID_NOT_SERVED</M> names the transaction and the nonce. Do not buy again (that
                pays twice): present the same proof again once the gateway answers. See{' '}
                <DocLink href="/docs/cli#codes-client">the error codes</DocLink>.
              </>
            ),
          },
        ]}
      />

      <H3 id="buy-agent">An agent that pays with a restricted key</H3>
      <P>
        Give an agent a key that NEAR itself limits to <M>pay_from_escrow</M> on the registry, and
        keep your full-access key to yourself. The escrow is the agent’s spending limit.
      </P>
      <StepFlow
        steps={[
          {
            title: 'Fund an escrow (your full-access key)',
            body: <>The first deposit keeps 0.002 NEAR for the escrow’s storage.</>,
            code: 'neargate escrow deposit 0.5 --account <you>.testnet',
          },
          {
            title: 'Add an agent key (your full-access key)',
            body: (
              <>
                Adds a function-call key that may call only <M>pay_from_escrow</M>, with{' '}
                <M>--allowance</M> NEAR of gas. The secret is written to{' '}
                <M>{AGENT_KEY}</M> (mode 0600); only its public key and path are printed.
              </>
            ),
            code: 'neargate agent-key add --allowance 0.25 --account <you>.testnet',
          },
          {
            title: 'The agent buys with that key',
            body: (
              <>
                From the escrow, or gasless: the hosted gateway relays the signed{' '}
                <M>pay_from_escrow</M> and pays the gas, so the account’s balance does not move.
              </>
            ),
            code: `neargate buy <id> --from-escrow --account <you>.testnet --key-file ${AGENT_KEY} --max 0.05\nneargate buy <id> --gasless --account <you>.testnet --key-file ${AGENT_KEY} --max 0.05`,
          },
          {
            title: 'Top up or take it back',
            body: <>Withdrawing needs the full-access key: an agent key cannot.</>,
            code: 'neargate escrow balance <you>.testnet\nneargate escrow withdraw 0.2 --account <you>.testnet',
          },
        ]}
      />
      <Callout tone="warn" title="If an agent key leaks">
        It can spend the escrow, on any active service, and burn gas up to its allowance; nothing
        else. Keep both small. Revoke it by deleting the key with your full-access key (
        <M>near account delete-keys</M>). More in{' '}
        <DocLink href="/docs/security">the security model</DocLink>.
      </Callout>

      <H3 id="buy-mcp">From Claude Desktop (MCP)</H3>
      <P>
        The CLI’s MCP server gives an agent five tools: list, inspect, get an invoice, read the
        escrow balance and buy (capped by <M>maxNear</M>). Point it at the agent key:
      </P>
      <CodeBlock
        label="claude_desktop_config.json"
        code={JSON.stringify(
          {
            mcpServers: {
              neargate: {
                command: 'neargate',
                args: ['mcp', '--account', '<you>.testnet', '--key-file', AGENT_KEY],
              },
            },
          },
          null,
          2,
        )}
      />
      <P>
        The tools and their parameters: <DocLink href="/docs/cli#mcp">CLI → mcp</DocLink>.
      </P>

      <H3 id="buy-sdk">From your own code (@neargate/sdk)</H3>
      <P>
        <M>@neargate/sdk</M> is the paying client the CLI runs, as one ES module with types (Node
        22.22.2 or later). <M>fetchPaid</M> requests the URL, checks the invoice against the
        registry and your cap, pays, retries with the proof and returns the response.
      </P>
      <CommandBlock text="npm install @neargate/sdk" />
      <CodeBlock label="pay for one call" code={SDK_EXAMPLE} />
      <CodeBlock label="escrow and gasless" code={SDK_ESCROW} />
      <P>
        A refusal before paying throws an <M>AgentGateError</M> with a stable <M>code</M>; a call
        that was paid but not served throws <M>PaidNotServedError</M> with the proof to present
        again. To build a client from scratch instead, follow{' '}
        <DocLink href="/docs/protocol">How it works</DocLink>.
      </P>

      <NextLinks
        links={[
          { href: '/docs/cli', label: 'CLI & MCP' },
          { href: '/docs/protocol', label: 'How it works' },
          { href: '/docs/security', label: 'Security model' },
        ]}
      />
    </>
  );
}
