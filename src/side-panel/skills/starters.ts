import type { t } from '@extension/i18n';

type MessageKey = Parameters<typeof t>[0];

/**
 * Collections of skills others share, offered under "Find skills". Only listed here: nothing is fetched until the
 * user clicks Browse, and every skill from them goes through the same review as a pasted link.
 */
export interface SkillStarter {
  id: string;
  name: string;
  url: string;
  about: MessageKey;
}

export const SKILL_STARTERS: SkillStarter[] = [
  {
    id: 'anthropic',
    name: 'anthropics/skills',
    url: 'https://github.com/anthropics/skills',
    about: 'skills_starter_anthropic',
  },
];
