import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({ default: {} }));

// The drafting call: a separate structured model call, scripted here
const generated = vi.hoisted(() => ({ calls: [] as { system: string; user: string }[], answer: null as unknown }));
vi.mock('../../llm/generate', async importOriginal => ({
  ...(await importOriginal<object>()),
  generateStructured: async ({ messages }: { messages: { role: string; content: unknown }[] }) => {
    const text = (message?: { content: unknown }) =>
      typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? (message.content as { text?: string }[]).map(part => part.text ?? '').join('')
          : '';
    generated.calls.push({ system: text(messages[0]), user: text(messages[1]) });
    return { output: generated.answer };
  },
}));
vi.mock('../../workflows/models', () => ({ workflowModel: async () => ({ provider: 'mock', modelName: 'scripted' }) }));

const { db, threadStore } = await import('@extension/storage');
const { registeredActions } = await import('../../registry');
const { registerAgentActions } = await import('../actions');
const { AGENT_AUTHORING_MARKER } = await import('../authoring');
import type { AgentProfileFields } from '@extension/storage';
import type { AgentContext } from '../../agent/types';

const drafts: { profile: AgentProfileFields; request: string; agentId?: string | null }[] = [];
const runs: string[] = [];
const service = {
  saveDraft: async (args: { profile: AgentProfileFields; request: string; agentId?: string | null }) => {
    drafts.push(args);
    return { id: 'agent-new', name: args.profile.name };
  },
  requestRun: async (agentId: string) => {
    runs.push(agentId);
    return { id: 'run-1' };
  },
};
registerAgentActions(service as never);

const context = (taskId: string) =>
  ({
    taskId,
    emitEvent: async () => {},
    controller: new AbortController(),
  }) as unknown as AgentContext;

const action = (taskId: string, name: string) => {
  const found = registeredActions(context(taskId)).find(item => item.name() === name);
  if (!found) throw new Error(`No action ${name}`);
  return found;
};

beforeEach(async () => {
  drafts.length = 0;
  runs.length = 0;
  generated.calls.length = 0;
  generated.answer = {
    name: 'Mentions watcher',
    avatar: '👀',
    instructions: 'List my new X mentions. Never reply.',
    modelRole: 'fast',
    startUrl: '',
    domains: ['x.com'],
    triggers: [{ type: 'tab', value: 'x.com/notifications*' }],
    publishes: [],
    skills: [],
    dailyUsd: 0.5,
    maxStepsPerRun: 15,
    runsPerDay: 12,
  };
  await db.agents.clear();
});

describe('agent actions in a chat', () => {
  it('drafts an agent with a separate structured call, as a draft only', async () => {
    const chat = await threadStore.create({ origin: 'user', workspaceId: 'ws-1' });
    const result = await action(chat.id, 'create_agent').call({ intent: '', request: 'watch my X mentions' });
    expect(result.error).toBeFalsy();
    expect(result.extractedContent).toMatch(/only a draft/);
    expect(generated.calls).toHaveLength(1);
    expect(generated.calls[0].system).toContain(AGENT_AUTHORING_MARKER);
    expect(generated.calls[0].user).toContain('watch my X mentions');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].profile).toMatchObject({ name: 'Mentions watcher', workspaceId: 'ws-1', domains: ['x.com'] });
  });

  it('refuses to create, change or run agents in a chat an agent or a routine started', async () => {
    for (const origin of ['agent', 'workflow'] as const) {
      const chat = await threadStore.create({ origin });
      const created = await action(chat.id, 'create_agent').call({ intent: '', request: 'make another agent' });
      expect(created.error).toMatch(/only be created, changed or run from a chat with the user/);
      const changed = await action(chat.id, 'update_agent').call({ intent: '', id: 'x', change: 'y' });
      expect(changed.error).toMatch(/only be created/);
      const ran = await action(chat.id, 'run_agent').call({ intent: '', id: 'x', task: '' });
      expect(ran.error).toMatch(/only be created/);
    }
    expect(generated.calls).toEqual([]);
    expect(drafts).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('lists the agents a chat may see', async () => {
    const chat = await threadStore.create({ origin: 'user', workspaceId: 'ws-1' });
    const result = await action(chat.id, 'list_agents').call({ intent: '' });
    expect(result.extractedContent).toBe('The user has no agents yet.');
  });
});
