import type { AgentProfileFields } from '@extension/storage';
import { DEFAULT_AGENT_BUDGET } from './profile';

/** Ready-made agents the user starts from in the panel. Each becomes a draft to check and create. */

export const AGENT_TEMPLATE_IDS = ['social_watcher', 'research_scout'] as const;
export type AgentTemplateId = (typeof AGENT_TEMPLATE_IDS)[number];

export function agentTemplate(id: AgentTemplateId, timezone: string): AgentProfileFields {
  switch (id) {
    case 'social_watcher':
      return {
        name: 'Social media watcher',
        avatar: '👀',
        instructions:
          'When a social media page I open changes (X or LinkedIn), open the same page and read the newest posts, mentions and messages on it. List what needs my reply or attention: who, what they said in one line, and the link. Say "Nothing new" when there is nothing. Never like, reply, follow, repost or post anything.',
        skills: [],
        connectors: [],
        domains: ['x.com', 'linkedin.com'],
        modelRole: 'fast',
        workspaceId: null,
        executor: 'browser',
        triggers: [
          { type: 'tab', urlPattern: 'x.com/*' },
          { type: 'tab', urlPattern: '*.linkedin.com/feed*' },
        ],
        subscribes: [],
        publishes: ['social.mentions'],
        budget: { dailyUsd: 0.5, maxStepsPerRun: 15, runsPerDay: 20 },
        startUrl: null,
        inboxResults: true,
      };
    case 'research_scout':
      return {
        name: 'Research scout',
        avatar: '🔭',
        instructions:
          'Search the web for the latest news on AI agents and browser automation. Open the three most relevant results from the last few days and write a short brief: a title, two lines on why it matters, and the link for each. Never sign in, buy, subscribe or post anything.',
        skills: [],
        connectors: [],
        domains: [],
        modelRole: 'smart',
        workspaceId: null,
        executor: 'browser',
        triggers: [{ type: 'schedule', cron: '0 8 * * 1-5', timezone }, { type: 'manual' }],
        subscribes: [],
        publishes: ['research.brief'],
        budget: { ...DEFAULT_AGENT_BUDGET, runsPerDay: 3 },
        startUrl: 'https://www.google.com/',
        inboxResults: true,
      };
  }
}
