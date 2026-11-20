import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const map = new Map<string, unknown>();
  const area = {
    get: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => map.has(key)).map(key => [key, structuredClone(map.get(key))]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
    remove: async () => {},
    onChanged: { addListener: () => {} },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: area, session: area, onChanged: { addListener: () => {} } },
    runtime: { id: 'test' },
  };
});

const { chatHistoryStore } = await import('../index');

describe('task history kept for replay', () => {
  // Chats live in the threads database now: a task's id is never a chat session here, and keeping its steps
  // must not fail (it once turned every finished answer into "Session with ID … not found")
  it('keeps and loads a task’s steps by the task’s id, with no chat session of that id', async () => {
    await expect(
      chatHistoryStore.storeAgentStepHistory('task-1', 'open the news', '[{"step":1}]'),
    ).resolves.toBeUndefined();
    expect(await chatHistoryStore.loadAgentStepHistory('task-1')).toMatchObject({
      task: 'open the news',
      history: '[{"step":1}]',
    });
  });
});
