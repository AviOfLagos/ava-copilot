import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductProfile, TeamItem } from '@extension/storage';
import type { Proposal } from '../queue';

const local: Record<string, unknown> = {};
vi.hoisted(() => {
  // Each locale key answers with itself and what it was given, so a test can read which line was written
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join('|') },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in store()).map(k => [k, store()[k]])),
        set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
});
function store() {
  return local;
}

const { db, emptyProductProfile, permissionRulesStore, productStore, teamScope, teamStore } =
  await import('@extension/storage');
const {
  answerBatch,
  answerItem,
  clearTeamExecutorsForTests,
  propose,
  recoverAgreed,
  registerTeamExecutor,
  resultText,
} = await import('../queue');
const { TEAM_LIMITS } = await import('../modes');

const NOW = new Date(2026, 10, 23, 9, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
let clock = NOW;
const deps = { now: () => clock };

const suture = (over: Partial<ProductProfile> = {}): ProductProfile => ({
  ...emptyProductProfile({ id: 'suture', name: 'Suture' }),
  budget: { totalUsd: 100, spentUsd: 0 },
  betaRule: { testersPerWeek: 5, days: 30, plan: 'pro' },
  ...over,
});

const draft = (over: Partial<Proposal> = {}): Proposal => ({
  workspaceId: 'suture',
  agentId: 'social',
  agentName: 'Social Manager',
  action: 'post',
  title: 'Show the fix loop',
  body: 'A failing trace, the fix Suture proposed, and the eval that now passes.',
  target: 'x',
  why: "This week's experiment: show the product working",
  ...over,
});

const inbox = async () =>
  (await db.inbox.toArray()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
const open = async () => (await inbox()).filter(item => item.status !== 'done');
// What a tap on the batch row sends: the row's own request id, after the prefix
const batchTap = async () => {
  const row = (await open()).find(item => item.approval?.action === 'team_batch');
  if (!row) throw new Error('no batch row');
  return row.approval!.requestId.slice('team-batch:'.length);
};
const queued = (result: Awaited<ReturnType<typeof propose>>): TeamItem => {
  if (result.state !== 'queued') throw new Error(`expected a queued item, got ${result.state}`);
  return result.item;
};

beforeEach(async () => {
  for (const key of Object.keys(local)) delete local[key];
  clock = NOW;
  clearTeamExecutorsForTests();
  await Promise.all([db.inbox, db.teamItems, db.teamLedger].map(table => table.clear()));
  // As a public build: no owner seed adds a product behind the test's back
  vi.stubEnv('VITE_SEED_PROFILE', '');
  await productStore.set({ items: {}, seeds: [] } as never);
  await permissionRulesStore.set({ rules: [] });
  await productStore.save(suture());
});

describe('approve the batch', () => {
  it('approves a batch of drafts with one tap, and nothing goes out', async () => {
    const posted = vi.fn();
    const items: TeamItem[] = [];
    for (const [title, action] of [
      ['One', 'post'],
      ['Two', 'reply'],
      ['Three', 'post'],
    ] as const) {
      clock += 1000;
      items.push(queued(await propose(draft({ title, body: `${title} draft`, action }), deps)));
    }
    expect(items.every(item => item.mode === 'batch' && item.batchId === items[0]!.batchId)).toBe(true);

    // One row per draft, and one row that approves them all
    const rows = await open();
    expect(rows).toHaveLength(4);
    const batch = rows.find(row => row.approval?.action === 'team_batch')!;
    expect(batch.title).toBe('team_batch_title|3|Social Manager');
    expect(batch.body).toContain('1. team_action_post: One');
    expect(batch.body).toContain('2. team_action_reply: Two');
    // A batch never offers "Allow every time", and neither does a draft in it
    expect(rows.some(row => row.approval?.always)).toBe(false);

    const answered = (await answerBatch(await batchTap(), true, deps))!;
    expect(answered).toHaveLength(3);
    // Approved, and held: nothing can post yet, and nothing did
    expect((await teamStore.forWorkspace('suture')).map(item => item.status)).toEqual(['held', 'held', 'held']);
    expect(answered[0]!.note).toBe('team_note_held');
    expect(posted).not.toHaveBeenCalled();
    expect(await open()).toHaveLength(0);
  });

  it('lets each draft be answered on its own, and closes the batch row when one is left', async () => {
    const one = queued(await propose(draft({ title: 'One', body: 'First' }), deps));
    const two = queued(await propose(draft({ title: 'Two', body: 'Second' }), deps));
    const three = queued(await propose(draft({ title: 'Three', body: 'Third' }), deps));

    await answerItem(two.id, false, {}, deps);
    expect((await teamStore.get(two.id))?.status).toBe('declined');
    let batch = (await open()).find(row => row.approval?.action === 'team_batch');
    expect(batch?.title).toBe('team_batch_title|2|Social Manager');

    await answerItem(one.id, true, {}, deps);
    // One draft left: its own row is enough
    batch = (await open()).find(row => row.approval?.action === 'team_batch');
    expect(batch).toBeUndefined();
    expect((await open()).map(row => row.approval?.requestId)).toEqual([`team-item:${three.id}`]);

    // A fourth draft brings the batch row back; the declined one is not swept up by its tap
    clock += 1000;
    const four = queued(await propose(draft({ title: 'Four', body: 'Fourth' }), deps));
    await answerBatch(await batchTap(), true, deps);
    expect((await teamStore.get(two.id))?.status).toBe('declined');
    expect((await teamStore.get(three.id))?.status).toBe('held');
    expect((await teamStore.get(four.id))?.status).toBe('held');
  });

  it('approves only the drafts the row showed: one that arrived after it was drawn waits', async () => {
    queued(await propose(draft({ title: 'One', body: 'First' }), deps));
    queued(await propose(draft({ title: 'Two', body: 'Second' }), deps));
    const seen = await batchTap();
    clock += 1000;
    const late = queued(await propose(draft({ title: 'Late', body: 'Arrived after the row was drawn' }), deps));

    // The tap on the old row answers nothing; the redrawn row lists three
    expect(await answerBatch(seen, true, deps)).toBeNull();
    expect((await teamStore.forWorkspace('suture')).every(item => item.status === 'queued')).toBe(true);
    const redrawn = (await open()).find(row => row.approval?.action === 'team_batch')!;
    expect(redrawn.title).toBe('team_batch_title|3|Social Manager');
    expect(await answerBatch(await batchTap(), true, deps)).toHaveLength(3);
    expect((await teamStore.get(late.id))?.status).toBe('held');
  });

  it('keeps one item for the same thing proposed twice', async () => {
    const first = await propose(draft(), deps);
    const again = await propose(draft(), deps);
    expect(first.state).toBe('queued');
    expect(again.state).toBe('exists');
    expect(await teamStore.forWorkspace('suture')).toHaveLength(1);
    expect(resultText(again)).toMatch(/already proposed/);
  });

  it('carries an approved item out once, however many answers arrive', async () => {
    const run = vi.fn(async () => ({ ok: true as const, note: 'Filed', link: 'https://github.com/a/b/issues/1' }));
    registerTeamExecutor('customer_issue', run);
    const item = queued(
      await propose(draft({ action: 'customer_issue', title: 'Export fails', onceKey: 'fb-1' }), deps),
    );
    const answers = await Promise.all([
      answerItem(item.id, true, {}, deps),
      answerItem(item.id, true, {}, deps),
      answerItem(item.id, true, {}, deps),
    ]);
    expect(answers.filter(Boolean)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await teamStore.get(item.id)).toMatchObject({ status: 'done', link: 'https://github.com/a/b/issues/1' });
  });

  it('stops an agent that floods the Inbox', async () => {
    for (let index = 0; index < TEAM_LIMITS.queuedPerAgentPerDay; index++) {
      expect((await propose(draft({ title: `Draft ${index}`, body: `Text ${index}` }), deps)).state).toBe('queued');
    }
    const over = await propose(draft({ title: 'One too many', body: 'More' }), deps);
    expect(over).toMatchObject({ state: 'refused', why: expect.stringMatching(/At most 20 items a day/) });
    // Another agent has its own count, and tomorrow is a new day
    expect((await propose(draft({ agentId: 'marketing', agentName: 'Marketing', body: 'Other' }), deps)).state).toBe(
      'queued',
    );
    clock = NOW + DAY;
    expect((await propose(draft({ title: 'Tomorrow', body: 'Next day' }), deps)).state).toBe('queued');
  });
});

describe('always asked', () => {
  it('asks for spending on its own, with the four answers, and never offers to remember it', async () => {
    const result = await propose(
      draft({
        action: 'spend',
        title: 'A paid site critique',
        body: 'Spend $30.00 on: a paid site critique',
        amountUsd: 30,
        fields: {
          buys: 'A critique of the landing page',
          triedFree: 'Asked two design communities, one reply',
          expected: 'Sign-up rate from 2% to 3%',
        },
      }),
      deps,
    );
    const item = queued(result);
    expect(item.mode).toBe('always_ask');
    expect(item.batchId).toBeNull();
    const [row] = await open();
    expect(row).toMatchObject({ kind: 'approval', priority: 'high' });
    expect(row!.approval?.always).toBeUndefined();
    expect(row!.body).toContain('team_spend_amount: $30.00');
    expect(row!.body).toContain('team_spend_buys: A critique of the landing page');
    expect(row!.body).toContain('team_spend_triedFree: Asked two design communities, one reply');
    expect(row!.body).toContain('team_spend_expected: Sign-up rate from 2% to 3%');

    // Even answered "Allow every time", no rule is kept: the next spend is asked again
    const done = await answerItem(item.id, true, { always: true }, deps);
    expect(done).toMatchObject({ status: 'done', note: 'team_note_spendAgreed|$30.00' });
    expect(await permissionRulesStore.list()).toHaveLength(0);
    expect(await teamStore.ledger('suture')).toMatchObject([{ kind: 'spend', amount: 30, itemId: item.id }]);
  });

  it('refuses a spending request that lacks one of the four answers', async () => {
    const result = await propose(
      draft({ action: 'spend', amountUsd: 10, fields: { buys: 'Ads', triedFree: '', expected: 'More sign-ups' } }),
      deps,
    );
    expect(result).toMatchObject({ state: 'refused', why: expect.stringMatching(/Missing: triedFree/) });
    expect(await open()).toHaveLength(0);
  });

  it('refuses a request past the budget, and an approval that no longer fits it', async () => {
    const fields = { buys: 'A channel test', triedFree: 'Posted for free for a week', expected: '10 sign-ups' };
    expect(await propose(draft({ action: 'spend', amountUsd: 100.01, fields }), deps)).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/Only \$100\.00 of the \$100\.00 budget is left/),
    });
    // Two requests that each fit are both asked; together they do not fit, so the second yes is refused
    const first = queued(
      await propose(draft({ action: 'spend', title: 'First', body: 'First test', amountUsd: 60, fields }), deps),
    );
    const second = queued(
      await propose(draft({ action: 'spend', title: 'Second', body: 'Second test', amountUsd: 60, fields }), deps),
    );
    expect(await answerItem(first.id, true, {}, deps)).toMatchObject({ status: 'done' });
    expect(await answerItem(second.id, true, {}, deps)).toMatchObject({
      status: 'refused',
      note: expect.stringMatching(/Only \$40\.00 of the \$100\.00 budget is left/),
    });
    const spent = (await teamStore.ledger('suture')).reduce((sum, entry) => sum + entry.amount, 0);
    expect(spent).toBe(60);
    // The refused yes is said in the Inbox, once
    expect((await open()).filter(row => row.externalId === `team-done:${second.id}`)).toHaveLength(1);
    // Proposed again once the budget is gone, it is still the same request, not a new refusal
    expect(
      (await propose(draft({ action: 'spend', title: 'First', body: 'First test', amountUsd: 60, fields }), deps))
        .state,
    ).toBe('exists');
  });

  it('carries out a spend agreed just before the background stopped, once', async () => {
    const fields = { buys: 'A critique', triedFree: 'Asked two forums', expected: 'A clearer page' };
    const item = queued(await propose(draft({ action: 'spend', amountUsd: 30, fields }), deps));
    // The yes was written, the ledger line was not
    await teamStore.decide(item.id, 'held', '', clock);
    expect(await recoverAgreed(deps)).toBe(1);
    expect(await teamStore.get(item.id)).toMatchObject({ status: 'done' });
    expect(await teamStore.ledger('suture')).toHaveLength(1);
    expect(await recoverAgreed(deps)).toBe(0);
    expect(await teamStore.ledger('suture')).toHaveLength(1);
  });

  it('asks on its own for a new channel, a new account and a plan change, and keeps no rule for them', async () => {
    for (const action of ['new_channel', 'new_account', 'plan_change'] as const) {
      const item = queued(await propose(draft({ action, title: action, body: `Open ${action}` }), deps));
      expect(item.mode).toBe('always_ask');
      await answerItem(item.id, true, { always: true }, deps);
      expect(await teamStore.get(item.id)).toMatchObject({ status: 'done', note: 'team_note_yours' });
    }
    expect(await permissionRulesStore.list()).toHaveLength(0);
    // A rule written behind the gate's back is not honoured either
    await permissionRulesStore.set({
      rules: [
        {
          id: 'r',
          kind: 'team',
          scope: teamScope('suture', 'social', 'new_channel'),
          label: 'x',
          createdAt: 0,
          lastUsedAt: null,
          uses: 0,
        },
      ],
    });
    const again = queued(
      await propose(draft({ action: 'new_channel', title: 'Reddit', body: 'Open r/LLMDevs' }), deps),
    );
    expect(again.mode).toBe('always_ask');
  });

  it("refuses a customer's details in a post, a reply, an issue or an email, before the Inbox", async () => {
    for (const over of [
      { body: 'Thanks to ada@acme.io for the report!' },
      { body: 'Call us back on (555) 123-4567' },
      { action: 'reply' as const, body: 'Acme Corp cut eval time in half', customerNames: ['Acme Corp'] },
      { action: 'customer_issue' as const, body: 'See https://app.trysuture.com/users/8431/settings' },
      {
        action: 'outreach_email' as const,
        target: 'dev@someco.io',
        body: 'Ada from Acme Corp told us you might like it',
        customerNames: ['Ada'],
      },
    ]) {
      expect(await propose(draft({ title: over.body.slice(0, 20), ...over }), deps), over.body).toMatchObject({
        state: 'refused',
        why: expect.stringMatching(/never go in a post, an issue or an email/),
      });
    }
    expect(await teamStore.forWorkspace('suture')).toHaveLength(0);
    expect(await open()).toHaveLength(0);
  });

  it("lets an email carry the product's own address, and the recipient's in where it goes", async () => {
    await productStore.save(
      suture({ email: { from: 'hello@trysuture.com', replyTo: 'avi@trysuture.com', via: 'nexmail' } }),
    );
    const email = await propose(
      draft({
        action: 'outreach_email',
        title: 'Evals for your agent',
        body: 'Saw your post on agent evals. Reply to hello@trysuture.com to try it.',
        target: 'dev@someco.io',
      }),
      deps,
    );
    expect(email).toMatchObject({ state: 'queued', item: { mode: 'batch', namesCustomer: false } });
  });

  it('asks on its own for anything the agent says names a customer, and for a request that holds their details', async () => {
    const spend = queued(
      await propose(
        draft({
          action: 'spend',
          title: 'A user test',
          body: 'A paid call with ada@acme.io',
          amountUsd: 20,
          fields: { buys: 'One call', triedFree: 'Asked on the forum', expected: 'A clearer onboarding' },
        }),
        deps,
      ),
    );
    expect(spend).toMatchObject({ mode: 'always_ask', namesCustomer: true });
    expect((await open())[0]!.body).toContain('Found in the text: an email address.');
    const declared = queued(
      await propose(draft({ title: 'Quote', body: 'A team we work with loved it', declaredNamesCustomer: true }), deps),
    );
    expect(declared.mode).toBe('always_ask');
    const rows = await open();
    expect(rows.every(row => row.approval?.always === undefined)).toBe(true);
    expect(rows[0]!.body).toContain('team_item_namesCustomer');
  });
});

