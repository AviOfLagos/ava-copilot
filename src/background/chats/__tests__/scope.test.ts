import { describe, expect, it, vi } from 'vitest';

// Three chats in two workspaces and one outside any, plus a routine's chat
const threads = [
  { id: 'n1', title: 'Nexprove pricing', updatedAt: 3, workspaceId: 'nexprove' },
  { id: 'e1', title: 'Ellum pricing', updatedAt: 2, workspaceId: 'ellum' },
  { id: 'g1', title: 'General pricing', updatedAt: 1, workspaceId: null },
  { id: 'r1', title: 'Routine run', updatedAt: 4, workspaceId: 'nexprove', origin: 'workflow' },
];
const messages = threads.map((thread, index) => ({
  id: `m${index}`,
  threadId: thread.id,
  seq: 1,
  role: 'user',
  content: `the pricing plan for ${thread.title}`,
  createdAt: index,
}));

vi.mock('@extension/storage', () => ({
  db: {
    threads: { toArray: async () => threads },
    messages: { filter: (keep: (m: unknown) => boolean) => ({ toArray: async () => messages.filter(keep) }) },
  },
  threadStore: {
    get: async (id: string) => threads.find(thread => thread.id === id),
    messages: async (id: string) => messages.filter(message => message.threadId === id),
  },
  workspaceStore: {
    list: async () => [
      { id: 'nexprove', name: 'Nexprove' },
      { id: 'ellum', name: 'Ellum AI' },
    ],
    get: async (id: string) => ({ id, name: id }),
  },
}));
vi.mock('../../registry', () => ({ registerAgentAction: () => {}, registerVoiceTool: () => {} }));
vi.mock('../../registry/services', () => ({ services: () => ({ voice: { currentThreadId: null } }) }));
vi.mock('../../threads/factory', () => ({ resolveModels: async () => ({ planner: {} }) }));
vi.mock('../../llm/generate', () => ({ generatePlainText: async () => 'summary' }));

const { readChat, searchChats } = await import('../register');

describe('what a chat may see of other chats', () => {
  it('inside a workspace: only that workspace, whatever workspace the model names', async () => {
    const text = await searchChats('pricing', { from: 'n1', workspace: 'Ellum AI' });
    expect(text).not.toContain('Ellum pricing');
    expect(text).not.toContain('General pricing');
    expect(await readChat('e1', 20, 's', 'n1')).toMatch(/no chat with that id here/);
  });

  it('outside a workspace: every chat', async () => {
    const text = await searchChats('pricing', { from: 'g1' });
    expect(text).toContain('Nexprove pricing');
    expect(text).toContain('Ellum pricing');
  });

  it('in a run an agent or a routine started: none', async () => {
    expect(await searchChats('pricing', { from: 'r1' })).toMatch(/not available/);
    expect(await readChat('n1', 20, 's', 'r1')).toMatch(/not available/);
  });
});
