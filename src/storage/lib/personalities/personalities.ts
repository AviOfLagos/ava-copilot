import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import { KITTEN_VOICES, KOKORO_VOICES } from '../settings/voiceEngineSettings';
import { LIVE_VOICES } from '../identity/voice';
import { BUILTIN_ALIASES, BUILTIN_PERSONALITIES, DEFAULT_PERSONALITY_ID } from './builtins';
import {
  PERSONALITY_CUSTOM_MAX,
  PERSONALITY_DESCRIPTION_MAX,
  PERSONALITY_ICON_MAX,
  PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_NAME_MAX,
  PERSONALITY_RATE_MAX,
  PERSONALITY_RATE_MIN,
  VOICE_SLOTS,
} from './types';
import type { PersonalitiesState, Personality, PersonalityProblem, PersonalityVoices, VoiceSlot } from './types';

export const EMPTY_PERSONALITIES: PersonalitiesState = {
  custom: [],
  activeId: DEFAULT_PERSONALITY_ID,
  workspaceDefaults: {},
  voiceOverrides: {},
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
      voices: cleanVoices(migrateVoices(input)),
      rate,
    },
  };
}

/** Every personality: the built-ins first (with the voices the user gave them), then the user's own. */
export function allPersonalities(state: PersonalitiesState): Personality[] {
  const overrides = state.voiceOverrides ?? {};
  const builtIns = BUILTIN_PERSONALITIES.map(item =>
    overrides[item.id] ? { ...item, voices: overrides[item.id].voices, rate: overrides[item.id].rate } : item,
  );
  return [...builtIns, ...state.custom];
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
    // A personality stored before voices were per engine gets its one voice in the right slot
    custom: custom.map(item => {
      const migrated: Personality = { ...item, voices: cleanVoices(migrateVoices(item)), builtIn: undefined };
      delete migrated.voice;
      return migrated;
    }),
    activeId: typeof raw?.activeId === 'string' ? raw.activeId : DEFAULT_PERSONALITY_ID,
    workspaceDefaults: { ...(raw?.workspaceDefaults ?? {}) },
    voiceOverrides: Object.fromEntries(
      Object.entries(raw?.voiceOverrides ?? {})
        .filter(([id, value]) => BUILTIN_PERSONALITIES.some(item => item.id === id) && value)
        .map(([id, value]) => [id, { voices: cleanVoices(value.voices), rate: cleanRate(value.rate) }]),
    ),
  };
  if (!findPersonality(state, state.activeId)) state.activeId = DEFAULT_PERSONALITY_ID;
  for (const [workspace, id] of Object.entries(state.workspaceDefaults)) {
    if (!findPersonality(state, id)) delete state.workspaceDefaults[workspace];
  }
  return state;
}

const SLOT_VOICES: Record<Exclude<VoiceSlot, 'system'>, readonly string[]> = {
  live: LIVE_VOICES.map(voice => voice.name),
  kitten: KITTEN_VOICES,
  kokoro: KOKORO_VOICES,
};

/** The voices one engine offers (none listed for the system's: they depend on the computer). */
export function voicesOfSlot(slot: VoiceSlot): readonly string[] {
  return slot === 'system' ? [] : SLOT_VOICES[slot];
}

/** The slot an old single voice name belongs in: a Kitten, Kokoro or Gemini name, else a system voice. */
export function slotOfVoice(voice: string): VoiceSlot {
  const slots = Object.keys(SLOT_VOICES) as Exclude<VoiceSlot, 'system'>[];
  return slots.find(slot => SLOT_VOICES[slot].includes(voice)) ?? 'system';
}

type WithVoices = { voices?: PersonalityVoices | null; voice?: string | null };

/**
 * The voices of a personality (or an agent) as stored, whatever its age: `voices` when it has them, else its old
 * single `voice` put in the slot of the engine it names.
 */
