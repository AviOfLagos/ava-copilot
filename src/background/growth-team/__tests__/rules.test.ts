import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '@extension/storage';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
  });
});

const { budgetState, grantRefusal, grantsInWeek, ledgerLines, spendRefusal, WEEK_MS } = await import('../ledger');
const { modeFor, offersAlways } = await import('../modes');
const { findCustomerDetails } = await import('../privacy');
const { toolRequest } = await import('../requests');

const NOW = new Date(2026, 10, 23, 9, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const RULE = { testersPerWeek: 5, days: 30, plan: 'pro' };

const grant = (daysAgo: number): LedgerEntry => ({
  id: `g${daysAgo}`,
  workspaceId: 'suture',
  kind: 'beta_grant',
  amount: 1,
  label: 'tester',
  itemId: `i${daysAgo}`,
  at: NOW - daysAgo * DAY,
});
const spend = (amount: number): LedgerEntry => ({
  id: `s${amount}`,
  workspaceId: 'suture',
  kind: 'spend',
  amount,
  label: 'a critique',
  itemId: `s${amount}`,
  at: NOW - DAY,
});

describe('the approval mode of each kind of work', () => {
  it('always asks for spending, a new channel, a new account, a plan change and a tool, even with a rule', () => {
    for (const action of ['spend', 'new_channel', 'new_account', 'plan_change', 'tool'] as const) {
      expect(modeFor(action, { namesCustomer: false, hasRule: true })).toBe('always_ask');
      expect(offersAlways(action, false)).toBe(false);
    }
  });

  it('puts posts, replies, outreach, follow-ups and listings in the batch, never on auto', () => {
    for (const action of ['post', 'reply', 'outreach_email', 'follow_up', 'listing'] as const) {
      expect(modeFor(action, { namesCustomer: false, hasRule: false })).toBe('batch');
      // A rule cannot exist for these, and one that somehow did would change nothing
      expect(modeFor(action, { namesCustomer: false, hasRule: true })).toBe('batch');
      expect(offersAlways(action, false)).toBe(false);
    }
  });

  it('runs an issue from a customer or a beta grant by itself only once the user allowed it every time', () => {
    for (const action of ['customer_issue', 'beta_grant'] as const) {
      expect(modeFor(action, { namesCustomer: false, hasRule: false })).toBe('always_ask');
      expect(modeFor(action, { namesCustomer: false, hasRule: true })).toBe('auto');
      expect(offersAlways(action, false)).toBe(true);
    }
  });

  it('asks on its own for anything that names a customer, whatever it is and whatever was allowed', () => {
    for (const action of ['post', 'customer_issue', 'beta_grant', 'reply'] as const) {
      expect(modeFor(action, { namesCustomer: true, hasRule: true })).toBe('always_ask');
      expect(offersAlways(action, true)).toBe(false);
    }
  });
});

describe('the beta rule', () => {
  it('counts a rolling week: a grant eight days old is no longer in it', () => {
    expect(grantsInWeek([grant(1), grant(6), grant(8)], NOW)).toBe(2);
    expect(grantsInWeek([{ ...grant(0), at: NOW - WEEK_MS }], NOW)).toBe(0);
  });

  it('gives the fifth place and refuses the sixth', () => {
    const four = [grant(1), grant(2), grant(3), grant(4)];
    expect(grantRefusal(RULE, four, NOW)).toBeNull();
    expect(grantRefusal(RULE, [...four, grant(5)], NOW)).toMatch(/5 testers a week and 5 were given/);
    // The oldest falls out of the week: a place opens again
    expect(grantRefusal(RULE, [grant(1), grant(2), grant(3), grant(4), grant(8)], NOW)).toBeNull();
  });

  it('gives nothing with no rule, and nothing outside the rule', () => {
    expect(grantRefusal(null, [], NOW)).toMatch(/No beta rule is set/);
    expect(grantRefusal(RULE, [], NOW, null, { plan: 'agency' })).toMatch(/outside it/);
    expect(grantRefusal(RULE, [], NOW, null, { days: 60 })).toMatch(/outside it/);
    expect(grantRefusal(RULE, [], NOW, null, { plan: 'Pro', days: 30 })).toBeNull();
  });

  it("takes the product's own count as the truth", () => {
    expect(grantRefusal(RULE, [], NOW, { remaining: 0 })).toMatch(/product itself says no beta places/);
    expect(grantRefusal(RULE, [], NOW, { remaining: 2 })).toBeNull();
  });
});

describe('the marketing budget', () => {
  const budget = { totalUsd: 100, spentUsd: 0 };

  it('adds what was agreed to what the profile says was spent before', () => {
    expect(budgetState({ totalUsd: 100, spentUsd: 10 }, [spend(30)])).toEqual({
      totalUsd: 100,
      spentUsd: 40,
      leftUsd: 60,
    });
    expect(budgetState(null, [spend(30)])).toBeNull();
  });

  it('refuses an amount past what is left, and one that is no amount', () => {
    expect(spendRefusal(budget, [spend(80)], 20)).toBeNull();
    expect(spendRefusal(budget, [spend(80)], 20.01)).toMatch(/Only \$20\.00 of the \$100\.00 budget is left/);
    expect(spendRefusal(budget, [], 0)).toMatch(/above zero/);
    expect(spendRefusal(budget, [], Number.NaN)).toMatch(/above zero/);
    expect(spendRefusal(budget, [], -5)).toMatch(/above zero/);
    expect(spendRefusal(null, [], 5)).toMatch(/No marketing budget is set/);
  });

  it('says "not set" for what is not set, never a number', () => {
    expect(ledgerLines({ budget: null, betaRule: null }, [], NOW)).toEqual({ budget: 'not set', beta: 'not set' });
    expect(ledgerLines({ budget, betaRule: RULE }, [spend(30), grant(1)], NOW)).toEqual({
      budget: '$30.00 of $100.00 spent, $70.00 left',
      beta: '1 of 5 places given in the last 7 days (pro, 30 days each)',
    });
  });
});

describe('customer details in text', () => {
  const kinds = (text: string, known: string[] = [], allowed: string[] = []) =>
    findCustomerDetails(text, known, allowed).map(finding => finding.kind);

  it('finds an email address, a phone number and a link with a user id', () => {
    expect(kinds('Reported by ada@acme.io after the upgrade')).toEqual(['email']);
    expect(kinds('Call her on +234 803 555 0142')).toEqual(['phone']);
    expect(kinds('See https://app.example.com/users/8431/settings')).toEqual(['id_link']);
    expect(kinds('See https://app.example.com/page?user_id=77')).toEqual(['id_link']);
    expect(kinds('See https://app.example.com/t/3f2c9a1e-8b7d-4c6a-9e1f-0a2b3c4d5e6f')).toEqual(['id_link']);
  });

  it('finds the names and company from the customer record, whatever their case', () => {
    expect(kinds('acme corp cannot export traces', ['Acme Corp', 'Ada'])).toEqual(['name']);
    expect(kinds('Ada says the export fails', ['Ada'])).toEqual(['name']);
    // A name inside another word is not that name, and a two-letter one is not looked for
    expect(kinds('The adapter fails', ['Ada'])).toEqual([]);
    expect(kinds('It is an AI product', ['AI'])).toEqual([]);
  });

  it('does not take a date, a version, a count or a plain link for a customer', () => {
    expect(kinds('Broken since 2026-11-21, version 1.4.2, 12 traces, see https://trysuture.com/docs')).toEqual([]);
    expect(kinds('It fails at 10:30 on 21/11/2026 for 1,200 rows')).toEqual([]);
  });

  it('lets the admin console link to the feedback through, and nothing else with an id', () => {
    const admin = 'https://admin.trysuture.com/feedback/';
    expect(kinds(`Source: ${admin}3f2c9a1e-8b7d-4c6a-9e1f-0a2b3c4d5e6f`, [], [admin])).toEqual([]);
    expect(kinds('Source: https://evil.example/feedback/3f2c9a1e-8b7d-4c6a-9e1f-0a2b3c4d5e6f', [], [admin])).toEqual([
      'id_link',
    ]);
  });
});

describe('tools, free first', () => {
  const ask = { need: 'Schedule posts', tool: 'Buffer', tried: '', steps: '', costUsd: 0, expected: '' };

  it('needs no request for what is connected or reachable in the browser', () => {
    expect(toolRequest({ ...ask, rung: 'connected' }).kind).toBe('use_it');
    expect(toolRequest({ ...ask, rung: 'browser' }).kind).toBe('use_it');
  });

  it('refuses a later rung that does not say why the earlier ones did not do', () => {
    for (const rung of ['free_api', 'free_tier', 'paid'] as const) {
      expect(toolRequest({ ...ask, rung })).toMatchObject({
        kind: 'refused',
        why: expect.stringMatching(/Free first/),
      });
    }
  });

  it('turns a free tier into a new-account request with the clicks, and refuses one without them', () => {
    const tried = 'Nothing connected schedules posts; the site has no API on the free plan.';
    expect(toolRequest({ ...ask, rung: 'free_tier', tried })).toMatchObject({ kind: 'refused' });
    expect(toolRequest({ ...ask, rung: 'free_tier', tried, steps: '1. Open buffer.com 2. Sign up' })).toMatchObject({
      kind: 'propose',
      proposal: { action: 'new_account' },
    });
    expect(toolRequest({ ...ask, rung: 'free_api', tried })).toMatchObject({
      kind: 'propose',
      proposal: { action: 'tool' },
    });
  });

  it('turns a paid tool into a spending request, never a tool request', () => {
    const tried = 'The free plan allows three posts; the site in the browser cannot schedule.';
    expect(toolRequest({ ...ask, rung: 'paid', tried, costUsd: 6, expected: 'Posts go out daily' })).toMatchObject({
      kind: 'propose',
      proposal: {
        action: 'spend',
        amountUsd: 6,
        fields: { buys: 'Buffer', triedFree: tried, expected: 'Posts go out daily' },
      },
    });
  });
});
