import {
  db,
  economyTts,
  findPersonality,
  KITTEN_VOICES,
  KOKORO_VOICES,
  LIVE_VOICES,
  layeredVoices,
  localVoice,
  personalityRateOf,
  personalityStore,
  personalityVoiceFor,
  resolvePersonality,
  ttsSettingsStore,
  voiceEngineSettingsStore,
  voiceIdentityStore,
  voiceTtsEngine,
} from '@extension/storage';
import type {
  AgentProfile,
  InstalledVoiceModels,
  PersonalitiesState,
  Personality,
  PersonalityVoices,
} from '@extension/storage';
import { installedVoiceModels } from '../voice/engines/models';
import type { EconomyEngines } from '../voice/engines/wire';

/**
 * Who is talking and in which voice: a personality's or an agent's voice per engine, so the user hears who it is.
 * Ava's own voices are the Settings ones; an agent gets its own, else its personality's, else one picked from its
 * name that Ava does not use.
 */

export interface Speaker {
  // Said before the line ("Research: …") so the user knows who it is even on one voice
  name: string;
  voices: PersonalityVoices;
  rate?: number;
}

/** The personality an agent's runs use: its own when it has one that still exists, else none (the workspace's). */
export function agentPersonalityOf(
  state: PersonalitiesState,
  agent: Pick<AgentProfile, 'personalityId'> | null | undefined,
): Personality | undefined {
  return agent?.personalityId ? findPersonality(state, agent.personalityId) : undefined;
}

/**
 * The personality a thread's run follows: an agent's own (its thread carries `agentId`), otherwise the one of the
 * thread's workspace or the active one.
 */
export async function personalityForThread(
  thread: { workspaceId?: string | null; agentId?: string | null } | null | undefined,
): Promise<Personality> {
  const state = await personalityStore.getState();
  if (thread?.agentId) {
    const agent = await db.agents.get(thread.agentId).catch(() => undefined);
    const own = agentPersonalityOf(state, agent);
    if (own) return own;
  }
  return resolvePersonality(state, thread?.workspaceId);
}

// Several system voice names per entry (see PersonalityVoices): the first one installed is used
const SYSTEM_POOL = [
  'Daniel|Microsoft George - English (United Kingdom)|Google UK English Male',
  'Karen|Microsoft Hazel - English (United Kingdom)|Google UK English Female',
  'Fred|Microsoft David - English (United States)|Google UK English Male',
  'Moira|Microsoft Zira - English (United States)|Google US English',
  'Rishi|Microsoft Mark - English (United States)|Google UK English Male',
  'Tessa|Microsoft Susan - English (United Kingdom)|Google UK English Female',
];

// Read when first needed: the lists come from storage, which some tests mock without them
const pools = (): Record<'live' | 'kitten' | 'kokoro' | 'system', readonly string[]> => ({
  live: LIVE_VOICES.map(voice => voice.name),
  kitten: KITTEN_VOICES,
  kokoro: KOKORO_VOICES,
  system: SYSTEM_POOL,
});

function hashOf(text: string): number {
  let hash = 0;
  for (const char of text.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * A voice per engine picked from `name`, so it stays the same every time, skipping the voices in `taken` (Ava's).
 */
export function fallbackVoices(name: string, taken: PersonalityVoices[] = []): PersonalityVoices {
  const start = hashOf(name);
  const result: PersonalityVoices = {};
  const all = pools();
  for (const slot of Object.keys(all) as (keyof typeof all)[]) {
    const pool = all[slot];
    const used = new Set(taken.map(voices => voices[slot]).filter(Boolean));
    for (let i = 0; i < pool.length; i++) {
      const voice = pool[(start + i) % pool.length];
      if (!used.has(voice)) {
        result[slot] = voice;
        break;
      }
    }
  }
  return result;
}

/** Ava's voices: the ones in Settings (Voice and language, Voice engines). */
export async function avaVoices(): Promise<PersonalityVoices> {
  const [identity, engines] = await Promise.all([
    voiceIdentityStore.getSettings(),
    voiceEngineSettingsStore.getSettings(),
  ]);
  return { live: identity.liveVoice, kitten: engines.kittenVoice, kokoro: engines.kokoroVoice };
}

/** The voices an agent speaks in: its own, then its personality's, then ones from its name that Ava does not use. */
export function agentVoices(
  agent: Pick<AgentProfile, 'name' | 'voices'>,
  personality: Pick<Personality, 'voices'> | null | undefined,
  ava: PersonalityVoices,
): PersonalityVoices {
  return layeredVoices(agent.voices, personality?.voices, fallbackVoices(agent.name, [ava]));
}

/** An agent as a speaker, or null when it is gone. */
export async function agentSpeaker(agentId: string | null | undefined): Promise<Speaker | null> {
  if (!agentId) return null;
  const agent = await db.agents.get(agentId).catch(() => undefined);
  if (!agent) return null;
  const personality = agentPersonalityOf(await personalityStore.getState(), agent);
  return {
    name: agent.name,
    voices: agentVoices(agent, personality, await avaVoices()),
    rate: personalityRateOf(personality),
  };
}

/**
 * The local or system voice a speaker's line is said in during a conversation. An economy conversation keeps its
 * engine; in a Live one (which cannot change voice per turn) it is the read-aloud engine when it is on the device
 * and installed, else KittenTTS when installed, else the system voices.
 */
export async function speakerTts(
  speaker: Speaker,
  economy: EconomyEngines['tts'] | null = null,
  installed?: InstalledVoiceModels,
): Promise<EconomyEngines['tts']> {
  const [tts, settings] = await Promise.all([ttsSettingsStore.getSettings(), voiceEngineSettingsStore.getSettings()]);
  const engine =
    economy?.engine ??
    economyTts(voiceTtsEngine(tts.engine), installed ?? (await installedVoiceModels()), tts.engineChosen ?? true);
  const voice =
    personalityVoiceFor(engine, speaker) ?? (engine === 'system' ? tts.voice : localVoice(engine, settings));
  return { engine, voice, rate: speaker.rate ?? economy?.rate ?? tts.rate };
}

/** A speaker's line as it is said: its name first, so the user knows who it is. */
export function spokenLine(speaker: Pick<Speaker, 'name'>, text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line ? `${speaker.name}: ${line}` : '';
}
