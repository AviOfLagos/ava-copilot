import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import { KITTEN_VOICES, KOKORO_VOICES } from '../settings/voiceEngineSettings';
import { BUILTIN_ALIASES, BUILTIN_PERSONALITIES, DEFAULT_PERSONALITY_ID } from './builtins';
import {
  PERSONALITY_CUSTOM_MAX,
  PERSONALITY_DESCRIPTION_MAX,
  PERSONALITY_ICON_MAX,
  PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_NAME_MAX,
  PERSONALITY_RATE_MAX,
  PERSONALITY_RATE_MIN,
} from './types';
import type { PersonalitiesState, Personality, PersonalityProblem } from './types';

export const EMPTY_PERSONALITIES: PersonalitiesState = {
  custom: [],
  activeId: DEFAULT_PERSONALITY_ID,
  workspaceDefaults: {},
};

export type PersonalityCheck = { ok: true; personality: Personality } | { ok: false; problems: PersonalityProblem[] };

/**
 * Cleans and checks a personality the user wrote: trims the text, collapses the name's spaces, and lists what is
 * wrong. A user's personality needs a name and instructions; the description, icon, voice and pace are optional.
 */
export function checkPersonality(input: Partial<Personality>): PersonalityCheck {
  const name = (input.name ?? '').replace(/\s+/g, ' ').trim();
  const description = (input.description ?? '').replace(/\s+/g, ' ').trim();
  const icon = (input.icon ?? '').trim();
  const instructions = (input.instructions ?? '').replace(/\r\n/g, '\n').trim();
  const rate = Number(input.rate ?? 0) || 0;
  const problems: PersonalityProblem[] = [];
  if (!name) problems.push('nameEmpty');
  if ([...name].length > PERSONALITY_NAME_MAX) problems.push('nameTooLong');
  if ([...description].length > PERSONALITY_DESCRIPTION_MAX) problems.push('descriptionTooLong');
  if (icon.length > PERSONALITY_ICON_MAX) problems.push('iconTooLong');
  if (!instructions) problems.push('instructionsEmpty');
  if (instructions.length > PERSONALITY_INSTRUCTIONS_MAX) problems.push('instructionsTooLong');
  if (rate !== 0 && (rate < PERSONALITY_RATE_MIN || rate > PERSONALITY_RATE_MAX)) problems.push('rate');
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    personality: {
      id: input.id ?? '',
      name,
      description,
      icon: icon || '💬',
      instructions,
      voice: (input.voice ?? '').trim().slice(0, 120),
      rate,
    },
  };
}

/** Every personality: the built-ins first, then the user's own. */
export function allPersonalities(state: PersonalitiesState): Personality[] {
  return [...BUILTIN_PERSONALITIES, ...state.custom];
}

export function findPersonality(state: PersonalitiesState, id: string | null | undefined): Personality | undefined {
  return id ? allPersonalities(state).find(item => item.id === id) : undefined;
}

export const defaultPersonality = (): Personality => BUILTIN_PERSONALITIES[0];

/**
 * The personality in force for a chat in `workspaceId` (or none): the workspace's default when it has one that
 * still exists, otherwise the active one, otherwise the default.
 */
export function resolvePersonality(state: PersonalitiesState, workspaceId?: string | null): Personality {
  const fromWorkspace = workspaceId ? findPersonality(state, state.workspaceDefaults[workspaceId]) : undefined;
  return fromWorkspace ?? findPersonality(state, state.activeId) ?? defaultPersonality();
}

/**
 * Switching where the user is: inside a workspace that has its own default, the switch changes that default (so
 * it takes effect there); anywhere else it changes the active personality.
 */
export function withActive(state: PersonalitiesState, id: string, workspaceId?: string | null): PersonalitiesState {
  if (!findPersonality(state, id)) return state;
  if (workspaceId && state.workspaceDefaults[workspaceId]) {
    return { ...state, workspaceDefaults: { ...state.workspaceDefaults, [workspaceId]: id } };
  }
  return { ...state, activeId: id };
}

