import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { base58Encode } from '@agentgate/shared';
import { AccountLink } from '@/components/account-id';
import { TxHash } from '@/components/tx-hash';
import {
  DEFAULT_EXPLORER_URL,
  accountHref,
  explorerBaseFromEnv,
  txHref,
} from '@/lib/explorer';

/** A real-shaped NEAR tx hash: base58 of 32 bytes (what the chain and the devnet produce). */
const HASH = base58Encode(new Uint8Array(32).fill(7));
const TESTNET = 'https://testnet.nearblocks.io';
const LIVE = 'near-testnet';
const MOCK = 'near-mock';

describe('R39 explorer links: txHref', () => {
  it('links a real hash on a live network to <explorer>/txns/<hash>', () => {
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: HASH })).toEqual({
      kind: 'tx',
      href: `${TESTNET}/txns/${HASH}`,
    });
  });

  it('links a null hash (live activity) to <explorer>/blocks/<height>', () => {
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: null, blockHeight: 190_001 })).toEqual({
      kind: 'block',
      href: `${TESTNET}/blocks/190001`,
    });
  });

  it('prefers the tx hash over the block when both are known', () => {
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: HASH, blockHeight: 5 })?.kind).toBe('tx');
  });

  it('renders no link at all on the offline devnet (near-mock): there is no explorer for it', () => {
    expect(txHref({ network: MOCK, explorerUrl: TESTNET, hash: HASH })).toBeNull();
    expect(txHref({ network: MOCK, explorerUrl: TESTNET, hash: null, blockHeight: 9 })).toBeNull();
  });

  it('uses the configured explorer, never a hard-coded one (mainnet base, trailing slash stripped)', () => {
    expect(txHref({ network: 'near-mainnet', explorerUrl: 'https://nearblocks.io/', hash: HASH })?.href).toBe(
      `https://nearblocks.io/txns/${HASH}`,
    );
  });

  it('a null hash with no usable block height has nothing to link', () => {
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: null })).toBeNull();
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: null, blockHeight: 0 })).toBeNull();
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: null, blockHeight: -3 })).toBeNull();
    expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: null, blockHeight: 1.5 })).toBeNull();
  });

  it('never links a hash that is not a NEAR tx hash: attestation tx fields are free text from the attestor', () => {
    for (const bad of ['../../evil', 'abc?x=1', 'a/b', '', 'not a hash', `${HASH}#frag`]) {
      expect(txHref({ network: LIVE, explorerUrl: TESTNET, hash: bad })).toBeNull();
    }
  });

  it('never links through an explorer base that is not http(s)', () => {
    expect(txHref({ network: LIVE, explorerUrl: 'javascript:alert(1)//', hash: HASH })).toBeNull();
    expect(txHref({ network: LIVE, explorerUrl: '', hash: HASH })).toBeNull();
    expect(txHref({ network: LIVE, explorerUrl: undefined, hash: HASH })).toBeNull();
  });
});

describe('R39 explorer links: accountHref', () => {
  it('links an account to <explorer>/address/<id> on a live network', () => {
    expect(accountHref({ network: LIVE, explorerUrl: TESTNET, accountId: 'alice.testnet' })).toBe(
      `${TESTNET}/address/alice.testnet`,
    );
  });

  it('links nothing on near-mock, for a malformed id, or through a non-http explorer', () => {
    expect(accountHref({ network: MOCK, explorerUrl: TESTNET, accountId: 'buyer.mock' })).toBeNull();
    expect(accountHref({ network: LIVE, explorerUrl: TESTNET, accountId: '../x' })).toBeNull();
    expect(accountHref({ network: LIVE, explorerUrl: 'ftp://x', accountId: 'alice.testnet' })).toBeNull();
  });
});

describe('explorerBaseFromEnv (server-rendered docs)', () => {
  it('defaults to the testnet explorer and honours NEAR_EXPLORER_URL, NEXT_PUBLIC_NEAR_EXPLORER_URL first', () => {
    expect(DEFAULT_EXPLORER_URL).toBe(TESTNET);
    expect(explorerBaseFromEnv({})).toBe(TESTNET);
    expect(explorerBaseFromEnv({ NEAR_EXPLORER_URL: 'https://nearblocks.io' })).toBe('https://nearblocks.io');
    expect(
      explorerBaseFromEnv({ NEXT_PUBLIC_NEAR_EXPLORER_URL: 'https://a.example', NEAR_EXPLORER_URL: 'https://b.example' }),
    ).toBe('https://a.example');
    expect(explorerBaseFromEnv({ NEAR_EXPLORER_URL: '   ' })).toBe(TESTNET);
  });
});

describe('TxHash component', () => {
  const html = (props: Parameters<typeof TxHash>[0]): string => renderToStaticMarkup(createElement(TxHash, props));

  it('on a live network a hash is an external link to /txns/<hash> carrying the full hash in its tooltip', () => {
    const out = html({ hash: HASH, network: LIVE, explorerUrl: TESTNET });
    expect(out).toContain(`href="${TESTNET}/txns/${HASH}"`);
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain(`title="${HASH}"`);
  });

  it('a null hash on a live network is a block link', () => {
    const out = html({ hash: null, network: LIVE, explorerUrl: TESTNET, blockHeight: 190001 });
    expect(out).toContain(`href="${TESTNET}/blocks/190001"`);
    expect(out).toContain('block 190001');
  });

  it('on near-mock the hash is plain text: no anchor', () => {
    const out = html({ hash: HASH, network: MOCK, explorerUrl: TESTNET });
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).toContain(`title="${HASH}"`);
  });

  it('a hash the explorer cannot resolve stays text even on a live network', () => {
    const out = html({ hash: '../../evil', network: LIVE, explorerUrl: TESTNET });
    expect(out).not.toContain('<a');
    expect(out).toContain('..');
  });

  it('with nothing to show it renders a dash', () => {
    expect(html({ hash: null, network: LIVE, explorerUrl: TESTNET })).toContain('—');
    expect(html({ hash: null, network: MOCK })).toContain('—');
  });
});

describe('AccountLink component', () => {
  const html = (props: Parameters<typeof AccountLink>[0]): string =>
    renderToStaticMarkup(createElement(AccountLink, props));

  it('links to /address/<id> on a live network and shows the full id in the tooltip', () => {
    const out = html({ accountId: 'alice.testnet', network: LIVE, explorerUrl: TESTNET });
    expect(out).toContain(`href="${TESTNET}/address/alice.testnet"`);
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('title="alice.testnet"');
  });

  it('is plain text on near-mock', () => {
    const out = html({ accountId: 'buyer.mock', network: MOCK, explorerUrl: TESTNET });
    expect(out).not.toContain('<a');
    expect(out).toContain('buyer.mock');
  });

  it('shortens a 64-hex implicit account but keeps the full id in the tooltip and the link', () => {
    const implicit = 'a'.repeat(64);
    const out = html({ accountId: implicit, network: LIVE, explorerUrl: TESTNET });
    expect(out).toContain(`href="${TESTNET}/address/${implicit}"`);
    expect(out).toContain(`title="${implicit}"`);
    expect(out).toContain('…');
  });
});
