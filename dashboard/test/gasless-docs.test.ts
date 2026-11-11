/**
 * The docs describe the gasless rail (Task 10c, ruling R58): the protocol page its offer, its
 * payload, the gateway's checks and their 402 errors; the CLI page `buy --gasless`, the MCP
 * `gasless` param and the new codes; the security page the relayer's exposure, what the gateway
 * refuses and the front-running note; the home roadmap ships it. Rendered, so a section that
 * silently loses its text fails here.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CliPage from '@/app/docs/cli/page';
import ProtocolPage from '@/app/docs/protocol/page';
import SecurityPage from '@/app/docs/security/page';
import Home from '@/app/page';

const html = (page: () => React.JSX.Element): string => renderToStaticMarkup(createElement(page));
/** Text only: tags dropped, entities decoded, whitespace collapsed. */
const text = (page: () => React.JSX.Element): string =>
  html(page)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** Every 402 error the delegate rail can answer, in the gateway's order. */
const DELEGATE_ERRORS = [
  'relayer_disabled',
  'delegate_malformed',
  'delegate_wrong_sender',
  'delegate_wrong_receiver',
  'delegate_wrong_action',
  'delegate_wrong_args',
  'delegate_deposit_not_zero',
  'delegate_gas_too_high',
  'delegate_gas_too_low',
  'delegate_expired',
  'delegate_nonce_too_large',
  'bad_signature',
  'unknown_key',
  'key_not_allowed',
  'stale_nonce',
  'escrow_insufficient',
  'relay_failed',
];

describe('protocol docs page: the gasless rail', () => {
  const page = text(ProtocolPage);

  it('documents the offer in the 402 and the delegate payload', () => {
    for (const needle of [
      'extra.relayer / relayMethod',
      'RELAYER_ENABLED',
      'kind: "delegate"',
      'signedDelegate',
      'NEP-366',
      '{"service_id":<id>,"nonce":"<nonce>"}',
      'at most 4096 bytes',
      'the signing key’s nonce + 1',
    ]) {
      expect(page, needle).toContain(needle);
    }
    expect(html(ProtocolPage)).toMatch(/id="gasless"/);
    expect(page).not.toContain('reserved for a gasless rail that is not enabled');
  });

  it('lists every check of the delegate rail with its 402 error, and what a pending relay carries', () => {
    for (const code of DELEGATE_ERRORS) expect(page, code).toContain(code);
    expect(page).toContain('Every refusal comes before the relay');
    expect(page).toContain('the relay tx, in transaction');
    expect(html(ProtocolPage)).toMatch(/id="gasless-checks"/);
  });
});

describe('CLI docs page: buy --gasless', () => {
  const page = text(CliPage);

  it('documents --gasless, the receipt line, the MCP gasless param and the new codes', () => {
    for (const needle of [
      '--gasless',
      'implies --from-escrow',
      'relayed: gasless — <relayer> relayed the signed pay_from_escrow and paid the gas',
      'gasless?',
      'RELAYER_UNAVAILABLE',
      'GASLESS_NOT_SERVED',
    ]) {
      expect(page, needle).toContain(needle);
    }
  });
});

describe('security docs page: the relayer', () => {
  const page = text(SecurityPage);

  it('states the relayer exposure, what the gateway refuses and the front-running note', () => {
    for (const needle of [
      'The relayer’s exposure is gas only',
      'one zero-deposit pay_from_escrow',
      'bad_signature',
      'stale_nonce',
      'nothing a third party can redeem is public',
      'After a relay timeout the payment is public on chain',
      'the same front-running residual as the tx rails',
    ]) {
      expect(page, needle).toContain(needle);
    }
    expect(html(SecurityPage)).toMatch(/id="relayer"/);
  });
});

describe('home roadmap', () => {
  it('ships the gasless rail', () => {
    const page = text(Home);
    expect(page).toContain('NOW · shipped Gasless payments (NEP-366)');
    expect(page).not.toContain('Planned: a buyer signs');
  });
});
