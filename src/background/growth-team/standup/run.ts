import { z } from 'zod';
import { toAppError } from '@extension/shared';
import {
  db,
  growthStore,
  productStore,
  shiftDay,
  STALE_START_MS,
  standupStore,
  teamStore,
  utcDay,
} from '@extension/storage';
import type { AgentProfile, ProductProfile, StandupNote, StandupRecord, WeekPlan } from '@extension/storage';
import { PRODUCT_METRICS } from '../../growth/collect';
import { queryMetric } from '../../growth/query';
import { addInboxItem } from '../../inbox/store';
import { inventedNumbers, knownNumbers, rememberShown } from '../social/facts';
import {
  composeSummary,
  fitNote,
  fitWords,
  localDay,
  markOffPlan,
  MAX_EXPERIMENTS,
  MAX_TODAY,
  NOTE_WORDS,
  noteText,
  offPlanItems,
  planDue,
  planText,
  standupDecision,
  STANDUP_MINUTE,
  SUMMARY_WORDS,
  weekOf,
} from './plan';

/**
 * The weekly plan and the daily standup (docs/growth-team.md, Part 10). Code reads the numbers, keeps the clock,
 * holds every text to its limit and marks off-plan work; the models write only the plan, the notes and the
 * summary. The writer is passed in, so tests run the whole morning with no model and a fake clock.
 */

export const GROWTH_TEAM_TEMPLATES = ['growth_lead', 'growth_marketing', 'growth_social'] as const;

export const planSchema = z.object({
  focus: z.string().describe('the one focus of the week, one sentence'),
  experiments: z
    .array(
      z.object({
        what: z.string().describe('what we try'),
        metric: z.string().describe('the number it should move, by its metric name'),
        howWeKnow: z.string().describe('how we will know by Friday'),
        owner: z.string().describe("the owning agent's name"),
      }),
    )
    .describe('at most three'),
});
export type PlanOutput = z.infer<typeof planSchema>;

export const noteSchema = z.object({
  did: z.string(),
  learned: z.string(),
  today: z
    .array(
      z.object({
        text: z.string(),
        experiment: z.string().nullable().describe('the id of the experiment it serves (E1, E2, E3), or null'),
        reason: z.string().describe('why, when it serves none of them'),
      }),
    )
    .describe(`at most ${MAX_TODAY}`),
  blocked: z.string(),
});
export type NoteOutput = z.infer<typeof noteSchema>;

export type WriterTask = 'plan' | 'week' | 'note' | 'summary';

export interface WriterRequest {
  task: WriterTask;
  agent: AgentProfile;
  system: string;
  prompt: string;
}

/** The model calls, one per request. Plan: Opus; the rest: the agent's own daily model. */
export interface StandupWriter {
  plan(request: WriterRequest): Promise<PlanOutput>;
  text(request: WriterRequest): Promise<string>;
  note(request: WriterRequest): Promise<NoteOutput>;
}

export interface StandupDeps {
  now?: () => number;
  writer: StandupWriter;
  publish?: (topic: string, payload: unknown, options: { fromAgentId: string | null; id: string }) => Promise<void>;
  // Whether today's model spending is over the user's cap
  overCap?: () => Promise<boolean>;
  // Called with each finished or skipped standup (the morning brief adds its Team section)
  finished?: (record: StandupRecord) => Promise<void>;
}

const startOfLocalDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** A reason the standup stops that code wrote, safe to show as it is. */
class StandupStop extends Error {}

/** A start still running, or null for none or one the background lost. */
const liveStart = (started: number | null, now: number) =>
  started !== null && now - started < STALE_START_MS ? started : null;

/** A workspace's growth agents that are switched on, the Growth Lead first. */
export async function teamOf(workspaceId: string): Promise<AgentProfile[]> {
  const agents = await db.agents
    .filter(
      agent =>
        agent.workspaceId === workspaceId &&
        GROWTH_TEAM_TEMPLATES.includes(agent.template as (typeof GROWTH_TEAM_TEMPLATES)[number]) &&
        agent.enabled &&
        agent.status !== 'draft',
    )
    .toArray();
  return agents.sort(
    (a, b) =>
      GROWTH_TEAM_TEMPLATES.indexOf(a.template as (typeof GROWTH_TEAM_TEMPLATES)[number]) -
      GROWTH_TEAM_TEMPLATES.indexOf(b.template as (typeof GROWTH_TEAM_TEMPLATES)[number]),
  );
}

/** The workspaces whose Growth Lead is switched on. */
export async function standupWorkspaces(): Promise<string[]> {
  const leads = await db.agents
    .filter(agent => agent.template === 'growth_lead' && agent.enabled && agent.status !== 'draft')
    .toArray();
  return [...new Set(leads.map(lead => lead.workspaceId).filter((id): id is string => Boolean(id)))];
}

