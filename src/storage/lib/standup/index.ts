import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';

/**
 * The growth team's weekly plan and daily standups (docs/growth-team.md, Part 10), per workspace. Written by the
 * background (src/background/growth-team/standup); the morning brief reads today's standup for its Team section.
 */

export interface StandupExperiment {
  // E1, E2, E3: what a "today" item names to be on plan
  id: string;
  what: string;
  metric: string;
  howWeKnow: string;
  owner: string;
}

export interface WeekPlan {
  workspaceId: string;
  // The Monday of the week, local date (YYYY-MM-DD)
  weekOf: string;
  focus: string;
  experiments: StandupExperiment[];
  // Each agent's week against the experiments, by agent id
  agentWeeks: Record<string, string>;
  at: number;
  // The model that wrote it, or why none did
  model: string;
}

export interface StandupTodayItem {
  text: string;
  experiment: string | null;
  offPlan: boolean;
  reason: string;
}

export interface StandupNote {
  agentId: string;
  agentName: string;
  did: string;
  learned: string;
  today: StandupTodayItem[];
  blocked: string;
}

export interface StandupRecord {
  workspaceId: string;
  // Local date (YYYY-MM-DD)
  day: string;
  status: 'done' | 'skipped' | 'failed';
  // Why it was skipped or failed
  reason: string | null;
  numbers: string[];
  notes: StandupNote[];
  // The Growth Lead's summary, at most 200 words, with the off-plan line code adds
  summary: string;
  offPlan: { agentName: string; text: string; reason: string }[];
  at: number;
}

export interface StandupState {
  plans: Record<string, WeekPlan>;
  // By `${workspaceId}|${day}`
  days: Record<string, StandupRecord>;
  // When a standup started, by `${workspaceId}|${day}`: the brief waits a while for one that is running
  started: Record<string, number>;
}

// Standups older than this are forgotten
const KEEP_DAYS = 21;

export const emptyStandupState = (): StandupState => ({ plans: {}, days: {}, started: {} });

export const standupKey = (workspaceId: string, day: string) => `${workspaceId}|${day}`;

const storage = createStorage<StandupState>('growth-standup', emptyStandupState(), {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

async function read(): Promise<StandupState> {
  const state = await storage.get();
  return { ...emptyStandupState(), ...(state ?? {}) };
}

async function change(edit: (state: StandupState) => void): Promise<void> {
  await serial(async () => {
    const state = await read();
    edit(state);
    await storage.set(state);
  });
}

export const standupStore = {
  ...storage,

  async plan(workspaceId: string): Promise<WeekPlan | null> {
    return (await read()).plans[workspaceId] ?? null;
  },

  async savePlan(plan: WeekPlan): Promise<void> {
    await change(state => {
      state.plans[plan.workspaceId] = plan;
    });
  },

  async day(workspaceId: string, day: string): Promise<StandupRecord | null> {
    return (await read()).days[standupKey(workspaceId, day)] ?? null;
  },

  async startedAt(workspaceId: string, day: string): Promise<number | null> {
    return (await read()).started[standupKey(workspaceId, day)] ?? null;
  },

  /** Marks today's standup as started; false when it already started or finished, so it runs once. */
  async start(workspaceId: string, day: string, now: number): Promise<boolean> {
    let fresh = false;
    await change(state => {
      const key = standupKey(workspaceId, day);
      if (state.days[key] || state.started[key]) return;
      state.started[key] = now;
      fresh = true;
    });
    return fresh;
  },

  /** Forgets a start that ended in an error, so the next try may run. */
  async unstart(workspaceId: string, day: string): Promise<void> {
    await change(state => {
      delete state.started[standupKey(workspaceId, day)];
    });
  },

  async saveDay(record: StandupRecord): Promise<void> {
    await change(state => {
      const key = standupKey(record.workspaceId, record.day);
      state.days[key] = record;
      delete state.started[key];
      // Only the last three weeks are kept
      const oldest = new Date(record.at - KEEP_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
      for (const [name, item] of Object.entries(state.days)) if (item.day < oldest) delete state.days[name];
      for (const name of Object.keys(state.started)) if (name.split('|')[1]! < oldest) delete state.started[name];
    });
  },
};
