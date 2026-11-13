/**
 * The sell & buy guide (/docs/guide) walks both roles on the live deployment. What it states is
 * checked against the code that decides it: the registry's deposits, the gateway's limits, where
 * `agent-key add` writes the key, the MCP server's tools and the SDK's exports, so a change there
 * that leaves the guide behind fails here. Rendered, so a section that loses its text fails too.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentKeyPath } from '@agentgate/chain';
import { MAX_PROXY_BODY_BYTES } from '@agentgate/middleware';
import {
  DEFAULT_GATEWAY_ACCOUNT_ID,
  DEFAULT_GATEWAY_URL,
  ESCROW_STORAGE_FEE_YOCTO,
  PAYMENT_STORAGE_FEE_YOCTO,
  REGISTRATION_DEPOSIT_YOCTO,
  loadConfig,
  nearToYocto,
} from '@agentgate/shared';
import GuidePage from '@/app/docs/guide/page';
import { DOC_LINKS } from '@/lib/doc-links';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const html = renderToStaticMarkup(createElement(GuidePage));
/** Text only: tags dropped, entities decoded, whitespace collapsed. */
const page = html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;|&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

describe('docs guide: sell & buy', () => {
  it('is in the docs nav and has the sections the other pages link to', () => {
    expect(DOC_LINKS.map((l) => l.href)).toContain('/docs/guide');
    for (const id of ['before', 'new-account', 'existing-account', 'where-the-key-goes', 'sell', 'sell-manage', 'buy', 'buy-once', 'buy-agent', 'buy-mcp', 'buy-sdk']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it('says where the key goes, in the order the CLI looks, and how to import an existing wallet', () => {
    const order = ['BUYER_PRIVATE_KEY=ed25519:…', '--key-file <path>', '~/.near-credentials/testnet/<account>.json'];
    const at = order.map((needle) => page.indexOf(needle));
    for (const [i, needle] of order.entries()) expect(at[i], needle).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const needle of ['npm install -g @neargate/cli', 'near account import-account', 'using-web-wallet', 'save-to-legacy-keychain', 'chmod 600']) {
      expect(page, needle).toContain(needle);
    }
  });

  it('tells a seller what the hosted gateway needs, with the limits the code enforces', () => {
    expect(MAX_PROXY_BODY_BYTES).toBe(1024 * 1024);
    expect(loadConfig({}, { requireStrongAdminToken: false }).upstreamTimeoutMs).toBe(30_000);
    expect(REGISTRATION_DEPOSIT_YOCTO).toBe(nearToYocto('0.12'));
    expect(PAYMENT_STORAGE_FEE_YOCTO).toBe(nearToYocto('0.002'));
    expect(ESCROW_STORAGE_FEE_YOCTO).toBe(nearToYocto('0.002'));
    for (const needle of [
      'at most 1 MiB each way and waits up to 30 s',
      'does not follow redirects',
      'dig +short AAAA',
      '0.12 NEAR',
      'plus the 0.002 NEAR storage fee',
      `--attestor ${DEFAULT_GATEWAY_ACCOUNT_ID} --gateway ${DEFAULT_GATEWAY_URL}`,
      'ERR_SELF_PAYMENT',
      'The registry has no method to edit them.',
    ]) {
      expect(page, needle).toContain(needle);
    }
  });

  it('shows the agent key where agent-key add writes it, and an MCP config that parses', () => {
    const where = agentKeyPath('testnet', 'you.testnet').replace(homedir(), '~').replace('you.testnet', '<you>.testnet');
    expect(page).toContain(`--key-file ${where}`);
    expect(page).toContain('neargate agent-key add --allowance 0.25 --account <you>.testnet');

    const tools = [...source('packages/cli/src/mcp.ts').matchAll(/server\.registerTool\(/g)];
    expect(tools).toHaveLength(5);
    expect(page).toContain('gives an agent five tools');

    const pre = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1] ?? '').find((c) => c.includes('mcpServers'));
    expect(pre).toBeDefined();
    const json = (pre ?? '{}').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const config = JSON.parse(json) as { mcpServers: { neargate: { command: string; args: string[] } } };
    expect(config.mcpServers.neargate.command).toBe('neargate');
    expect(config.mcpServers.neargate.args).toEqual(['mcp', '--account', '<you>.testnet', '--key-file', where]);
  });

  it('uses names @neargate/sdk exports and options its client takes', () => {
    const imported = /import \{ ([^}]+) \} from '@neargate\/sdk'/.exec(page);
    expect(imported).not.toBeNull();
    // @neargate/sdk re-exports shared, chain and client, plus its own createNearGateChain.
    expect(source('packages/sdk/src/index.ts')).toMatch(/export \* from '@agentgate\/client'/);
    const sdkSources = ['packages/sdk/src/chain.ts', 'packages/shared/src/money.ts', 'packages/client/src/index.ts']
      .map(source)
      .join('\n');
    for (const name of (imported?.[1] ?? '').split(',').map((n) => n.trim())) {
      expect(sdkSources, name).toMatch(new RegExp(`export (async )?(function|const|class) ${name}\\b`));
    }
    const client = source('packages/client/src/index.ts');
    for (const option of ['maxYocto', 'expectedServiceId', 'payFrom', 'gasless']) {
      expect(client, option).toMatch(new RegExp(`\\b${option}\\?:`));
      expect(page, option).toContain(`${option}:`);
    }
    expect(page).not.toContain('@agentgate/client');
  });
});
