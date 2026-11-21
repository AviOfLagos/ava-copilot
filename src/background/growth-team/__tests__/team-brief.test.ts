import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, StandupRecord } from '@extension/storage';
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
const { teamPending, teamSectionOf, teamSections, teamSectionText } = await import('../standup/brief');
const { runStandup } = await import('../standup/run');

/**
 * The Team section of the morning brief (docs/growth-team.md, Part 5b, issue #78): the standup's summary on days it
 * ran, "Standup did not run: <reason>" on days it did not, and the brief waiting while it runs.
 */

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

const record = (over: Partial<StandupRecord>): StandupRecord => ({
  workspaceId: 'suture',
  day: '2026-11-23',
  status: 'done',
  reason: null,
  numbers: [],
  notes: [],
  summary: 'Sign-ups held. Double down on E1. The one goal today: ship the thread. Needed from you: approve 3 drafts.',
  offPlan: [],
  at: at(23, 7, 50),
  ...over,
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
    createdAt: 0,
  }) as unknown as AgentProfile;

const note: NoteOutput = {
  did: 'Queued drafts.',
  learned: 'Threads work.',
  today: [{ text: 'Write the thread', experiment: 'E1', reason: '' }],
  blocked: '',
};
const writer: StandupWriter = {
  plan: async () => ({
    focus: 'First sign-ups',
    experiments: [{ what: 'A daily thread', metric: 'signups', howWeKnow: '10 sign-ups', owner: 'Growth Lead' }],
  }),
  text: async request =>
    request.task === 'summary' ? 'Quiet day. Double down on E1. Needed from you: nothing.' : 'E1.',
  note: async () => note,
};

beforeEach(async () => {
  for (const key of Object.keys(local)) delete local[key];
  await Promise.all([db.inbox, db.agents].map(table => table.clear()));
  vi.stubEnv('VITE_SEED_PROFILE', '');
  await productStore.set({ items: {}, seeds: [] } as never);
  await productStore.save(emptyProductProfile({ id: 'suture', name: 'Suture' }));
  await standupStore.set(emptyStandupState());
  await db.agents.bulkAdd([
    agent('lead', 'growth_lead', 'Growth Lead'),
    agent('social', 'growth_social', 'Product Social Manager'),
  ]);
});

describe('what the Team section says', () => {
  it("is the Growth Lead's summary on a day the standup ran, within 200 words", () => {
    expect(teamSectionText(record({}), null, at(23, 8))).toMatch(/^Sign-ups held\. Double down on E1/);
    const long = record({ summary: Array.from({ length: 260 }, () => 'word').join(' ') });
    expect(teamSectionText(long, null, at(23, 8)).split(/\s+/).length).toBeLessThanOrEqual(200);
    // A summary the model left empty still says something
    expect(teamSectionText(record({ summary: '  ' }), null, at(23, 8))).toBe('brief_team_empty');
  });

  it('says the standup did not run, and why, on every other day', () => {
    const skipped = record({ status: 'skipped', reason: 'the browser was not open between 07:45 and 12:00' });
    expect(teamSectionText(skipped, null, at(23, 13))).toBe(
      'brief_team_notRun|the browser was not open between 07:45 and 12:00',
    );
    const failed = record({ status: 'failed', reason: "today's model spending reached the cap in settings" });
    expect(teamSectionText(failed, null, at(23, 8))).toMatch(/^brief_team_notRun\|today's model spending/);
    // Not run yet: a brief before 07:45, one while it runs, one while the browser was closed at 07:45, one after noon
    expect(teamSectionText(null, null, at(23, 7))).toBe('brief_team_notRun|brief_team_later');
    expect(teamSectionText(null, at(23, 7, 45), at(23, 7, 59))).toMatch(/^brief_team_notRun\|brief_team_running\|/);
    expect(teamSectionText(null, null, at(23, 9))).toBe('brief_team_notRun|brief_team_notOpen');
    expect(teamSectionText(null, null, at(23, 13))).toBe('brief_team_notRun|brief_team_skipped');
    // A start the background lost an hour ago is not "still running"
    expect(teamSectionText(null, at(23, 8), at(23, 9))).toBe('brief_team_notRun|brief_team_notOpen');
  });
});

describe('the Team section in the brief, on a fake clock', () => {
  it('appears on days the standup ran and explains itself on days it did not', async () => {
    // Monday: the standup runs at 07:45, the brief at 08:00 shows its summary
    expect(await runStandup('suture', { writer, now: () => at(23, 7, 45) })).toMatchObject({ status: 'done' });
    expect(await teamSections(at(23, 8))).toEqual([
      {
        title: 'brief_team_title|Suture',
        markdown: 'Quiet day. Double down on E1. Needed from you: nothing.',
        workspaceId: 'suture',
      },
    ]);
    // Tuesday: the browser opened at 13:00, so the standup was skipped and the section says why
    expect(await runStandup('suture', { writer, now: () => at(24, 13) })).toMatchObject({ status: 'skipped' });
    expect((await teamSections(at(24, 13, 5)))[0]!.markdown).toBe(
      'brief_team_notRun|the browser was not open between 07:45 and 12:00',
    );
    // A workspace with no Growth Lead switched on has no Team section
    await db.agents.delete('lead');
    expect(await teamSections(at(25, 8))).toEqual([]);
  });

  it('has the brief wait while the standup runs, until 07:58', async () => {
    expect(await teamPending(at(23, 7, 50))).toBe(true);
    expect(await teamPending(at(23, 7, 58))).toBe(false);
    // A late standup that started at 09:00 is waited for 13 minutes, then the brief comes without it
    await standupStore.start('suture', '2026-11-23', at(23, 9));
    expect(await teamPending(at(23, 9, 5))).toBe(true);
    expect(await teamPending(at(23, 9, 14))).toBe(false);
    // Once it has ended, nothing to wait for
    await standupStore.saveDay(record({ at: at(23, 9, 6) }));
    expect(await teamPending(at(23, 9, 7))).toBe(false);
  });

  it('gives a standup that ended after the brief its own section, to add to the brief', async () => {
    const section = await teamSectionOf(record({}));
    expect(section).toEqual({
      title: 'brief_team_title|Suture',
      markdown: expect.stringMatching(/^Sign-ups held/),
      workspaceId: 'suture',
    });
  });
});