/** Yesterday and the last 7 days of every product number, read by code. A number not read says "no reading". */
export async function standupNumbers(profile: ProductProfile, now: number): Promise<string[]> {
  // The product's numbers are kept by UTC day (growth/collect.ts): "yesterday" is the last whole UTC day
  const yesterday = shiftDay(utcDay(now), -1);
  const lines: string[] = [];
  const unread: string[] = [];
  const shown: (number | null)[] = [];
  for (const metric of PRODUCT_METRICS) {
    const [day, week] = await Promise.all([
      queryMetric(growthStore, { productId: profile.workspaceId, metric, from: yesterday, to: yesterday }),
      queryMetric(growthStore, {
        productId: profile.workspaceId,
        metric,
        from: shiftDay(yesterday, -6),
        to: yesterday,
      }),
    ]);
    shown.push(day.total, week.total);
    // A number never read in the week is listed once with the others, so the standup stays short
    if (day.total === null && week.total === null) {
      unread.push(metric);
      continue;
    }
    const say = (total: number | null, atLeast: boolean) =>
      total === null ? 'no reading' : `${atLeast ? 'at least ' : ''}${total}`;
    lines.push(
      `${metric}: yesterday ${say(day.total, day.atLeast)}; last 7 days ${say(week.total, week.atLeast)} (${week.daysRead} of 7 days read)`,
    );
  }
  if (unread.length) lines.push(`No reading yesterday or in the last 7 days: ${unread.join(', ')}`);
  rememberShown(profile.workspaceId, shown, now);
  return lines;
}

/** What an agent did yesterday, from its own records: the drafts it queued and its runs. */
async function yesterdayOf(agent: AgentProfile, now: number): Promise<string> {
  const end = startOfLocalDay(now);
  const start = startOfLocalDay(end - 12 * 60 * 60_000);
  const items = (await teamStore.forWorkspace(agent.workspaceId ?? ''))
    .filter(item => item.agentId === agent.id && item.createdAt >= start && item.createdAt < end)
    .map(item => `- ${item.action} "${item.title}" (${item.status})`);
  const runs = (await db.runs.where('startedAt').between(start, end, true, false).toArray())
    .filter(run => run.agentId === agent.id)
    // The kind of error only: a message may carry what a page or a provider said
    .map(run => `- run ${run.status}${run.error ? ` (${run.error.kind})` : ''}`);
  return [...items, ...runs].join('\n') || 'No drafts and no runs yesterday.';
}

function quoteData(text: string): string {
  // What agents and customers wrote is data: no tags that could close the block
  return `<data>\n${text.replace(/[<>]/g, ' ')}\n</data>`;
}

const RULES =
  'Every number comes from the numbers below; a number that says "no reading" was not read and is never 0. Never name or quote a customer. Plain words, no greetings.';

// One plan at a time per workspace: the Monday job and a late standup may both ask for it at startup
const planning = new Map<string, Promise<WeekPlan | null>>();

/** This week's plan, written now when it is due; asked twice at once, it is written once. */
export function planFor(workspaceId: string, deps: StandupDeps): Promise<WeekPlan | null> {
  const running = planning.get(workspaceId);
  if (running) return running;
  const work = (async () => {
    const plan = await standupStore.plan(workspaceId);
    // This week's plan, whatever the hour: on Monday before 07:30 last week's is not this week's
    if (plan && plan.weekOf === weekOf(deps.now?.() ?? Date.now())) return plan;
    return writeWeeklyPlan(workspaceId, deps);
  })().finally(() => planning.delete(workspaceId));
  planning.set(workspaceId, work);
  return work;
}