/** Whether a switch made in `workspaceId` changes that workspace's default rather than the global choice. */
export function switchesWorkspace(state: PersonalitiesState, workspaceId?: string | null): boolean {
  return Boolean(workspaceId && state.workspaceDefaults[workspaceId]);
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The personality a spoken or typed request names ("the accountant", "Bezos", "my Sales coach"): an exact id or
 * name first, then a name contained in the request, then a built-in's alias. None when nothing, or more than one
 * thing, matches.
 */
export function matchPersonality(state: PersonalitiesState, request: string): Personality | undefined {
  const all = allPersonalities(state);
  const text = request.trim().toLowerCase();
  if (!text) return undefined;
  const exact = all.find(item => item.id === text || item.name.toLowerCase() === text);
  if (exact) return exact;
  const said = new Set(words(text));
  const joined = ` ${words(text).join(' ')} `;
  // The user's own names first: "the sales accountant" should find their personality, not the built-in
  const byName = [...state.custom, ...BUILTIN_PERSONALITIES].filter(item =>
    joined.includes(` ${words(item.name).join(' ')} `),
  );
  if (byName.length) return byName.sort((a, b) => b.name.length - a.name.length)[0];
  const byAlias = BUILTIN_PERSONALITIES.filter(item => (BUILTIN_ALIASES[item.id] ?? []).some(word => said.has(word)));
  return byAlias.length === 1 ? byAlias[0] : undefined;
}

/** A new id for a user's personality. */
export function newPersonalityId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A user's copy of any personality, to edit: "Accountant (copy)", its instructions kept. */
export function duplicatePersonality(source: Personality, copyLabel = 'copy'): Personality {
  const suffix = ` (${copyLabel})`;
  return {
    ...source,
    id: newPersonalityId(),
    name: `${[...source.name].slice(0, PERSONALITY_NAME_MAX - suffix.length).join('')}${suffix}`,
    // The default has no instructions: the copy starts with a line to edit
    instructions: source.instructions || 'Describe how this personality thinks and talks.',
    builtIn: undefined,
  };
}

/** The state read back from storage, made whole: missing fields filled, unknown references dropped. */
export function normalizePersonalities(raw: Partial<PersonalitiesState> | null | undefined): PersonalitiesState {
  const custom = Array.isArray(raw?.custom) ? raw.custom.filter(item => item && typeof item.id === 'string') : [];
  const state: PersonalitiesState = {
    custom: custom.map(item => ({ ...item, builtIn: undefined })),
    activeId: typeof raw?.activeId === 'string' ? raw.activeId : DEFAULT_PERSONALITY_ID,
    workspaceDefaults: { ...(raw?.workspaceDefaults ?? {}) },
  };
  if (!findPersonality(state, state.activeId)) state.activeId = DEFAULT_PERSONALITY_ID;
  for (const [workspace, id] of Object.entries(state.workspaceDefaults)) {
    if (!findPersonality(state, id)) delete state.workspaceDefaults[workspace];
  }
  return state;
}

const LOCAL_VOICES: Record<string, readonly string[]> = { kitten: KITTEN_VOICES, kokoro: KOKORO_VOICES };

/**
 * The voice a personality asks for, for the engine that will speak: a Kitten or Kokoro id only for its own engine,
 * any other name only for the system voices (a Gemini voice comes from Settings › Voice output). Undefined keeps
 * the voice settings.
 */
export function personalityVoiceFor(
  engine: string,
  personality: Pick<Personality, 'voice'> | null | undefined,
): string | undefined {
  const voice = personality?.voice?.trim();
  if (!voice) return undefined;
  const localEngine = Object.entries(LOCAL_VOICES).find(([, voices]) => voices.includes(voice))?.[0];
  if (localEngine) return localEngine === engine ? voice : undefined;
  return engine === 'system' ? voice : undefined;
}

/** The speaking pace a personality asks for, or undefined to keep the voice settings. */
export function personalityRateOf(personality: Pick<Personality, 'rate'> | null | undefined): number | undefined {
  const rate = personality?.rate ?? 0;
  return rate >= PERSONALITY_RATE_MIN && rate <= PERSONALITY_RATE_MAX ? rate : undefined;
}

const storage = createStorage<PersonalitiesState>('personalities', EMPTY_PERSONALITIES, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const isBuiltIn = (id: string) => BUILTIN_PERSONALITIES.some(item => item.id === id);

export const personalityStore = {
  ...storage,

  async getState(): Promise<PersonalitiesState> {
    return normalizePersonalities(await storage.get());
  },

  async list(): Promise<Personality[]> {
    return allPersonalities(await personalityStore.getState());
  },

  /** The personality for a chat in `workspaceId`, or outside any workspace. */
  async resolve(workspaceId?: string | null): Promise<Personality> {
    return resolvePersonality(await personalityStore.getState(), workspaceId);
  },

  /** Switches where the user is (see withActive). Returns the personality now in force, or undefined if unknown. */
  async setActive(id: string, workspaceId?: string | null): Promise<Personality | undefined> {
    const state = await personalityStore.getState();
    if (!findPersonality(state, id)) return undefined;
    const next = withActive(state, id, workspaceId);
    await storage.set(next);
    return resolvePersonality(next, workspaceId);
  },

  /** Sets or clears (null) a workspace's own default personality. */
  async setWorkspaceDefault(workspaceId: string, id: string | null): Promise<void> {
    const state = await personalityStore.getState();
    const workspaceDefaults = { ...state.workspaceDefaults };
    if (id && findPersonality(state, id)) workspaceDefaults[workspaceId] = id;
    else delete workspaceDefaults[workspaceId];
    await storage.set({ ...state, workspaceDefaults });
  },

  /**
   * Adds or replaces one of the user's personalities. Built-ins are read-only.
   *
   * @returns the saved personality, or the problems that stopped it
   */
  async save(input: Partial<Personality>): Promise<PersonalityCheck> {
    if (input.id && isBuiltIn(input.id)) return { ok: false, problems: ['builtIn'] };
    const check = checkPersonality(input);
    if (!check.ok) return check;
    const state = await personalityStore.getState();
    const personality = { ...check.personality, id: check.personality.id || newPersonalityId() };
    const at = state.custom.findIndex(item => item.id === personality.id);
    if (at < 0 && state.custom.length >= PERSONALITY_CUSTOM_MAX) return { ok: false, problems: ['tooMany'] };
    const custom =
      at >= 0 ? state.custom.map((item, i) => (i === at ? personality : item)) : [...state.custom, personality];
    await storage.set({ ...state, custom });
    return { ok: true, personality };
  },

  /** Deletes one of the user's personalities; anything that used it goes back to the default. */
  async remove(id: string): Promise<void> {
    if (isBuiltIn(id)) return;
    const state = await personalityStore.getState();
    await storage.set(normalizePersonalities({ ...state, custom: state.custom.filter(item => item.id !== id) }));
  },
};
