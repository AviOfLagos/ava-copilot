import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb, GraphEdge, GraphNode } from '../threads/db';

/** One source's reading: its own node, what it talks about, and how they link. */
export interface GraphSlice {
  source: GraphNode;
  entities: GraphNode[];
  edges: Omit<GraphEdge, 'id' | 'sourceItemId'>[];
}

/** Lower case, single spaces, no punctuation at the ends: how names are compared. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

/** An entity's id: the same name in the same workspace is the same node. */
export function entityId(type: GraphNode['type'], workspaceId: string | null, name: string): string {
  return `${type}:${workspaceId ?? '-'}:${normalizeName(name)}`;
}

export function createGraphStore(db: AviCopilotDb = defaultDb) {
  /** Removes a source's links and its claim on entities; an entity nothing mentions any more goes too. */
  async function detach(sourceItemId: string): Promise<void> {
    await db.graphEdges.where('sourceItemId').equals(sourceItemId).delete();
    const claimed = await db.graphNodes.where('sourceItemIds').equals(sourceItemId).toArray();
    for (const node of claimed) {
      if (node.id === sourceItemId) continue;
      const rest = node.sourceItemIds.filter(id => id !== sourceItemId);
      if (rest.length === 0) await db.graphNodes.delete(node.id);
      else await db.graphNodes.update(node.id, { sourceItemIds: rest });
    }
  }

  return {
    node: (id: string) => db.graphNodes.get(id),
    nodes: (workspaceId?: string | null) =>
      workspaceId === undefined
        ? db.graphNodes.toArray()
        : db.graphNodes.filter(node => node.workspaceId === workspaceId || node.workspaceId === null).toArray(),
    edges: () => db.graphEdges.toArray(),
    count: () => db.graphNodes.count(),

    /** Every link of a node, with the node at its other end. */
    async neighbors(nodeId: string): Promise<{ edge: GraphEdge; node: GraphNode; outgoing: boolean }[]> {
      const [out, into] = await Promise.all([
        db.graphEdges.where('from').equals(nodeId).toArray(),
        db.graphEdges.where('to').equals(nodeId).toArray(),
      ]);
      const ends = await db.graphNodes.bulkGet([...out.map(edge => edge.to), ...into.map(edge => edge.from)]);
      const links = [...out.map(edge => ({ edge, outgoing: true })), ...into.map(edge => ({ edge, outgoing: false }))];
      return links.flatMap((link, index) => (ends[index] ? [{ ...link, node: ends[index]! }] : []));
    },

    /** Puts one source's reading in the graph, in place of its last one. */
    async replace(slice: GraphSlice): Promise<void> {
      const sourceItemId = slice.source.id;
      await db.transaction('rw', db.graphNodes, db.graphEdges, async () => {
        await detach(sourceItemId);
        await db.graphNodes.put({ ...slice.source, sourceItemIds: [sourceItemId] });
        for (const entity of slice.entities) {
          const existing = await db.graphNodes.get(entity.id);
          await db.graphNodes.put(
            existing
              ? {
                  ...existing,
                  sourceItemIds: [...new Set([...existing.sourceItemIds, sourceItemId])],
                  date: Math.min(existing.date, entity.date),
                  updatedAt: entity.updatedAt,
                }
              : { ...entity, sourceItemIds: [sourceItemId] },
          );
        }
        const seen = new Set<string>();
        const edges = slice.edges.flatMap(edge => {
          const id = `${edge.from}>${edge.kind}>${edge.to}@${sourceItemId}`;
          if (seen.has(id) || edge.from === edge.to) return [];
          seen.add(id);
          return [{ ...edge, id, sourceItemId }];
        });
        await db.graphEdges.bulkPut(edges);
      });
    },

    /** Takes a source and everything only it mentioned out of the graph. */
    async removeSource(sourceItemId: string): Promise<void> {
      await db.transaction('rw', db.graphNodes, db.graphEdges, async () => {
        await detach(sourceItemId);
        await db.graphNodes.delete(sourceItemId);
        await db.graphEdges.where('to').equals(sourceItemId).delete();
      });
    },

    async wipe(): Promise<void> {
      await db.transaction('rw', db.graphNodes, db.graphEdges, async () => {
        await db.graphNodes.clear();
        await db.graphEdges.clear();
      });
    },
  };
}

export type GraphStore = ReturnType<typeof createGraphStore>;
export const graphStore = createGraphStore();
