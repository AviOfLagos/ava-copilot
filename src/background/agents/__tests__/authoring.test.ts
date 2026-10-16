import { describe, expect, it } from 'vitest';
import {
  AGENT_AUTHORING_MARKER,
  authoredAgentSchema,
  authorAgent,
  fromAuthoredAgent,
  toAuthoredAgent,
} from '../authoring';
import type { AuthoredAgent } from '../authoring';
import { validateProfile } from '../profile';
import { profile } from './fixtures';

const now = Date.UTC(2026, 9, 12, 9);

const answer = (overrides: Partial<AuthoredAgent> = {}): AuthoredAgent => ({
  name: 'Mentions watcher',
  avatar: '👀',
  instructions: 'Read my newest X mentions and list the ones that need a reply. Never reply or post.',
  modelRole: 'fast',
  startUrl: '',
  domains: ['x.com'],
  triggers: [
    { type: 'tab', value: 'x.com/notifications*' },
    { type: 'schedule', value: '0 9 * * 1-5' },
  ],
  publishes: [],
  skills: [],
  dailyUsd: 0.5,
  maxStepsPerRun: 15,
  runsPerDay: 12,
  owns: [],
  charter: '',
  ...overrides,
});

describe('authoring an agent', () => {
  it('turns the model answer into a valid profile', () => {
    expect(authoredAgentSchema.safeParse(answer()).success).toBe(true);
    const check = validateProfile(fromAuthoredAgent(answer(), 'Europe/Lisbon', null, 'ws-1'), now);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.profile).toMatchObject({
      name: 'Mentions watcher',
      modelRole: 'fast',
      domains: ['x.com'],
      workspaceId: 'ws-1',
      budget: { dailyUsd: 0.5, maxStepsPerRun: 15, runsPerDay: 12 },
    });
    expect(check.profile.triggers).toContainEqual({ type: 'schedule', cron: '0 9 * * 1-5', timezone: 'Europe/Lisbon' });
  });

  it('keeps what the model does not write from the agent as it is, and a 0 cap means none of its own', () => {
    const current = profile({ connectors: ['slack'], workspaceId: 'ws-2', inboxResults: false });
    const candidate = fromAuthoredAgent(answer({ dailyUsd: 0 }), 'UTC', current) as {
      connectors: string[];
      workspaceId: string;
      inboxResults: boolean;
      budget: { dailyUsd: number | null };
    };
    expect(candidate.connectors).toEqual(['slack']);
    expect(candidate.workspaceId).toBe('ws-2');
    expect(candidate.inboxResults).toBe(false);
    expect(candidate.budget.dailyUsd).toBeNull();
  });

  it('asks once more when the first answer has problems, with the problems', async () => {
    const prompts: { system: string; user: string }[] = [];
    const result = await authorAgent({
      request: 'watch my mentions',
      timezone: 'UTC',
      now,
      generate: async prompt => {
        prompts.push(prompt);
        return prompts.length === 1 ? answer({ triggers: [{ type: 'tab', value: '*' }] }) : answer();
      },
    });
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0].system).toContain(AGENT_AUTHORING_MARKER);
    expect(prompts[1].user).toMatch(/It has these problems:[\s\S]*every site/);
  });

  it('gives up with a plain sentence when the second answer is still wrong', async () => {
    const result = await authorAgent({
      request: 'watch everything',
      timezone: 'UTC',
      now,
      generate: async () => answer({ triggers: [{ type: 'schedule', value: '* * * * *' }] }),
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/too often/);
  });

  it('shows the model the agent as it is when changing it', async () => {
    const current = profile({ name: 'Scout', domains: ['example.com'] });
    let seen = '';
    await authorAgent({
      request: 'also watch example.com/blog',
      current,
      timezone: 'UTC',
      now,
      generate: async ({ user }) => {
        seen = user;
        return toAuthoredAgent(current);
      },
    });
    expect(seen).toContain('"name":"Scout"');
    expect(seen).toContain('also watch example.com/blog');
    expect(authoredAgentSchema.safeParse(toAuthoredAgent(current)).success).toBe(true);
  });
});
