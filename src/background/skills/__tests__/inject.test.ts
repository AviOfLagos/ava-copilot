import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillRecord } from '@extension/storage';
import type { AgentContext } from '../../agent/types';
import { enT } from './en';

vi.mock('@extension/i18n', () => ({ t: enT }));

const enabled = vi.fn<() => Promise<SkillRecord[]>>();
vi.mock('@extension/storage', async importOriginal => ({
  ...(await importOriginal<typeof import('@extension/storage')>()),
  skillStore: { enabled: () => enabled() },
}));

const { skillSectionFor } = await import('../inject');

const accountSwitching: SkillRecord = {
  id: 'account-switching',
  name: 'account-switching',
  description: '',
  urls: ['*.google.com/*'],
  keywords: ['switch account'],
  body: 'Check first, then switch.',
  source: 'builtin',
  enabled: true,
  updatedAt: 0,
} as SkillRecord;

function contextFor(task: string) {
  const notices: string[] = [];
  const context = {
    taskId: `t-${Math.random()}`,
    tasks: [task],
    emitEvent: (_actor: string, _state: string, details: string) => notices.push(details),
  } as unknown as AgentContext;
  return { context, notices };
}

describe('skillSectionFor', () => {
  beforeEach(() => enabled.mockResolvedValue([accountSwitching]));

  it('uses no skill for "Hi", even with a Google tab in front', async () => {
    const { context, notices } = contextFor('Hi');
    expect(await skillSectionFor(context, 'https://mail.google.com/mail/u/0/')).toBe('');
    expect(notices).toEqual([]);
  });

  it('still uses the skill for a task on that page', async () => {
    const { context, notices } = contextFor('Archive the newsletters');
    expect(await skillSectionFor(context, 'https://mail.google.com/mail/u/0/')).toContain('account-switching');
    expect(notices).toEqual(['Using skill /account-switching']);
  });
});
