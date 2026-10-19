import { describe, expect, it, vi } from 'vitest';
import type * as Storage from '@extension/storage';

/** Agents with a personality and a voice of their own. */

const agents: Record<string, Record<string, unknown>> = {};
vi.mock('@extension/storage', async importOriginal => {
  const actual = (await importOriginal()) as typeof Storage;
  return {
    ...actual,
    db: { agents: { get: async (id: string) => agents[id] } },
    personalityStore: {
      getState: async () => ({ ...actual.EMPTY_PERSONALITIES, workspaceDefaults: { w1: 'accountant' } }),
    },
    voiceIdentityStore: { getSettings: async () => ({ liveVoice: 'Aoede', language: 'en-US' }) },
    voiceEngineSettingsStore: { getSettings: async () => ({ kittenVoice: 'Bella', kokoroVoice: 'af_heart' }) },
  };
});

const { buildPersonalitySection } = await import('../../personalities/prompt');
const { agentSpeaker, agentVoices, fallbackVoices, personalityForThread, spokenLine } =
  await import('../../personalities/voices');
const { agentTemplate, TEAM_TEMPLATE_IDS, AGENT_TEMPLATE_IDS } = await import('../templates');
const { diffProfiles, fieldsOf, validateProfile } = await import('../profile');
const { fromAuthoredAgent, toAuthoredAgent } = await import('../authoring');
const { BUILTIN_PERSONALITIES } = await import('@extension/storage');

describe("an agent's personality", () => {
  it('is what its runs follow instead of the workspace one', async () => {
    agents.a1 = { id: 'a1', name: 'Research', personalityId: 'engineer' };
    agents.a2 = { id: 'a2', name: 'Plain', personalityId: null };
    agents.a3 = { id: 'a3', name: 'Gone', personalityId: 'custom-deleted' };
    const own = await personalityForThread({ workspaceId: 'w1', agentId: 'a1' });
    expect(own.id).toBe('engineer');
    expect(buildPersonalitySection(own, 'the answer')).toContain('# PERSONALITY: Cracked engineer');
    // Without one (or with one since deleted) it is the workspace's, as before
    expect((await personalityForThread({ workspaceId: 'w1', agentId: 'a2' })).id).toBe('accountant');
    expect((await personalityForThread({ workspaceId: 'w1', agentId: 'a3' })).id).toBe('accountant');
    expect((await personalityForThread({ workspaceId: 'w1' })).id).toBe('accountant');
    expect((await personalityForThread(null)).id).toBe('default');
  });

  it('and its voice are kept by validation, shown in a diff, and kept through a drafted change', () => {
    const base = agentTemplate('team_research', 'UTC');
    const check = validateProfile({ ...base, voices: { kitten: 'Jasper', live: 'not-a-voice' } });
    expect(check.ok && check.profile.personalityId).toBe('engineer');
    expect(check.ok && check.profile.voices).toEqual({ kitten: 'Jasper' });
    const changes = diffProfiles(fieldsOf(base), { ...fieldsOf(base), voices: { kitten: 'Jasper' } });
    expect(changes).toEqual([{ field: 'voices', before: '', after: 'kitten: Jasper' }]);
    const current = { ...base, voices: { kitten: 'Jasper' } };
    const drafted = fromAuthoredAgent(toAuthoredAgent(current), 'UTC', current);
    expect(drafted.personalityId).toBe('engineer');
    expect(drafted.voices).toEqual({ kitten: 'Jasper' });
  });
});

describe("an agent's voice", () => {
  it('is its own, then its personality, then one from its name that Ava does not use', () => {
    const engineer = BUILTIN_PERSONALITIES.find(item => item.id === 'engineer')!;
    const ava = { live: 'Aoede', kitten: 'Bella', kokoro: 'af_heart' };
    const voices = agentVoices({ name: 'Research', voices: { kitten: 'Jasper' } }, engineer, ava);
    expect(voices.kitten).toBe('Jasper');
    expect(voices.live).toBe('Puck');
    const plain = agentVoices({ name: 'Mail', voices: {} }, null, ava);
    expect(plain.live).not.toBe('Aoede');
    expect(plain.kitten).not.toBe('Bella');
    expect(plain.kokoro).not.toBe('af_heart');
    expect(plain.system).toBeTruthy();
    // The same name always gets the same voices
    expect(fallbackVoices('Mail', [ava])).toEqual(fallbackVoices('Mail', [ava]));
  });

  it('comes with its name before each line', async () => {
    agents.a4 = { id: 'a4', name: 'Calendar', voices: { live: 'Leda' }, personalityId: null };
    const speaker = (await agentSpeaker('a4'))!;
    expect(speaker.name).toBe('Calendar');
    expect(speaker.voices.live).toBe('Leda');
    expect(await agentSpeaker('missing')).toBeNull();
    expect(spokenLine(speaker, '  Free at  three.\n')).toBe('Calendar: Free at three.');
    expect(spokenLine(speaker, '  ')).toBe('');
  });
});

describe('the starter templates', () => {
  it('give every team member its own personality or voices, none alike and none like Ava', () => {
    const ava = { live: 'Aoede', kitten: 'Bella', kokoro: 'af_heart' };
    const team = TEAM_TEMPLATE_IDS.map(id => {
      const profile = agentTemplate(id, 'UTC');
      const personality = BUILTIN_PERSONALITIES.find(item => item.id === profile.personalityId);
      return agentVoices(profile, personality, ava);
    });
    for (const slot of ['live', 'kitten', 'kokoro'] as const) {
      const voices = team.map(voices => voices[slot]);
      expect(new Set(voices).size, slot).toBe(team.length);
      expect(voices, slot).not.toContain(ava[slot]);
    }
    const personalities = TEAM_TEMPLATE_IDS.map(id => agentTemplate(id, 'UTC').personalityId).filter(Boolean);
    expect(new Set(personalities).size).toBe(personalities.length);
  });

  it('are all valid profiles with known personalities', () => {
    for (const id of AGENT_TEMPLATE_IDS) {
      const profile = agentTemplate(id, 'UTC');
      expect(validateProfile(profile).ok, id).toBe(true);
      if (profile.personalityId) {
        expect(
          BUILTIN_PERSONALITIES.some(item => item.id === profile.personalityId),
          id,
        ).toBe(true);
      }
    }
  });
});