export function migrateVoices(input: WithVoices | null | undefined): PersonalityVoices {
  if (input?.voices && typeof input.voices === 'object') return { ...input.voices };
  const old = typeof input?.voice === 'string' ? input.voice.trim() : '';
  return old ? { [slotOfVoice(old)]: old } : {};
}

/** Only known voices, each in its own slot; a system name is kept as written (several may be given, see types). */
export function cleanVoices(voices: PersonalityVoices | null | undefined): PersonalityVoices {
  const clean: PersonalityVoices = {};
  for (const slot of VOICE_SLOTS) {
    const raw = voices?.[slot];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    if (slot === 'system') clean.system = value.slice(0, 200);
    else if (SLOT_VOICES[slot].includes(value)) clean[slot] = value;
  }
  return clean;
}

function cleanRate(rate: unknown): number {
  const value = Number(rate) || 0;
  return value >= PERSONALITY_RATE_MIN && value <= PERSONALITY_RATE_MAX ? value : 0;
}

/** The slot an engine's voice comes from: Gemini read-aloud uses the same prebuilt voices as Live. */
export function slotForEngine(engine: string): VoiceSlot | null {
  if (engine === 'live' || engine === 'gemini') return 'live';
  if (engine === 'kitten' || engine === 'kokoro' || engine === 'system') return engine;
  return null;
}

/**
 * The voice a personality (or an agent) asks for, for the engine that will speak: only a voice of that engine.
 * `engine` is 'live', 'gemini' (read-aloud), 'kitten', 'kokoro' or 'system'. Undefined keeps the voice settings.
 */
export function personalityVoiceFor(engine: string, personality: WithVoices | null | undefined): string | undefined {
  const slot = slotForEngine(engine);
  if (!slot || !personality) return undefined;
  return cleanVoices(migrateVoices(personality))[slot];
}

/** Voices in layers: for each engine the first layer that has a voice wins (an agent's own, then its personality's). */
export function layeredVoices(...layers: (PersonalityVoices | null | undefined)[]): PersonalityVoices {
  const result: PersonalityVoices = {};
  for (const slot of VOICE_SLOTS) {
    const found = layers.map(layer => cleanVoices(layer)[slot]).find(Boolean);
    if (found) result[slot] = found;
  }
  return result;
}

/**
 * The system voice to use from a stored value (one name, or several separated by "|") and the voices installed:
 * the first one installed, matched by name ("Daniel" also finds "Daniel (English (United Kingdom))"). Undefined
 * when none is installed, so the system default speaks rather than nothing.
 */
export function pickSystemVoice(value: string | undefined, installed: readonly string[]): string | undefined {
  const wanted = (value ?? '')
    .split('|')
    .map(name => name.trim())
    .filter(Boolean);
  for (const name of wanted) {
    const lower = name.toLowerCase();
    const found = installed.find(item => {
      const have = item.toLowerCase();
      return have === lower || have.startsWith(`${lower} (`);
    });
    if (found) return found;
  }
  return undefined;
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

  /** Gives a built-in its own voices and pace (everything else about it stays read-only). */
  async setBuiltInVoices(id: string, voices: PersonalityVoices, rate: number): Promise<void> {
    if (!isBuiltIn(id)) return;
    const state = await personalityStore.getState();
    const voiceOverrides = {
      ...(state.voiceOverrides ?? {}),
      [id]: { voices: cleanVoices(voices), rate: cleanRate(rate) },
    };
    await storage.set({ ...state, voiceOverrides });
  },

  /** Puts a built-in back to the voices it ships with. */
  async resetBuiltInVoices(id: string): Promise<void> {
    const state = await personalityStore.getState();
    const voiceOverrides = { ...(state.voiceOverrides ?? {}) };
    delete voiceOverrides[id];
    await storage.set({ ...state, voiceOverrides });
  },

  /** Deletes one of the user's personalities; anything that used it goes back to the default. */
  async remove(id: string): Promise<void> {
    if (isBuiltIn(id)) return;
    const state = await personalityStore.getState();
    await storage.set(normalizePersonalities({ ...state, custom: state.custom.filter(item => item.id !== id) }));
  },
};
