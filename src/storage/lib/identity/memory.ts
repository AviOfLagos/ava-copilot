import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import {
  CORE_FIELD_MAX,
  FACT_CATEGORIES,
  FACT_HISTORY_MAX,
  FACT_TEXT_MAX,
  FACTS_MAX,
  GOAL_TEXT_MAX,
  GOALS_MAX,
  GOALS_PER_WORKSPACE_MAX,
  INSIGHT_TEXT_MAX,
  INSIGHTS_MAX,
} from './types';
import type {
  AboutYouState,
  CoreIdentity,
  FactCategory,
  FactSource,
  FactStatus,
  Insight,
  UserFact,
  UserGoal,
} from './types';

// ── Core identity ─────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CORE: Omit<CoreIdentity, 'updatedAt'> = {
  character:
    'Warm, direct and a little witty. You talk like a sharp colleague who knows the user and their work, not like a help desk. You have opinions and say them briefly; you notice what matters and skip what doesn\'t. Never generic: no "Hi, how can I help you today?", no "As an AI…", no "Great question!". Open with the substance, or with something that shows you know where they are.',
  values:
    "Protect the user's time, money and reputation. Nothing is sent, posted, bought or deleted without their click. Be honest about your limits and about what you don't know; never bluff. Keep each workspace's matters apart.",
  purpose:
    'Help the user ship: know their workspaces, people and current goals, keep track of what is open, and push the work forward. Point out the next step, flag what is slipping, and offer to do the legwork in the browser.',
};

export const EMPTY_CORE: CoreIdentity = { character: '', values: '', purpose: '', updatedAt: null };

const clip = (text: unknown, max: number) =>
  String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);

/** The core as it applies: each empty field falls back to its default. */
export function effectiveCore(core: Partial<CoreIdentity> | null | undefined): Omit<CoreIdentity, 'updatedAt'> {
  return {
    character: clip(core?.character, CORE_FIELD_MAX) || DEFAULT_CORE.character,
    values: clip(core?.values, CORE_FIELD_MAX) || DEFAULT_CORE.values,
    purpose: clip(core?.purpose, CORE_FIELD_MAX) || DEFAULT_CORE.purpose,
  };
}

/** Cleans what the user typed for the core; a field equal to its default is stored empty, so it follows updates. */
export function cleanCore(input: Partial<CoreIdentity>, now = Date.now()): CoreIdentity {
  const field = (key: keyof typeof DEFAULT_CORE) => {
    const value = clip(input[key], CORE_FIELD_MAX);
    return value === DEFAULT_CORE[key] ? '' : value;
  };
  return { character: field('character'), values: field('values'), purpose: field('purpose'), updatedAt: now };
}

const coreStorage = createStorage<CoreIdentity>('ava-core', EMPTY_CORE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const coreIdentityStore = {
  ...coreStorage,
  async getCore(): Promise<CoreIdentity> {
    return { ...EMPTY_CORE, ...((await coreStorage.get()) ?? {}) };
  },
  async saveCore(input: Partial<CoreIdentity>): Promise<CoreIdentity> {
    const core = cleanCore(input);
    await coreStorage.set(core);
    return core;
  },
  async resetCore(): Promise<void> {
    await coreStorage.set({ ...EMPTY_CORE, updatedAt: Date.now() });
  },
};

// ── About you: facts, goals, insights ────────────────────────────────────────────────────────────

export const EMPTY_ABOUT_YOU: AboutYouState = { facts: [], goals: [], insights: [], lastReflectionAt: null };

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** One line of text: spaces collapsed, cut to `max`; empty when nothing is left. */
export function oneLine(text: unknown, max: number): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

export const isFactCategory = (value: unknown): value is FactCategory =>
  typeof value === 'string' && (FACT_CATEGORIES as readonly string[]).includes(value);

/** The state read back from storage, made whole. */
export function normalizeAboutYou(raw: Partial<AboutYouState> | null | undefined): AboutYouState {
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]).filter(Boolean) : []);
  return {
    facts: list<UserFact>(raw?.facts).map(fact => ({
      ...fact,
      category: isFactCategory(fact.category) ? fact.category : 'other',
      workspaceId: fact.workspaceId ?? null,
      previous: Array.isArray(fact.previous) ? fact.previous : [],
    })),
    goals: list<UserGoal>(raw?.goals).map(goal => ({ ...goal, workspaceId: goal.workspaceId ?? null })),
    insights: list<Insight>(raw?.insights),
    lastReflectionAt: typeof raw?.lastReflectionAt === 'number' ? raw.lastReflectionAt : null,
  };
}

