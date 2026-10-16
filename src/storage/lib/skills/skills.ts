import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { skillHash } from './external';
import type { SkillCandidate } from './external';
import { parseSkill, skillId } from './parse';
import type { SkillRecord, SkillSource } from './parse';
import accountSwitching from './builtin/account-switching.md?raw';
import chatApps from './builtin/chat-apps.md?raw';
import gmail from './builtin/gmail.md?raw';
import googleForms from './builtin/google-forms.md?raw';
import whatsappWeb from './builtin/whatsapp-web.md?raw';

// The skills that ship with the extension: generic tips, never needed for the agent to work
export const BUILTIN_SKILL_FILES: Record<string, string> = {
  'chat-apps.md': chatApps,
  'account-switching.md': accountSwitching,
  'gmail.md': gmail,
  'google-forms.md': googleForms,
  'whatsapp-web.md': whatsappWeb,
};

export function builtinSkills(): SkillRecord[] {
  return Object.entries(BUILTIN_SKILL_FILES).map(([fileName, markdown]) => {
    const parsed = parseSkill(markdown, fileName);
    return { ...parsed, id: skillId(parsed.name), source: 'builtin', enabled: true, updatedAt: 0 };
  });
}

interface SkillsState {
  // The user's own skills: imported, taught or written
  skills: SkillRecord[];
  // Built-in skills the user turned off
  disabledBuiltins: string[];
}

