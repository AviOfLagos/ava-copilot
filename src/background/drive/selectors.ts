import { builtinSkills, skillStore } from '@extension/storage';
import { mergeSelectors, parseSelectors } from '../whatsapp/selectors';
import type { WhatsappSelectors } from '../whatsapp/selectors';

/**
 * Where things are on Drive's and Docs' pages lives in the `google-drive` skill (its ```selectors block), not in
 * code, the same way as WhatsApp's: a user who edits the skill after Google changes its page fixes this feature
 * with no new release. Keys their copy leaves out come from the built-in skill.
 */

export const DRIVE_SKILL_ID = 'google-drive';

export type DriveSelectors = WhatsappSelectors;

export async function driveSelectors(): Promise<DriveSelectors> {
  const builtin = builtinSkills().find(skill => skill.id === DRIVE_SKILL_ID);
  const builtinSelectors = builtin ? parseSelectors(builtin.body) : {};
  const all = await skillStore.all().catch(() => []);
  const own = all.find(skill => skill.id === DRIVE_SKILL_ID && skill.source !== 'builtin');
  return mergeSelectors(own ? parseSelectors(own.body) : {}, builtinSelectors);
}