export interface FactInput {
  text: string;
  category?: FactCategory;
  workspaceId?: string | null;
  source: FactSource;
  status: FactStatus;
  via: string;
}

export type FactChange = { ok: true; state: AboutYouState; fact: UserFact } | { ok: false; error: string };

/**
 * Adds a fact, or refreshes the same one already kept (same words, same workspace). A fact the user said makes a
 * proposed copy of it active. The newest FACTS_MAX are kept; proposed ones go first when there are too many.
 */
export function addFact(state: AboutYouState, input: FactInput, now = Date.now()): FactChange {
  const text = oneLine(input.text, FACT_TEXT_MAX);
  if (!text) return { ok: false, error: 'The fact is empty.' };
  const workspaceId = input.workspaceId ?? null;
  const same = state.facts.find(fact => comparable(fact.text) === comparable(text) && fact.workspaceId === workspaceId);
  if (same) {
    const status: FactStatus = same.status === 'active' || input.status === 'active' ? 'active' : 'proposed';
    const fact: UserFact = {
      ...same,
      status,
      source: status === 'active' && same.status === 'proposed' ? input.source : same.source,
      updatedAt: now,
    };
    return { ok: true, fact, state: { ...state, facts: state.facts.map(item => (item.id === same.id ? fact : item)) } };
  }
  const fact: UserFact = {
    id: newId('fact'),
    text,
    category: input.category ?? 'other',
    workspaceId,
    source: input.source,
    status: input.status,
    via: oneLine(input.via, 20) || 'chat',
    createdAt: now,
    updatedAt: now,
    previous: [],
  };
  let facts = [...state.facts, fact];
  while (facts.length > FACTS_MAX) {
    const proposed = facts.find(item => item.status === 'proposed' && item.id !== fact.id);
    const drop = proposed ?? [...facts].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    facts = facts.filter(item => item.id !== drop.id);
  }
  return { ok: true, fact, state: { ...state, facts } };
}

/** Changes a fact's words (keeping what it said before, and until when) or its category/workspace. */
export function updateFact(
  state: AboutYouState,
  id: string,
  changes: { text?: string; category?: FactCategory; workspaceId?: string | null; status?: FactStatus },
  now = Date.now(),
): FactChange {
  const current = state.facts.find(fact => fact.id === id);
  if (!current) return { ok: false, error: 'There is no such fact.' };
  const text = changes.text === undefined ? current.text : oneLine(changes.text, FACT_TEXT_MAX);
  if (!text) return { ok: false, error: 'The fact is empty.' };
  const changed = text !== current.text;
  const fact: UserFact = {
    ...current,
    text,
    category: changes.category ?? current.category,
    workspaceId: changes.workspaceId === undefined ? current.workspaceId : changes.workspaceId,
    status: changes.status ?? current.status,
    updatedAt: now,
    previous: changed
      ? [{ text: current.text, until: now }, ...current.previous].slice(0, FACT_HISTORY_MAX)
      : current.previous,
  };
  return { ok: true, fact, state: { ...state, facts: state.facts.map(item => (item.id === id ? fact : item)) } };
}

/** The facts a chat in `workspaceId` may see: general ones and that workspace's; outside a workspace, all. */
export function visibleFactsFor(facts: UserFact[], workspaceId: string | null): UserFact[] {
  return workspaceId ? facts.filter(fact => !fact.workspaceId || fact.workspaceId === workspaceId) : facts;
}

export function removeFact(state: AboutYouState, id: string): AboutYouState {
  return { ...state, facts: state.facts.filter(fact => fact.id !== id) };
}

/**
 * The fact a request means: its id, else the one whose words overlap most with `key` (at least half of the
 * request's words). Undefined when nothing fits.
 */
export function findFact(state: AboutYouState, key: string): UserFact | undefined {
  const byId = state.facts.find(fact => fact.id === key.trim());
  if (byId) return byId;
  const wanted = comparable(key)
    .split(' ')
    .filter(word => word.length > 2);
  if (!wanted.length) return undefined;
  let best: { fact: UserFact; score: number } | undefined;
  for (const fact of state.facts) {
    const words = new Set(comparable(fact.text).split(' '));
    const score = wanted.filter(word => words.has(word)).length / wanted.length;
    if (score >= 0.5 && (!best || score > best.score)) best = { fact, score };
  }
  return best?.fact;
}

