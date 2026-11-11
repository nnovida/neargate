/**
 * The docs describe the escrow rail (Task 10b): the CLI page its commands, flags, MCP tool and
 * error codes; the contract page its methods, constant, events and the security property; the
 * security page the agent-key blast radius; the home page its roadmap. Rendered, so a section
 * that silently loses its text fails here.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CliPage from '@/app/docs/cli/page';
import ContractPage from '@/app/docs/contract/page';
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

/**
 * The blast radius is NOT only the escrow: an agent key pays its gas from the account balance, up to
 * its allowance. Every page that states the escrow-is-the-limit property must say so too.
 */
const GAS_CAVEAT = 'burn gas from the account balance up to its allowance';

describe('CLI docs page', () => {
  const page = text(CliPage);

  it('documents escrow deposit, withdraw and balance, and agent-key add with its --allowance', () => {
    for (const needle of [
      'escrow deposit <near>',
      'escrow withdraw <near>',
      'escrow balance [account]',
      'agent-key add --allowance <near>',
      '~/.near-credentials/<network>/<account>.neargate-agent.json',
      'There are eleven commands',
    ]) {
      expect(page, needle).toContain(needle);
    }
    expect(html(CliPage)).toMatch(/id="escrow"/);
    expect(html(CliPage)).toMatch(/id="agent-key"/);
  });

  it('documents buy --from-escrow and the MCP fromEscrow param and neargate_escrow_balance tool', () => {
    for (const needle of ['--from-escrow', 'fromEscrow?', 'neargate_escrow_balance { account? }']) {
      expect(page, needle).toContain(needle);
    }
  });

  it('lists the three new registry codes and the agent key codes in the error codes', () => {
    for (const code of ['ERR_ESCROW_INSUFFICIENT', 'ERR_ONE_YOCTO_REQUIRED', 'ERR_DEPOSIT_NOT_ALLOWED', 'AGENT_KEY_EXISTS', 'LIVE_ONLY', 'PRICE_MISMATCH']) {
      expect(page, code).toContain(code);
    }
    expect(html(CliPage)).toMatch(/id="codes-escrow"/);
  });

  it('says what a restricted key can do: spend the escrow and nothing else; only a full-access key withdraws', () => {
    expect(page).toContain('It can spend the escrow and nothing else');
    expect(page).toContain('only the account’s full-access key can sign it');
  });

  it('says the key can also burn gas from the account balance up to its allowance, and what a timed-out add keeps', () => {
    expect(page).toContain(GAS_CAVEAT);
    expect(page).toContain('drawn from the account balance, not the escrow');
    expect(page).toContain('the file is kept, because the key may still be added');
  });

  it('never prints a secret in its examples', () => {
    expect(page).not.toMatch(/private_key["']?\s*:\s*["']ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/);
    expect(page).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
  });
});

describe('contract docs page', () => {
  const page = text(ContractPage);

  it('documents the five new methods, the constant, the two events and the three new codes', () => {
    for (const needle of [
      'deposit_escrow()',
      'withdraw_escrow(amount: U128)',
      'pay_from_escrow(service_id: u64, nonce: String)',
      'on_escrow_withdraw',
      'escrow_of(account_id)',
      'ESCROW_STORAGE_FEE_YOCTO',
      'escrow_deposit',
      'escrow_withdraw',
      'ERR_ESCROW_INSUFFICIENT',
      'ERR_ONE_YOCTO_REQUIRED',
      'ERR_DEPOSIT_NOT_ALLOWED',
    ]) {
      expect(page, needle).toContain(needle);
    }
  });

  it('states the security property in the contract reference', () => {
    expect(page).toContain('can spend the escrow and nothing else');
    expect(page).toContain('Withdrawing needs a full-access key');
    expect(page).toContain('a leaked agent key can spend all of it, on any active service');
    expect(page).toContain('The escrow is the spending limit');
    expect(page).toContain(GAS_CAVEAT);
    expect(page).toContain('that gas comes from the account balance (not the escrow)');
  });

  it('says pay_from_escrow\'s escrow check replaces the deposit check and comes before the nonce checks', () => {
    expect(page).toContain('except that the escrow check replaces');
    expect(page).toContain('deposit check and comes before the nonce checks');
    expect(page).toMatch(/ERR_STORAGE_EXCEEDED register_service, pay, pay_from_escrow, deposit_escrow/);
  });
});

describe('security docs page', () => {
  const page = text(SecurityPage);

  it('states the agent key model and its blast radius', () => {
    for (const needle of [
      'function-call access key',
      'can spend the escrow and nothing else',
      'Withdrawing needs a full-access key',
      'a leaked agent key can spend all of it, on any active service',
      'mode 0600',
      'refuses to overwrite',
      GAS_CAVEAT,
      'drawn from the account balance, not from the escrow',
      'PRICE_MISMATCH',
    ]) {
      expect(page, needle).toContain(needle);
    }
    expect(html(SecurityPage)).toMatch(/id="agent-keys"/);
  });
});

describe('protocol docs page and home roadmap', () => {
  it('the protocol page knows pay_from_escrow proofs', () => {
    const page = text(ProtocolPage);
    expect(page).toContain('pay_from_escrow');
    expect(page).toContain('successful pay or pay_from_escrow of this nonce');
  });

  it('the roadmap ships escrow and restricted agent keys, and plans the gasless relay', () => {
    const page = text(Home);
    expect(page).toContain('Prepaid escrow · restricted agent keys');
    expect(page).toContain('NOW · shipped Prepaid escrow · restricted agent keys');
    expect(page).toContain('Planned: a buyer signs a NEP-366 delegate action');
    expect(page).toContain(GAS_CAVEAT);
  });
});
