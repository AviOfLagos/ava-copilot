import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../../threads/db';
import type { GraphNode } from '../../threads/db';
import { createGraphStore, entityId, normalizeName } from '../graph';
import type { GraphStore } from '../graph';

let store: GraphStore;
beforeEach(() => {
  store = createGraphStore(new AviCopilotDb(`test-${crypto.randomUUID()}`));
});

const node = (id: string, type: GraphNode['type'], label: string, workspaceId: string | null = 'ws'): GraphNode => ({
  id,
  type,
  label,
  workspaceId,
  sourceItemIds: [],
  date: 1,
  updatedAt: 1,
});

const slice = (sourceId: string, projects: string[]) => {
  const source = node(sourceId, 'thread', sourceId);
  const entities = projects.map(name => node(entityId('project', 'ws', name), 'project', name));
  return { source, entities, edges: entities.map(e => ({ from: sourceId, to: e.id, kind: 'mentions' as const })) };
};

describe('graph store', () => {
  it('merges a project two sources name, and lets go of it only when neither does', async () => {
    await store.replace(slice('thread:a', ['Sponsor deck']));
    await store.replace(slice('thread:b', ['sponsor deck!']));
    const id = entityId('project', 'ws', 'Sponsor deck');
    expect((await store.node(id))?.sourceItemIds.sort()).toEqual(['thread:a', 'thread:b']);
    expect((await store.neighbors(id)).map(link => link.node.id).sort()).toEqual(['thread:a', 'thread:b']);

    await store.replace(slice('thread:a', []));
    expect((await store.node(id))?.sourceItemIds).toEqual(['thread:b']);
    await store.removeSource('thread:b');
    expect(await store.node(id)).toBeUndefined();
    expect(await store.node('thread:b')).toBeUndefined();
  });

  it('keeps the same name in two workspaces apart', () => {
    expect(entityId('project', 'nexprove', 'Launch')).not.toBe(entityId('project', 'tef', 'Launch'));
    expect(normalizeName('  The  Launch. ')).toBe('the launch');
  });

  it('lists a workspace with what belongs to none, never another workspace', async () => {
    await store.replace({ source: node('thread:x', 'thread', 'x', 'nexprove'), entities: [], edges: [] });
    await store.replace({ source: node('thread:y', 'thread', 'y', 'tef'), entities: [], edges: [] });
    await store.replace({ source: node('thread:z', 'thread', 'z', null), entities: [], edges: [] });
    expect((await store.nodes('nexprove')).map(n => n.id).sort()).toEqual(['thread:x', 'thread:z']);
  });
});
