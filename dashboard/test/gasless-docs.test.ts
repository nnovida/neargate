/**
 * The docs describe the gasless rail (Task 10c, ruling R58): the protocol page its offer, its
 * payload, the gateway's checks and their 402 errors; the CLI page `buy --gasless`, the MCP
 * `gasless` param and the new codes; the security page the relayer's exposure, what the gateway
 * refuses and the front-running note; the home roadmap ships it. Rendered, so a section that
 * silently loses its text fails here.
 */
import { DELEGATE_RAIL_ERRORS } from '@agentgate/middleware';
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

/** The relay_failed codes the gateway answers of its own (the registry's ERR_* aside). */
const RELAY_FAILED_CODES = ['DELEGATE_REJECTED', 'RELAYER_ERROR'];

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
      'of at most 4096 bytes once decoded (a larger one is refused invalid_payment_header',
      'the signing key’s nonce + 1, read at optimistic finality',
    ]) {
      expect(page, needle).toContain(needle);
    }
    expect(html(ProtocolPage)).toMatch(/id="gasless"/);
    expect(page).not.toContain('reserved for a gasless rail that is not enabled');
  });

  it('lists every check of the delegate rail with its 402 error, and what a pending relay carries', () => {
    // The gateway's own list (middleware DELEGATE_RAIL_ERRORS): a new refusal must be documented.
    expect(DELEGATE_RAIL_ERRORS.length).toBeGreaterThan(10);
    for (const code of DELEGATE_RAIL_ERRORS) expect(page, code).toContain(code);
    for (const code of RELAY_FAILED_CODES) expect(page, code).toContain(code);
    expect(page).toContain('Refusals 1–8 cost the relayer nothing: they come before the relay.');
    expect(page).toContain('relay_failed costs at most one relay’s gas');
    expect(page).not.toContain('Every refusal comes before the relay');
    expect(page).toContain('the relay tx, in transaction');
    expect(html(ProtocolPage)).toMatch(/id="gasless-checks"/);
  });

  it('says the clients re-present a pending delegate on their own, and what a gateway restart forgets', () => {
    for (const needle of [
      'Retry-After clamped to 1–10 s',
      'it waits at most 150 s in all',
      'a gateway restart forgets them',
      'read the escrow balance before buying again',
    ]) {
      expect(page, needle).toContain(needle);
    }
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

  it('says buy re-presents while the relay settles, and advises only what the CLI can do', () => {
    for (const needle of [
      // The CLI's own line, ASCII apostrophe included (formatGaslessWait in packages/cli/src/buy.ts).
      "waiting: the gateway's relay (tx <tx hash>, <explorer>/txns/<tx hash>) is settling",
      'for at most 150 s; it prints one waiting: line on stderr',
      'escrowPaid',
      'neargate escrow balance before buying again: buying again signs a NEW payment',
      'always check the escrow balance before buying again: it can mean the gateway’s relay landed before the gateway restarted',
      'DELEGATE_REJECTED',
      'RELAYER_ERROR',
      'points at the relay tx and neargate_escrow_balance',
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
      'Between the relay landing and the burn the payment is already public on chain; the protection there is invoice_used for anything this gateway process did not relay.',
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