/** Sets the week's focus and at most three experiments, then each agent writes its week against them. */
async function writeWeeklyPlan(workspaceId: string, deps: StandupDeps): Promise<WeekPlan | null> {
  const now = deps.now?.() ?? Date.now();
  const team = await teamOf(workspaceId);
  const lead = team.find(agent => agent.template === 'growth_lead');
  const profile = await productStore.forWorkspace(workspaceId);
  if (!lead || !profile) return null;
  const previous = await standupStore.plan(workspaceId);
  const numbers = await standupNumbers(profile, now);
  const lastWeek = previous ? planText(previous) : 'No plan last week.';
  const output = await deps.writer.plan({
    task: 'plan',
    agent: lead,
    system: `You are ${lead.name}, the Growth Lead of ${profile.name}. Set this week's plan: one focus and at most ${MAX_EXPERIMENTS} experiments, each with what we try, the number it should move, how we will know by Friday, and the owner (one of: ${team.map(agent => agent.name).join(', ')}). Favour what last week's numbers say works. ${RULES}`,
    prompt: `Numbers:\n${numbers.join('\n')}\n\nLast week's plan:\n${quoteData(lastWeek)}\n\nNorth star: ${profile.northStar?.metric ?? 'not set'}.`,
  });
  const names = new Map(team.map(agent => [agent.name.toLowerCase(), agent.name]));
  const plan: WeekPlan = {
    workspaceId,
    weekOf: weekOf(now),
    focus: fitWords(output.focus, 40),
    experiments: output.experiments.slice(0, MAX_EXPERIMENTS).map((experiment, index) => ({
      id: `E${index + 1}`,
      what: fitWords(experiment.what, 30),
      metric: fitWords(experiment.metric, 8),
      howWeKnow: fitWords(experiment.howWeKnow, 30),
      // An owner who is not on the team is the Lead's
      owner: names.get(experiment.owner.trim().toLowerCase()) ?? lead.name,
    })),
    agentWeeks: {},
    at: now,
    model: 'plan',
  };
  for (const agent of team) {
    const week = await deps.writer.text({
      task: 'week',
      agent,
      system: `You are ${agent.name} at ${profile.name}. Write your week against the plan in at most ${NOTE_WORDS} words: what you will do, each line naming the experiment it serves (E1, E2, E3). ${RULES}`,
      prompt: quoteData(planText(plan)),
    });
    plan.agentWeeks[agent.id] = fitWords(week, NOTE_WORDS);
  }
  await standupStore.savePlan(plan);
  await addInboxItem({
    source: 'system',
    externalId: `growth-plan:${workspaceId}:${plan.weekOf}`,
    kind: 'result',
    title: `Growth plan · ${profile.name} · week of ${plan.weekOf}`,
    body: [planText(plan), ...team.map(agent => `${agent.name}\n${plan.agentWeeks[agent.id] ?? ''}`)].join('\n\n'),
    priority: 'low',
    workspaceId,
    agentId: lead.id,
  });
  return plan;
}

async function postStandup(record: StandupRecord, profile: ProductProfile, leadId: string, deps: StandupDeps) {
  const body =
    record.status === 'done'
      ? [record.summary, `Numbers\n${record.numbers.join('\n')}`, ...record.notes.map(noteText)].join('\n\n')
      : `Standup did not run: ${record.reason}.`;
  await addInboxItem({
    source: 'system',
    externalId: `growth-standup:${record.workspaceId}:${record.day}`,
    kind: 'result',
    title: `Growth standup · ${profile.name} · ${record.day}`,
    body,
    priority: record.offPlan.length > 1 || record.status !== 'done' ? 'high' : 'low',
    workspaceId: record.workspaceId,
    agentId: leadId,
  });
  await deps
    .publish?.(
      'growth.standup',
      {
        workspaceId: record.workspaceId,
        day: record.day,
        status: record.status,
        reason: record.reason,
        summary: record.summary,
        offPlan: record.offPlan,
      },
      { fromAgentId: leadId, id: `standup:${record.workspaceId}:${record.day}` },
    )
    .catch(() => undefined);
  await deps.finished?.(record).catch(() => undefined);
}

/**
 * Today's standup for one workspace, if it is due: once a day from 07:45, or once before noon when the browser
 * opens late; after noon it is skipped and says why. Returns the record it wrote, or null when it did nothing.
 */
