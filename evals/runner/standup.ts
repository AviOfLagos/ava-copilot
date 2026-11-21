import { expect, vi } from 'vitest';
import { db, emptyProductProfile, emptyStandupState, productStore, standupStore } from '@extension/storage';
import type { AgentProfile, ProductProfile } from '@extension/storage';
import { localDay } from '@src/background/growth-team/standup/plan';
import { runStandup } from '@src/background/growth-team/standup/run';
import type { StandupWriter } from '@src/background/growth-team/standup/run';
import type { StandupCase } from './cases';

const WORKSPACE = 'eval-standup';
const TEAM: [string, string][] = [
  ['growth_lead', 'Growth Lead'],
  ['growth_marketing', 'Product Marketing Manager'],
  ['growth_social', 'Product Social Manager'],
];

/**
 * Replays a standup case: the plan and each morning's notes and summary as recorded, through the standup code on a
 * clock set to that morning (local time, from Monday 23 November 2026). Checks what each morning ended as, whose
 * work is off plan, and what the summary (or, when it did not run, the Inbox) says.
 */
export async function runStandupCase(evalCase: StandupCase): Promise<void> {
  await standupStore.set(emptyStandupState());
  await db.agents.where('workspaceId').equals(WORKSPACE).delete();
  await db.agents.bulkAdd(
    TEAM.map(
      ([template, name]) =>
        ({
          id: `${WORKSPACE}:${template}`,
          name,
          template,
          workspaceId: WORKSPACE,
          enabled: true,
          status: 'active',
          personalityId: null,
        }) as unknown as AgentProfile,
    ),
  );
  const profile: ProductProfile = emptyProductProfile({ id: WORKSPACE, name: 'Eval product' });
  const forWorkspace = vi
    .spyOn(productStore, 'forWorkspace')
    .mockImplementation(async id => (id === WORKSPACE ? profile : undefined));
  try {
    expect(evalCase.expect.mornings, 'one expectation per morning').toHaveLength(evalCase.mornings.length);
    for (const [index, morning] of evalCase.mornings.entries()) {
      const want = evalCase.expect.mornings[index]!;
      const hour = Math.floor(morning.hour);
      const now = new Date(2026, 10, 23 + morning.day, hour, Math.round((morning.hour - hour) * 60)).getTime();
      const writer: StandupWriter = {
        plan: async () => evalCase.plan,
        text: async request => (request.task === 'summary' ? morning.summary : `${request.agent.name}: E1 all week.`),
        note: async request => {
          const note = morning.notes[request.agent.name];
          if (!note) throw new Error(`The case has no note for ${request.agent.name}`);
          return note;
        },
      };
      const record = await runStandup(WORKSPACE, { writer, now: () => now });
      const label = `morning ${index + 1} (${localDay(now)})`;
      expect(record?.status, label).toBe(want.status);
      expect(
        record?.offPlan.map(item => item.agentName),
        `${label}: off plan`,
      ).toEqual(want.off_plan);
      const inbox = await db.inbox
        .filter(item => item.title === `Growth standup · Eval product · ${localDay(now)}`)
        .first();
      const said = record?.summary || inbox?.body || '';
      for (const pattern of want.matches ?? []) expect(said, label).toMatch(new RegExp(pattern));
    }
  } finally {
    forWorkspace.mockRestore();
  }
}