const storage: BaseStorage<SkillsState> = createStorage<SkillsState>(
  'skills',
  { skills: [], disabledBuiltins: [] },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

async function state(): Promise<SkillsState> {
  const value = await storage.get();
  return { skills: value?.skills ?? [], disabledBuiltins: value?.disabledBuiltins ?? [] };
}

/** Whether a skill someone else wrote still waits for the user to read it and turn it on. */
export function awaitingReview(skill: SkillRecord): boolean {
  return skill.trust === 'external' && (!skill.sha256 || skill.approvedSha256 !== skill.sha256);
}

/** An id no other skill has: the name's slug, then "-2", "-3"… */
function freeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export const skillStore = {
  ...storage,

  /** Every skill: the user's own, then the built-in ones they did not replace. */
  async all(): Promise<SkillRecord[]> {
    const { skills, disabledBuiltins } = await state();
    const own = new Set(skills.map(skill => skill.id));
    const builtins = builtinSkills()
      .filter(skill => !own.has(skill.id))
      .map(skill => ({ ...skill, enabled: !disabledBuiltins.includes(skill.id) }));
    return [...skills, ...builtins];
  },

  /** The skills that may load: turned on, and for one someone else wrote, turned on as it reads now. */
  async enabled(): Promise<SkillRecord[]> {
    return (await skillStore.all()).filter(skill => skill.enabled && !awaitingReview(skill));
  },

  async get(id: string): Promise<SkillRecord | undefined> {
    return (await skillStore.all()).find(skill => skill.id === id);
  },

  /**
   * Saves a skill someone else wrote, turned off, for the user to review. Installing the same link again replaces
   * that skill (and it waits for review again); otherwise it never takes the name of a skill already here, not even
   * a built-in one, so it can never stand in for the user's own.
   */
  async install(candidate: SkillCandidate): Promise<SkillRecord> {
    const current = await state();
    const same = current.skills.find(
      skill => skill.trust === 'external' && skill.origin?.url && skill.origin.url === candidate.origin.url,
    );
    const taken = new Set([
      ...current.skills.filter(skill => skill !== same).map(skill => skill.id),
      ...builtinSkills().map(skill => skill.id),
    ]);
    const record: SkillRecord = {
      id: same?.id ?? freeId(skillId(candidate.name), taken),
      name: candidate.name,
      description: candidate.description,
      urls: candidate.urls,
      keywords: candidate.keywords,
      body: candidate.body,
      source: 'imported',
      enabled: false,
      updatedAt: Date.now(),
      trust: 'external',
      origin: { ...candidate.origin, installedAt: Date.now() },
      sha256: candidate.sha256,
      approvedSha256: null,
      references: candidate.references,
      dropped: candidate.dropped,
    };
    await storage.set({ ...current, skills: [record, ...current.skills.filter(skill => skill.id !== record.id)] });
    return record;
  },

  /**
   * "Turn on" on the review card: turns the skill on, as long as it still reads as the user saw it.
   *
   * @throws When the skill changed since the card was shown, or is gone
   */
  async approve(id: string, sha256: string): Promise<void> {
    const current = await state();
    const skill = current.skills.find(item => item.id === id);
    if (!skill) throw new Error('That skill is no longer here.');
    if (skill.trust === 'external' && skill.sha256 !== sha256) {
      throw new Error('This skill changed since you read it. Read it again before turning it on.');
    }
    await storage.set({
      ...current,
      skills: current.skills.map(item =>
        item.id === id ? { ...item, enabled: true, approvedSha256: item.sha256 ?? null, updatedAt: Date.now() } : item,
      ),
    });
  },

  /**
   * "Use this version" after "Check for update": the newer text the user just read in the diff replaces the old.
   * It stays on or off as it was, and counts as read.
   */
  async applyUpdate(id: string, candidate: SkillCandidate): Promise<SkillRecord> {
    const current = await state();
    const skill = current.skills.find(item => item.id === id);
    if (!skill || skill.trust !== 'external') throw new Error('That skill is no longer here.');
    const record: SkillRecord = {
      ...skill,
      name: candidate.name,
      description: candidate.description,
      urls: candidate.urls,
      keywords: candidate.keywords,
      body: candidate.body,
      references: candidate.references,
      dropped: candidate.dropped,
      sha256: candidate.sha256,
      approvedSha256: candidate.sha256,
      updatedAt: Date.now(),
    };
    await storage.set({ ...current, skills: current.skills.map(item => (item.id === id ? record : item)) });
    return record;
  },

  /**
   * Adds a skill from its Markdown, replacing one with the same name. A user skill named like a
   * built-in one replaces it.
   *
   * @throws When the file is not a valid skill
   */
  async save(markdown: string, source: SkillSource, fileName = ''): Promise<SkillRecord> {
    const parsed = parseSkill(markdown, fileName);
    const current = await state();
    const id = skillId(parsed.name);
    let record: SkillRecord = { ...parsed, id, source, enabled: true, updatedAt: Date.now() };
    const previous = current.skills.find(skill => skill.id === id);
    if (previous?.trust === 'external') {
      // Edited by the user, an installed skill is still mostly someone else's words: it keeps where it came from
      // and stays wrapped as untrusted, and the user's own edit counts as read
      const references = previous.references ?? [];
      const sha256 = await skillHash({ ...parsed, references });
      record = { ...previous, ...record, sha256, approvedSha256: sha256 };
    }
    await storage.set({ ...current, skills: [record, ...current.skills.filter(skill => skill.id !== record.id)] });
    return record;
  },

  /** @throws When turning on a skill someone else wrote that the user has not reviewed */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const current = await state();
    const own = current.skills.find(skill => skill.id === id);
    if (enabled && own && awaitingReview(own)) {
      throw new Error('Read this skill in Skills and turn it on from its review card.');
    }
    if (own) {
      await storage.set({
        ...current,
        skills: current.skills.map(skill => (skill.id === id ? { ...skill, enabled } : skill)),
      });
      return;
    }
    const disabled = new Set(current.disabledBuiltins);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    await storage.set({ ...current, disabledBuiltins: [...disabled] });
  },

  /** Removes a user skill. A built-in skill it replaced comes back. */
  async remove(id: string): Promise<void> {
    const current = await state();
    await storage.set({ ...current, skills: current.skills.filter(skill => skill.id !== id) });
  },
};