/** Adds or edits one of the user's own goals. */
export function saveGoal(
  state: AboutYouState,
  input: { id?: string; text: string; workspaceId: string | null; source?: UserGoal['source'] },
  now = Date.now(),
): { ok: true; state: AboutYouState; goal: UserGoal } | { ok: false; error: string } {
  const text = oneLine(input.text, GOAL_TEXT_MAX);
  if (!text) return { ok: false, error: 'The goal is empty.' };
  const existing = input.id ? state.goals.find(goal => goal.id === input.id) : undefined;
  const goal: UserGoal = existing
    ? { ...existing, text, workspaceId: input.workspaceId, updatedAt: now, source: input.source ?? 'user' }
    : {
        id: newId('goal'),
        text,
        workspaceId: input.workspaceId,
        source: input.source ?? 'user',
        createdAt: now,
        updatedAt: now,
      };
  const goals = existing
    ? state.goals.map(item => (item.id === goal.id ? goal : item))
    : [...state.goals, goal].slice(-GOALS_MAX);
  return { ok: true, goal, state: { ...state, goals } };
}

export function removeGoal(state: AboutYouState, id: string): AboutYouState {
  return { ...state, goals: state.goals.filter(goal => goal.id !== id) };
}

/**
 * A reflection's goals for one workspace (null: in general): they replace the goals earlier reflections set there,
 * up to GOALS_PER_WORKSPACE_MAX with the user's own, which are never touched.
 */
export function applyReflectedGoals(
  state: AboutYouState,
  workspaceId: string | null,
  texts: string[],
  now = Date.now(),
): AboutYouState {
  const own = state.goals.filter(goal => goal.workspaceId === workspaceId && goal.source === 'user');
  const others = state.goals.filter(goal => goal.workspaceId !== workspaceId);
  const ownWords = new Set(own.map(goal => comparable(goal.text)));
  const kept = state.goals.filter(goal => goal.workspaceId === workspaceId && goal.source === 'reflection');
  const fresh: UserGoal[] = [];
  for (const raw of texts) {
    const text = oneLine(raw, GOAL_TEXT_MAX);
    if (!text || ownWords.has(comparable(text)) || fresh.some(goal => comparable(goal.text) === comparable(text)))
      continue;
    const before = kept.find(goal => comparable(goal.text) === comparable(text));
    fresh.push(
      before
        ? { ...before, updatedAt: now }
        : { id: newId('goal'), text, workspaceId, source: 'reflection', createdAt: now, updatedAt: now },
    );
  }
  const room = Math.max(0, GOALS_PER_WORKSPACE_MAX - own.length);
  return { ...state, goals: [...others, ...own, ...fresh.slice(0, room)].slice(-GOALS_MAX) };
}

/** Keeps a reflection's insights, newest first, at most INSIGHTS_MAX in all. */
export function addInsights(
  state: AboutYouState,
  items: { text: string; workspaceId: string | null }[],
  now = Date.now(),
): AboutYouState {
  const fresh = items
    .map(item => ({ ...item, text: oneLine(item.text, INSIGHT_TEXT_MAX) }))
    .filter(item => item.text)
    .map(item => ({ id: newId('insight'), text: item.text, workspaceId: item.workspaceId, createdAt: now }));
  return { ...state, insights: [...fresh, ...state.insights].slice(0, INSIGHTS_MAX) };
}

const aboutStorage = createStorage<AboutYouState>('about-you', EMPTY_ABOUT_YOU, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

// Changes are read-modify-write: one at a time, so two quick saves never lose each other
let queue: Promise<unknown> = Promise.resolve();

export const aboutYouStore = {
  ...aboutStorage,
  async getState(): Promise<AboutYouState> {
    return normalizeAboutYou(await aboutStorage.get());
  },
  /** Applies `change` to the latest state and saves it; returns what `change` returned. */
  change<T>(change: (state: AboutYouState) => { state: AboutYouState; result: T }): Promise<T> {
    const next = queue.then(async () => {
      const { state, result } = change(await aboutYouStore.getState());
      await aboutStorage.set(state);
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  },
};
