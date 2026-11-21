import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ProductProfile } from '@extension/storage';
import type { NoteOutput, StandupWriter } from '../standup/run';

const local: Record<string, unknown> = {};
vi.hoisted(() => {
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

const { db, emptyProductProfile, emptyStandupState, productStore, standupStore } = await import('@extension/storage');
const plan = await import('../standup/plan');
const { runStandup, runStandupNow, runStandups, runWeeklyPlans } = await import('../standup/run');
type Writer = StandupWriter;

// Local times, so the test holds in any time zone: Monday 23 November 2026 and the days after
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

const suture = (): ProductProfile => ({
  ...emptyProductProfile({ id: 'suture', name: 'Suture' }),
  northStar: { metric: 'signups', weeklyTarget: 40 },
});

const agent = (id: string, template: string, name: string): AgentProfile =>
  ({
    id,
    name,
    template,
    workspaceId: 'suture',
    enabled: true,
    status: 'active',
    personalityId: null,
  }) as unknown as AgentProfile;

const onPlan = (experiment: string): NoteOutput => ({
  did: 'Queued three drafts.',
  learned: 'Threads beat single posts.',
  today: [{ text: 'Write the fix-loop thread', experiment, reason: '' }],
  blocked: '',
});

/** A scripted writer: what each model call would answer, and a count of the calls. */
function scripted(notes: (agentName: string, day: string) => NoteOutput) {
  const calls: { task: string; agent: string }[] = [];
  const writer: Writer = {
    plan: async request => {
      calls.push({ task: request.task, agent: request.agent.name });
      return {
        focus: 'Get the first 40 sign-ups from developers who run evals',
        experiments: [
          {
            what: 'A daily build-in-public thread',
            metric: 'signups',
            howWeKnow: '10 sign-ups by Friday',
            owner: 'Product Social Manager',
          },
          {
            what: 'Outreach to 20 eval engineers a day',
            metric: 'signups',
            howWeKnow: '5 replies',
            owner: 'Product Marketing Manager',
          },
          { what: 'Fix the magic link', metric: 'activation', howWeKnow: 'no sign-in issues', owner: 'Nobody here' },
          { what: 'A fourth one that does not fit', metric: 'x', howWeKnow: 'y', owner: 'Growth Lead' },
        ],
      };
    },
    text: async request => {
      calls.push({ task: request.task, agent: request.agent.name });
      return request.task === 'week'
        ? `${request.agent.name} works on E1 all week.`
        : 'Yesterday held steady. Double down on E1. The one goal today: ship the thread. Needed from you: approve the drafts.';
    },
    note: async request => {
      calls.push({ task: request.task, agent: request.agent.name });
      return notes(request.agent.name, plan.localDay(Date.now()));
    },
  };
  return { writer, calls };
}

let published: { topic: string; payload: unknown }[] = [];
const publish = async (topic: string, payload: unknown) => void published.push({ topic, payload });

beforeEach(async () => {
  for (const key of Object.keys(local)) delete local[key];
  published = [];
  await Promise.all([db.inbox, db.teamItems, db.agents, db.runs].map(table => table.clear()));
  vi.stubEnv('VITE_SEED_PROFILE', '');
  await productStore.set({ items: {}, seeds: [] } as never);
  await productStore.save(suture());
  await standupStore.set(emptyStandupState());
  await db.agents.bulkAdd([
    agent('social', 'growth_social', 'Product Social Manager'),
    agent('lead', 'growth_lead', 'Growth Lead'),
    agent('marketing', 'growth_marketing', 'Product Marketing Manager'),
  ]);
});

describe('the clock', () => {
  it('runs from 07:45 until noon, once, and skips after noon saying why', () => {
    expect(plan.standupDecision(null, null, at(23, 7, 44))).toEqual({ run: false, skip: null });
    expect(plan.standupDecision(null, null, at(23, 7, 45))).toEqual({ run: true });
    expect(plan.standupDecision(null, null, at(23, 11, 59))).toEqual({ run: true });
    expect(plan.standupDecision(null, at(23, 7, 45), at(23, 8))).toEqual({ run: false, skip: null });
    expect(plan.standupDecision(null, null, at(23, 12))).toEqual({
      run: false,
      skip: 'the browser was not open between 07:45 and 12:00',
    });
  });

  it('writes the plan on Monday from 07:30, and any later day of a week that has none', () => {
    expect(plan.planDue(null, at(23, 7, 29))).toBe(false);
    expect(plan.planDue(null, at(23, 7, 30))).toBe(true);
    expect(plan.planDue(null, at(25, 9))).toBe(true);
    const written = { weekOf: plan.weekOf(at(23, 7, 30)) } as Parameters<typeof plan.planDue>[0];
    expect(plan.planDue(written, at(27, 9))).toBe(false);
    expect(plan.planDue(written, at(30, 7, 30))).toBe(true);
  });

  it('has the brief wait for a running standup until 07:58, or 13 minutes after a late one started', () => {
    expect(plan.briefShouldWait(null, null, at(23, 7, 50))).toBe(true);
    expect(plan.briefShouldWait(null, null, at(23, 7, 58))).toBe(false);
    expect(plan.briefShouldWait(null, at(23, 9), at(23, 9, 12))).toBe(true);
    expect(plan.briefShouldWait(null, at(23, 9), at(23, 9, 13))).toBe(false);
  });
});

describe('notes and summaries within their limits', () => {
  it('cuts a long note to 80 words and keeps each "today" item tied to its experiment', () => {
    const long = Array.from({ length: 70 }, (_, index) => `word${index}`).join(' ');
    const note = plan.fitNote({
      agentId: 'a',
      agentName: 'A',
      did: long,
      learned: long,
      blocked: 'nothing',
      today: [{ text: 'Write the thread for E1', experiment: 'E1', offPlan: false, reason: '' }],
    });
    const words = [note.did, note.learned, note.blocked, ...note.today.map(item => item.text)]
      .map(plan.wordsIn)
      .reduce((sum, count) => sum + count, 0);
    expect(words).toBeLessThanOrEqual(80);
    expect(note.today[0]).toMatchObject({ experiment: 'E1', text: 'Write the thread for E1' });
  });

  it('marks an item that names no experiment as off plan, with the reason', () => {
    const experiments = [{ id: 'E1', what: 'A daily thread', metric: 'signups', howWeKnow: '', owner: '' }];
    expect(
      plan
        .markOffPlan(
          [
            { text: 'Draft today', experiment: 'e1', reason: '' },
            { text: 'Post a daily thread on X', experiment: null, reason: '' },
            { text: 'Tidy labels', experiment: 'E9', reason: 'they are a mess' },
            { text: 'Something', experiment: null, reason: '' },
          ],
          experiments,
        )
        .map(item => [item.offPlan, item.reason]),
    ).toEqual([
      [false, ''],
      [false, ''],
      [true, 'they are a mess'],
      [true, 'no reason given'],
    ]);
  });

  it('holds the summary to 200 words with the off-plan line, which names each item when more than one', () => {
    const offPlan = [
      { agentName: 'Product Social Manager', text: 'Reply on Hacker News', reason: 'a thread is trending' },
      { agentName: 'Growth Lead', text: 'Tidy the labels', reason: 'they are a mess' },
    ];
    const summary = plan.composeSummary(Array.from({ length: 400 }, () => 'word').join(' '), offPlan);
    expect(plan.wordsIn(summary)).toBeLessThanOrEqual(200);
    expect(summary).toMatch(
      /Off plan \(2\): Product Social Manager: "Reply on Hacker News".*Growth Lead: "Tidy the labels"/,
    );
    expect(plan.composeSummary('Fine.', offPlan.slice(0, 1))).toBe('Fine.');
  });
});

describe('three mornings on a fake clock', () => {
  it('plans on Monday, stands up three mornings, and names the off-plan work on the third', async () => {
    const { writer, calls } = scripted((name, day) => {
      if (day !== plan.localDay(at(25, 8))) return onPlan('E1');
      if (name === 'Product Social Manager')
        return {
          ...onPlan('E1'),
          today: [{ text: 'Reply on Hacker News threads', experiment: null, reason: 'an evals thread is trending' }],
        };
      if (name === 'Growth Lead')
        return {
          ...onPlan('E1'),
          today: [{ text: 'Tidy the issue labels', experiment: null, reason: 'labels are a mess' }],
        };
      return onPlan('E2');
    });

    // Monday: the plan at 07:30, then the standup at 07:45
    let clock = at(23, 7, 30);
    const deps = { writer, publish, now: () => clock };
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const plans = await runWeeklyPlans(deps);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.experiments.map(item => [item.id, item.owner])).toEqual([
      ['E1', 'Product Social Manager'],
      ['E2', 'Product Marketing Manager'],
      // An owner not on the team is the Lead's
      ['E3', 'Growth Lead'],
    ]);
    expect(Object.keys(plans[0]!.agentWeeks).sort()).toEqual(['lead', 'marketing', 'social']);
    // One Opus call, then each agent writes its week
    expect(calls.map(call => call.task)).toEqual(['plan', 'week', 'week', 'week']);

    const mornings = [];
    for (const day of [23, 24, 25]) {
      clock = at(day, 7, 45);
      calls.length = 0;
      const [record] = await runStandups(deps);
      expect(record, `standup on the ${day}th`).toMatchObject({ status: 'done', day: plan.localDay(clock) });
      // Four model calls a day: three notes and the summary
      expect(calls.map(call => `${call.task}:${call.agent}`)).toEqual([
        'note:Growth Lead',
        'note:Product Marketing Manager',
        'note:Product Social Manager',
        'summary:Growth Lead',
      ]);
      // A second check the same morning does nothing
      clock = at(day, 9);
      expect(await runStandups(deps)).toEqual([]);
      mornings.push(record!);
    }

    expect(mornings[0]!.offPlan).toEqual([]);
    expect(mornings[2]!.offPlan.map(item => item.agentName)).toEqual(['Growth Lead', 'Product Social Manager']);
    expect(mornings[2]!.summary).toMatch(/Off plan \(2\): Growth Lead: "Tidy the issue labels" \(labels are a mess\)/);
    expect(mornings[2]!.summary).toMatch(/Product Social Manager: "Reply on Hacker News threads"/);
    // Numbers code could not read say so, never 0
    expect(mornings[0]!.numbers.join('\n')).toMatch(/^No reading yesterday or in the last 7 days: signups, /m);

    // Each morning is in the Inbox as "Growth standup" and on the bus
    const inbox = (await db.inbox.toArray()).map(item => item.title).sort();
    expect(inbox).toEqual([
      'Growth plan · Suture · week of 2026-11-23',
      'Growth standup · Suture · 2026-11-23',
      'Growth standup · Suture · 2026-11-24',
      'Growth standup · Suture · 2026-11-25',
    ]);
    const third = (await db.inbox.toArray()).find(item => item.title.endsWith('2026-11-25'))!;
    expect(third.body).toMatch(/Reply on Hacker News threads \(off plan: an evals thread is trending\)/);
    expect(published.map(item => item.topic)).toEqual(['growth.standup', 'growth.standup', 'growth.standup']);
    vi.restoreAllMocks();
  });

  it('runs a missed standup once when the browser opens before noon, and skips it after noon saying why', async () => {
    const { writer, calls } = scripted(() => onPlan('E1'));
    let clock = at(26, 10, 30);
    const deps = { writer, publish, now: () => clock };
    vi.spyOn(Date, 'now').mockImplementation(() => clock);

    // Thursday, opened at 10:30, with no plan yet this week: the plan first, then the standup
    const late = await runStandup('suture', deps);
    expect(late).toMatchObject({ status: 'done' });
    expect(calls[0]!.task).toBe('plan');

    // Friday, opened at 13:00: skipped, once, and said in the Inbox and on the bus
    clock = at(27, 13);
    calls.length = 0;
    const skipped = await runStandup('suture', deps);
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'the browser was not open between 07:45 and 12:00' });
    expect(calls).toEqual([]);
    expect(await runStandup('suture', deps)).toBeNull();
    const friday = (await db.inbox.toArray()).find(item => item.title === 'Growth standup · Suture · 2026-11-27')!;
    expect(friday.body).toBe('Standup did not run: the browser was not open between 07:45 and 12:00.');
    expect((await standupStore.day('suture', '2026-11-27'))?.status).toBe('skipped');
    vi.restoreAllMocks();
  });

  it("runs today's standup on the user's click at any hour, still once a day", async () => {
    const { writer } = scripted(() => onPlan('E1'));
    const clock = at(28, 15);
    const deps = { writer, now: () => clock };
    expect(await runStandupNow('suture', deps)).toMatchObject({ state: 'done', record: { status: 'done' } });
    expect(await runStandupNow('suture', deps)).toMatchObject({ state: 'already' });
    await db.agents.delete('lead');
    expect(await runStandupNow('suture', { writer, now: () => at(29, 15) })).toMatchObject({ state: 'none' });
  });

  it('fails with the reason when the spending cap is reached, and does nothing without a Growth Lead', async () => {
    const { writer } = scripted(() => onPlan('E1'));
    const clock = at(23, 8);
    const capped = await runStandup('suture', { writer, now: () => clock, overCap: async () => true });
    expect(capped).toMatchObject({ status: 'failed', reason: "today's model spending reached the cap in settings" });

    await db.agents.delete('lead');
    expect(await runStandup('suture', { writer, now: () => at(24, 8) })).toBeNull();
  });
});
