import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AviCopilotDb,
  createGraphStore,
  createKbStore,
  createMeetingStore,
  createThreadStore,
} from '@extension/storage';

vi.mock('../../threads/factory', () => ({ resolveModels: vi.fn() }));
const generateStructured = vi.fn();
vi.mock('../../llm/generate', () => ({ generateStructured: (...args: unknown[]) => generateStructured(...args) }));

const { GraphBuilder } = await import('../builder');

let db: AviCopilotDb;
let builder: InstanceType<typeof GraphBuilder>;
let kb: ReturnType<typeof createKbStore>;
let graph: ReturnType<typeof createGraphStore>;

beforeEach(() => {
  db = new AviCopilotDb(`test-${crypto.randomUUID()}`);
  kb = createKbStore(db);
  graph = createGraphStore(db);
  generateStructured.mockReset();
  builder = new GraphBuilder({
    graph,
    kb,
    threads: createThreadStore(db),
    meetings: createMeetingStore(db),
    model: async () => ({}) as never,
    overCap: async () => false,
    enabled: async () => true,
  });
});

async function savePage(text: string) {
  await kb.put(
    {
      id: 'page:https://a.test',
      sourceType: 'page',
      sourceId: 'https://a.test',
      title: 'Plan',
      url: 'https://a.test',
      sourceDate: 1,
      sourceUpdatedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      chunkCount: 1,
      unembedded: 0,
      workspaceId: 'nexprove',
    },
    [
      {
        id: 'page:https://a.test#0',
        itemId: 'page:https://a.test',
        index: 0,
        text,
        label: '',
        anchor: { kind: 'page', url: 'https://a.test' },
        hash: 'x',
        vector: null,
        embedModel: null,
      },
    ],
  );
}

describe('GraphBuilder', () => {
  it('reads a new item once, and an unchanged one never again', async () => {
    generateStructured.mockResolvedValue({
      output: { people: ['Ada'], organizations: [], projects: ['Atlas'], decisions: [], actions: [] },
    });
    await savePage('Ada leads Atlas');
    await builder.handle({ type: 'put', itemId: 'page:https://a.test' });
    await builder.handle({ type: 'put', itemId: 'page:https://a.test' });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(await graph.node('project:nexprove:atlas')).toBeTruthy();
    // The page is passed as data, never as instructions
    expect(JSON.stringify(generateStructured.mock.calls[0][0].messages)).toMatch(/untrusted/i);

    await kb.remove('page:https://a.test');
    await builder.handle({ type: 'remove', itemId: 'page:https://a.test' });
    expect(await graph.count()).toBe(0);
  });

  it('still puts the item in the graph when the model fails', async () => {
    generateStructured.mockRejectedValue(new Error('offline'));
    await savePage('Something');
    await builder.sync();
    expect((await graph.node('page:https://a.test'))?.type).toBe('page');
  });
});
