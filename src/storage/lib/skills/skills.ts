import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { parseSkill, skillId } from './parse';
import type { SkillRecord, SkillSource } from './parse';
import accountSwitching from './builtin/account-switching.md?raw';
import chatApps from './builtin/chat-apps.md?raw';
import gmail from './builtin/gmail.md?raw';
import googleDrive from './builtin/google-drive.md?raw';
import googleForms from './builtin/google-forms.md?raw';
import whatsappWeb from './builtin/whatsapp-web.md?raw';

// The skills that ship with the extension: generic tips, never needed for the agent to work
export const BUILTIN_SKILL_FILES: Record<string, string> = {
  'chat-apps.md': chatApps,
  'account-switching.md': accountSwitching,
  'gmail.md': gmail,
  'google-forms.md': googleForms,
  'google-drive.md': googleDrive,
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

  async enabled(): Promise<SkillRecord[]> {
    return (await skillStore.all()).filter(skill => skill.enabled);
  },

  /**
   * Adds a skill from its Markdown, replacing one with the same name. A user skill named like a
   * built-in one replaces it.
   *
   * @throws When the file is not a valid skill
   */
  async save(markdown: string, source: SkillSource, fileName = ''): Promise<SkillRecord> {
    const parsed = parseSkill(markdown, fileName);
    const record: SkillRecord = { ...parsed, id: skillId(parsed.name), source, enabled: true, updatedAt: Date.now() };
    const current = await state();
    await storage.set({ ...current, skills: [record, ...current.skills.filter(skill => skill.id !== record.id)] });
    return record;
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const current = await state();
    if (current.skills.some(skill => skill.id === id)) {
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
