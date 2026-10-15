import { aboutYouStore, db, GENERAL_SUMMARY_ID, historyStore, threadStore, workspaceStore } from '@extension/storage';
import type { AboutYouState } from '@extension/storage';
import { createLogger } from '../log';
import {
  applyReflection,
  chatMaterial,
  meetingMaterial,
  REFLECTION_INSTRUCTIONS,
  REFLECTION_WINDOW_MS,
  reflectionPrompt,
  reflectionSchema,
  summaryMaterial,
} from './reflection';
import type { ReflectionMaterial, ReflectionOutput } from './reflection';

const logger = createLogger('Reflection');

export const REFLECTION_SESSION = 'ava-reflection';
// A reflection asked for after a long conversation waits this long after the last one
export const REFLECT_SOON_GAP_MS = 6 * 60 * 60 * 1000;
const CHATS_READ = 30;

export interface ReflectorDeps {
  material(since: number): Promise<ReflectionMaterial[]>;
  workspaces(): Promise<{ id: string; name: string }[]>;
  getState(): Promise<AboutYouState>;
  save(change: (state: AboutYouState) => AboutYouState): Promise<void>;
  generate(prompt: { system: string; user: string }): Promise<ReflectionOutput>;
  overCap(): Promise<boolean>;
  now(): number;
}

export type ReflectionResult =
  { done: true; insights: number; goals: number } | { done: false; reason: 'recent' | 'nothing' | 'cap' };

/** Runs one reflection; `soon` (after a long conversation) skips when the last one is recent. */
export async function runReflection(deps: ReflectorDeps, { soon = false } = {}): Promise<ReflectionResult> {
  const now = deps.now();
  const state = await deps.getState();
  if (soon && state.lastReflectionAt && now - state.lastReflectionAt < REFLECT_SOON_GAP_MS) {
    return { done: false, reason: 'recent' };
  }
  const since = Math.max(now - REFLECTION_WINDOW_MS, (state.lastReflectionAt ?? 0) - 24 * 60 * 60 * 1000);
  const material = await deps.material(since);
  if (!material.length) return { done: false, reason: 'nothing' };
  if (await deps.overCap()) return { done: false, reason: 'cap' };
  const workspaces = await deps.workspaces();
  const output = reflectionSchema.parse(
    await deps.generate({ system: REFLECTION_INSTRUCTIONS, user: reflectionPrompt(material, workspaces, state.goals) }),
  );
  let goals = 0;
  await deps.save(current => {
    const next = applyReflection(current, output, workspaces, now);
    goals = next.goals.filter(goal => goal.source === 'reflection' && goal.updatedAt === now).length;
    return next;
  });
  return { done: true, insights: Math.min(output.insights.length, 5), goals };
}

/** What the reflection reads from this browser: recent chats, meetings, and each workspace's summary. */
export async function gatherMaterial(since: number): Promise<ReflectionMaterial[]> {
  const threads = (await db.threads.where('updatedAt').above(since).toArray())
    .filter(thread => !thread.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, CHATS_READ);
  const material: ReflectionMaterial[] = [];
  for (const thread of threads) {
    const item = chatMaterial(thread, await threadStore.messages(thread.id));
    if (item) material.push(item);
  }
  for (const meeting of await db.meetings.toArray()) {
    if ((meeting.endedAt ?? meeting.startedAt) < since) continue;
    const item = meetingMaterial(meeting);
    if (item) material.push(item);
  }
  const summaries = await historyStore.summaries().catch(() => ({}));
  for (const [key, summary] of Object.entries(summaries)) {
    material.push(summaryMaterial(summary, key === GENERAL_SUMMARY_ID ? null : key));
  }
  return material;
}

export async function defaultWorkspaces(): Promise<{ id: string; name: string }[]> {
  return (await workspaceStore.list()).map(workspace => ({ id: workspace.id, name: workspace.name }));
}

export async function saveAboutYou(change: (state: AboutYouState) => AboutYouState): Promise<void> {
  await aboutYouStore.change(state => ({ state: change(state), result: null }));
}

export { logger as reflectionLogger };