describe('auto, inside a hard limit', () => {
  const issue = (id: string, over: Partial<Proposal> = {}) =>
    draft({
      agentId: 'lead',
      agentName: 'Growth Lead',
      action: 'customer_issue',
      title: `Bug ${id}`,
      body: `What broke ${id}`,
      target: 'AviOfLagos/suture',
      onceKey: id,
      ...over,
    });

  it('asks the first time, offers "Allow every time", and then runs by itself and reports after', async () => {
    const filed: string[] = [];
    registerTeamExecutor('customer_issue', async item => {
      filed.push(item.title);
      return { ok: true, note: `Filed ${item.title}`, link: 'https://github.com/AviOfLagos/suture/issues/7' };
    });

    const first = queued(await propose(issue('fb-1'), deps));
    expect(first.mode).toBe('always_ask');
    expect((await open())[0]!.approval).toMatchObject({ always: true });
    expect(filed).toEqual([]);

    await answerItem(first.id, true, { always: true }, deps);
    expect(filed).toEqual(['Bug fb-1']);
    expect(await permissionRulesStore.find('team', teamScope('suture', 'lead', 'customer_issue'))).not.toBeNull();

    const second = await propose(issue('fb-2'), deps);
    expect(second).toMatchObject({ state: 'ran', item: { status: 'done', mode: 'auto' } });
    expect(filed).toEqual(['Bug fb-1', 'Bug fb-2']);
    // Reported after, as a result and not as a question
    const report = (await open()).find(
      row => row.externalId === `team-done:${second.state === 'ran' ? second.item.id : ''}`,
    );
    expect(report).toMatchObject({ kind: 'result', title: 'team_auto_done|Growth Lead|Bug fb-2' });
    // The same feedback again makes no second issue
    expect((await propose(issue('fb-2'), deps)).state).toBe('exists');
    expect(filed).toHaveLength(2);
    // The rule is one agent's: another agent is still asked
    expect((await propose(issue('fb-3', { agentId: 'marketing', agentName: 'Marketing' }), deps)).state).toBe('queued');
  });

  it('stops filing issues at the daily limit, even on auto', async () => {
    registerTeamExecutor('customer_issue', async () => ({ ok: true, note: 'Filed' }));
    await permissionRulesStore.allow({
      kind: 'team',
      scope: teamScope('suture', 'lead', 'customer_issue'),
      label: 'issues',
    });
    for (let index = 0; index < TEAM_LIMITS.customerIssuesPerDay; index++) {
      expect((await propose(issue(`fb-${index}`), deps)).state).toBe('ran');
    }
    expect(await propose(issue('fb-over'), deps)).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/At most 10 issues a day/),
    });
  });

  it('refuses a grant beyond the weekly beta limit, asked or on auto', async () => {
    const grantOf = (id: string) =>
      draft({
        agentId: 'lead',
        agentName: 'Growth Lead',
        action: 'beta_grant',
        title: `Tester ${id}`,
        body: `Access request ${id}`,
        onceKey: id,
      });
    await permissionRulesStore.allow({ kind: 'team', scope: teamScope('suture', 'lead', 'beta_grant'), label: 'beta' });

    // Five places in the rule: five go through, each written to the ledger
    for (let index = 1; index <= 5; index++) {
      clock = NOW + index * 60_000;
      expect(await propose(grantOf(`r${index}`), deps)).toMatchObject({ state: 'ran', item: { status: 'held' } });
    }
    expect(await teamStore.ledger('suture')).toHaveLength(5);

    // The sixth is refused by code, and nothing is written
    clock = NOW + 10 * 60_000;
    const sixth = await propose(grantOf('r6'), deps);
    expect(sixth).toMatchObject({ state: 'refused', why: expect.stringMatching(/5 testers a week and 5 were given/) });
    expect(resultText(sixth)).toMatch(/Refused by a rule in code/);
    expect(await teamStore.ledger('suture')).toHaveLength(5);

    // A week on, the places are open again
    clock = NOW + 8 * DAY;
    expect((await propose(grantOf('r7'), deps)).state).toBe('ran');
  });

  it('refuses a yes that arrives after the last place went', async () => {
    const grantOf = (id: string) =>
      draft({
        agentId: 'lead',
        agentName: 'Growth Lead',
        action: 'beta_grant',
        title: `Tester ${id}`,
        body: `Access request ${id}`,
        onceKey: id,
      });
    // Six requests wait at once (no rule, so each is asked): only five of the yeses can stand
    const waiting: TeamItem[] = [];
    for (let index = 1; index <= 6; index++) waiting.push(queued(await propose(grantOf(`w${index}`), deps)));
    const results = await Promise.all(waiting.map(item => answerItem(item.id, true, {}, deps)));
    expect(results.filter(item => item?.status === 'held')).toHaveLength(5);
    expect(results.filter(item => item?.status === 'refused')).toHaveLength(1);
    expect(await teamStore.ledger('suture')).toHaveLength(5);
  });

  it('gives no place when the product has no beta rule, or says none is left', async () => {
    const grantOf = draft({ action: 'beta_grant', title: 'Tester', body: 'Access request', onceKey: 'x1' });
    await productStore.save(suture({ betaRule: null }));
    expect(await propose(grantOf, deps)).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/No beta rule is set/),
    });
    // The rule the product itself enforces stands in for one that was never typed in
    const remote = {
      ...deps,
      remoteGrants: async () => ({ remaining: 3, rule: { testersPerWeek: 5, days: 30, plan: 'pro' } }),
    };
    expect((await propose(grantOf, remote)).state).toBe('queued');
    await productStore.save(suture());
    const none = { ...deps, remoteGrants: async () => ({ remaining: 0 }) };
    expect(await propose({ ...grantOf, onceKey: 'x2' }, none)).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/product itself says no beta places/),
    });
  });

  it('never runs by itself an item that names a customer, rule or not', async () => {
    const run = vi.fn(async () => ({ ok: true as const, note: 'Filed' }));
    registerTeamExecutor('customer_issue', run);
    await permissionRulesStore.allow({
      kind: 'team',
      scope: teamScope('suture', 'lead', 'customer_issue'),
      label: 'issues',
    });
    // Found by code: refused outright
    const found = await propose(
      issue('fb-9', { body: 'Ada at Acme Corp cannot sign in', customerNames: ['Ada', 'Acme Corp'] }),
      deps,
    );
    expect(found.state).toBe('refused');
    // Only said by the agent: asked, never on auto
    const said = await propose(issue('fb-10', { declaredNamesCustomer: true }), deps);
    expect(said).toMatchObject({ state: 'queued', item: { mode: 'always_ask', namesCustomer: true } });
    expect(run).not.toHaveBeenCalled();
  });

  it("counts grants agreed here against the product's own places until the product has them", async () => {
    await permissionRulesStore.allow({ kind: 'team', scope: teamScope('suture', 'lead', 'beta_grant'), label: 'beta' });
    // The rule allows five, the product says one is left
    const oneLeft = { ...deps, remoteGrants: async () => ({ remaining: 1 }) };
    const grantOf = (id: string) =>
      draft({ agentId: 'lead', action: 'beta_grant', title: `Tester ${id}`, body: `Access ${id}`, onceKey: id });
    expect(await propose(grantOf('p1'), oneLeft)).toMatchObject({ state: 'ran', item: { status: 'held' } });
    // Still "1 left" in the product, since nothing carried the first one out there: the second is refused
    expect(await propose(grantOf('p2'), oneLeft)).toMatchObject({
      state: 'refused',
      why: expect.stringMatching(/product itself says no beta places/),
    });
    // Once the first is carried out, the product's count already has it
    const [first] = await teamStore.forWorkspace('suture');
    await teamStore.update(first!.id, { status: 'done' });
    const zeroLeft = { ...deps, remoteGrants: async () => ({ remaining: 0 }) };
    expect((await propose(grantOf('p3'), oneLeft)).state).toBe('ran');
    expect((await propose(grantOf('p4'), zeroLeft)).state).toBe('refused');
  });

  it('refuses a grant whose length is not a number, or outside the rule', async () => {
    const grantOf = (days: string) =>
      draft({ action: 'beta_grant', title: 'Tester', body: `Access ${days}`, onceKey: days, fields: { days } });
    expect((await propose(grantOf('thirty'), deps)).state).toBe('refused');
    expect((await propose(grantOf('60'), deps)).state).toBe('refused');
    expect((await propose(grantOf('30'), deps)).state).toBe('queued');
  });

  it('does not try a broken step again, and says the outcome is unknown', async () => {
    const run = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    registerTeamExecutor('customer_issue', run);
    const item = queued(await propose(issue('fb-10'), deps));
    expect(await answerItem(item.id, true, {}, deps)).toMatchObject({
      status: 'failed',
      note: 'team_note_unknownOutcome',
    });
    expect(await answerItem(item.id, true, {}, deps)).toBeNull();
    expect((await propose(issue('fb-10'), deps)).state).toBe('exists');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('what an item needs', () => {
  it('refuses work for a workspace with no product, and a draft with no text', async () => {
    expect(await propose(draft({ workspaceId: 'nowhere' }), deps)).toMatchObject({ state: 'refused' });
    expect(await propose(draft({ body: '   ' }), deps)).toMatchObject({ state: 'refused' });
  });
});