export async function runStandup(
  workspaceId: string,
  deps: StandupDeps,
  options: { manual?: boolean } = {},
): Promise<StandupRecord | null> {
  const now = deps.now?.() ?? Date.now();
  const day = localDay(now);
  const team = await teamOf(workspaceId);
  const lead = team.find(agent => agent.template === 'growth_lead');
  const profile = await productStore.forWorkspace(workspaceId);
  if (!lead || !profile) return null;
  const record0 = await standupStore.day(workspaceId, day);
  const started = liveStart(await standupStore.startedAt(workspaceId, day), now);
  // The user's "Run today's standup" runs it now, at any hour, once a day; a skipped or failed day may run again
  const manual = Boolean(options.manual) && record0?.status !== 'done' && started === null;
  const decision = manual ? { run: true as const } : standupDecision(record0, started, now);
  const empty = { workspaceId, day, numbers: [], notes: [], summary: '', offPlan: [], at: now };
  if (!decision.run) {
    if (!decision.skip) return null;
    // A team switched on after the standup's hours has nothing to skip today
    if (lead.createdAt > startOfLocalDay(now) + STANDUP_MINUTE * 60_000) return null;
    if (!(await standupStore.start(workspaceId, day, now))) return null;
    const record: StandupRecord = { ...empty, status: 'skipped', reason: decision.skip };
    await standupStore.saveDay(record);
    await postStandup(record, profile, lead.id, deps);
    return record;
  }
  if (!(await standupStore.start(workspaceId, day, now, { replace: manual }))) return null;

  let record: StandupRecord;
  try {
    if (await deps.overCap?.()) throw new StandupStop("today's model spending reached the cap in settings");
    // A week always has a plan: a team set up mid-week, or a Monday the browser stayed closed, gets one first
    const plan = await planFor(workspaceId, deps);
    if (!plan) throw new StandupStop('there is no plan for this week');
    const numbers = await standupNumbers(profile, now);
    const notes: StandupNote[] = [];
    for (const agent of team) {
      const output = await deps.writer.note({
        task: 'note',
        agent,
        system: `You are ${agent.name} at ${profile.name}, in this morning's standup. Write at most ${NOTE_WORDS} words: did, learned, today, blocked. Each "today" item names the experiment it serves (E1, E2, E3); work that serves none gets your reason. ${RULES}`,
        prompt: `The week's plan:\n${quoteData(planText(plan))}\n\nYour week:\n${quoteData(plan.agentWeeks[agent.id] ?? 'not written')}\n\nNumbers:\n${numbers.join('\n')}\n\nWhat you did yesterday (your records):\n${quoteData(await yesterdayOf(agent, now))}`,
      });
      notes.push(
        fitNote({
          agentId: agent.id,
          agentName: agent.name,
          did: output.did.trim(),
          learned: output.learned.trim(),
          blocked: output.blocked.trim(),
          today: markOffPlan(output.today, plan.experiments),
        }),
      );
    }
    const offPlan = offPlanItems(notes);
    const written = await deps.writer.text({
      task: 'summary',
      agent: lead,
      system: `You are ${lead.name}, the Growth Lead of ${profile.name}. Sum up the standup in at most ${SUMMARY_WORDS} words: what went well yesterday and over 7 days, what to double down on, the one goal today, and the decisions needed from the user.${offPlan.length > 1 ? ' Call out each off-plan item by name.' : ''} ${RULES}`,
      prompt: `The week's plan:\n${quoteData(planText(plan))}\n\nNumbers:\n${numbers.join('\n')}\n\nNotes:\n${quoteData(notes.map(noteText).join('\n\n'))}\n\nOff plan:\n${quoteData(offPlan.length ? offPlan.map(item => `${item.agentName}: ${item.text} (${item.reason})`).join('; ') : 'nothing')}`,
    });
    // A number in the summary that no reading holds is shown as such, never passed off as a fact
    const invented = inventedNumbers(written, await knownNumbers(profile, now));
    const summary = composeSummary(
      written,
      offPlan,
      invented.length ? [`No reading holds: ${invented.join(', ')}.`] : [],
    );
    record = { ...empty, status: 'done', reason: null, numbers, notes, summary, offPlan };
  } catch (error) {
    // Our own reasons are said as they are; a model or provider error only by its kind, since its message may
    // echo what was sent
    const reason = error instanceof StandupStop ? error.message : `a model call failed (${toAppError(error).kind})`;
    record = { ...empty, status: 'failed', reason };
  }
  record.at = deps.now?.() ?? Date.now();
  await standupStore.saveDay(record);
  await postStandup(record, profile, lead.id, deps);
  return record;
}

export type StandupNow =
  { state: 'done' | 'already'; record: StandupRecord } | { state: 'running' } | { state: 'none'; reason: string };

/** The user's click: today's standup now, or what became of it. */
export async function runStandupNow(workspaceId: string, deps: StandupDeps): Promise<StandupNow> {
  const now = deps.now?.() ?? Date.now();
  const day = localDay(now);
  const done = await standupStore.day(workspaceId, day);
  if (done?.status === 'done') return { state: 'already', record: done };
  if (liveStart(await standupStore.startedAt(workspaceId, day), now) !== null) return { state: 'running' };
  const record = await runStandup(workspaceId, deps, { manual: true });
  if (record) return { state: 'done', record };
  return liveStart(await standupStore.startedAt(workspaceId, day), now) !== null
    ? { state: 'running' }
    : { state: 'none', reason: 'this workspace has no Growth Lead switched on, or no product profile' };
}

/** Every workspace's standup that is due now, or to be skipped. */
export async function runStandups(deps: StandupDeps): Promise<StandupRecord[]> {
  const records: StandupRecord[] = [];
  for (const workspaceId of await standupWorkspaces()) {
    const record = await runStandup(workspaceId, deps);
    if (record) records.push(record);
  }
  return records;
}

/** Every workspace's weekly plan that is due now. */
export async function runWeeklyPlans(deps: StandupDeps): Promise<WeekPlan[]> {
  const now = deps.now?.() ?? Date.now();
  const plans: WeekPlan[] = [];
  for (const workspaceId of await standupWorkspaces()) {
    if (!planDue(await standupStore.plan(workspaceId), now)) continue;
    const plan = await planFor(workspaceId, deps).catch(() => null);
    if (plan) plans.push(plan);
  }
  return plans;
}
