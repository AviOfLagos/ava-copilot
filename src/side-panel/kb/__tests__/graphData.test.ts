import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@extension/storage';
import {
  buildItemAgentIndex,
  capLinks,
  computeDegree,
  filterByScope,
  filterByType,
  filterEdges,
  levelOfDetail,
  matchesAgent,
  matchesTimeRange,
  nodeAgentIds,
  nodeRadius,
  pickVisible,
  topNodeIds,
} from '../graphData';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12);

function node(partial: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    type: 'project',
    label: partial.id,
    workspaceId: null,
    sourceItemIds: [],
    date: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function edge(from: string, to: string, kind: GraphEdge['kind'] = 'mentions'): GraphEdge {
  return { id: `${from}>${kind}>${to}`, from, to, kind, sourceItemId: from };
}

describe('buildItemAgentIndex / nodeAgentIds / matchesAgent', () => {
  it('looks up an item’s agent, defaulting to null', () => {
    const index = buildItemAgentIndex([
      { id: 'item-1', agentId: 'agent-a' },
      { id: 'item-2', agentId: null },
      { id: 'item-3' },
    ]);
    expect(index.get('item-1')).toBe('agent-a');
    expect(index.get('item-2')).toBeNull();
    expect(index.get('item-3')).toBeNull();
    expect(index.get('missing')).toBeUndefined();
  });

  it('derives a node’s agents from the items that mention it, never from the node itself', () => {
    const index = buildItemAgentIndex([
      { id: 'item-1', agentId: 'agent-a' },
      { id: 'item-2', agentId: 'agent-b' },
      { id: 'item-3', agentId: null },
    ]);
    const shared = node({ id: 'project:shared', sourceItemIds: ['item-1', 'item-2', 'item-3'] });
    expect(nodeAgentIds(shared, index)).toEqual(new Set(['agent-a', 'agent-b']));
    // A GraphNode type has no agentId field; this project proves it is never read for one
    expect('agentId' in shared).toBe(false);
  });

  it('a node mentioned by nothing known matches no agent', () => {
    const index = buildItemAgentIndex([]);
    expect(nodeAgentIds(node({ id: 'n', sourceItemIds: ['gone'] }), index)).toEqual(new Set());
  });

  it('matchesAgent: no agent picked matches everything; a picked agent matches only its own nodes', () => {
    const index = buildItemAgentIndex([
      { id: 'item-1', agentId: 'agent-a' },
      { id: 'item-2', agentId: 'agent-b' },
    ]);
    const a = node({ id: 'a', sourceItemIds: ['item-1'] });
    const b = node({ id: 'b', sourceItemIds: ['item-2'] });
    expect(matchesAgent(a, index, null)).toBe(true);
    expect(matchesAgent(b, index, null)).toBe(true);
    expect(matchesAgent(a, index, 'agent-a')).toBe(true);
    expect(matchesAgent(a, index, 'agent-b')).toBe(false);
    expect(matchesAgent(b, index, 'agent-a')).toBe(false);
  });

  it('a source node’s own item carries its agent (sourceItemIds includes itself)', () => {
    const index = buildItemAgentIndex([{ id: 'page:1', agentId: 'agent-a' }]);
    const source = node({ id: 'page:1', type: 'page', sourceItemIds: ['page:1'] });
    expect(matchesAgent(source, index, 'agent-a')).toBe(true);
    expect(matchesAgent(source, index, 'agent-b')).toBe(false);
  });
});

describe('matchesTimeRange', () => {
  const at = (daysAgo: number) => node({ id: 'n', date: NOW - daysAgo * DAY });

  it('"all" always matches, however old', () => {
    expect(matchesTimeRange(at(10000), 'all', NOW)).toBe(true);
  });

  it('7d matches today and the edge of the window, not just past it', () => {
    expect(matchesTimeRange(at(0), '7d', NOW)).toBe(true);
    expect(matchesTimeRange(at(7), '7d', NOW)).toBe(true);
    expect(matchesTimeRange(at(8), '7d', NOW)).toBe(false);
  });

  it('30d and 90d widen the window', () => {
    expect(matchesTimeRange(at(29), '30d', NOW)).toBe(true);
    expect(matchesTimeRange(at(31), '30d', NOW)).toBe(false);
    expect(matchesTimeRange(at(89), '90d', NOW)).toBe(true);
    expect(matchesTimeRange(at(91), '90d', NOW)).toBe(false);
  });
});

describe('filterByScope', () => {
  const index = buildItemAgentIndex([
    { id: 'item-a', agentId: 'agent-a' },
    { id: 'item-b', agentId: 'agent-b' },
  ]);
  const nodes = [
    node({ id: 'recent-a', sourceItemIds: ['item-a'], date: NOW }),
    node({ id: 'old-a', sourceItemIds: ['item-a'], date: NOW - 100 * DAY }),
    node({ id: 'recent-b', sourceItemIds: ['item-b'], date: NOW }),
  ];

  it('applies agent and time range together, not just one', () => {
    const result = filterByScope(nodes, index, { agentId: 'agent-a', timeRange: '30d' }, NOW);
    expect(result.map(n => n.id)).toEqual(['recent-a']);
  });

  it('no agent and "all" time keeps everything', () => {
    const result = filterByScope(nodes, index, { agentId: null, timeRange: 'all' });
    expect(result).toHaveLength(3);
  });
});

describe('filterByType', () => {
  const nodes = [
    node({ id: 'proj', type: 'project' }),
    node({ id: 'thread', type: 'thread' }),
    node({ id: 'note', type: 'note' }),
  ];

  it('drops hidden types', () => {
    const result = filterByType(nodes, new Set(['thread', 'note']), null);
    expect(result.map(n => n.id)).toEqual(['proj']);
  });

  it('keeps the focused node even if its type is hidden', () => {
    const result = filterByType(nodes, new Set(['thread', 'note']), 'thread');
    expect(result.map(n => n.id).sort()).toEqual(['proj', 'thread']);
  });
});

describe('filterEdges', () => {
  it('keeps only edges whose both ends survived', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')];
    const result = filterEdges(edges, new Set(['a', 'b']));
    expect(result.map(e => e.id)).toEqual([edge('a', 'b').id]);
  });
});

describe('computeDegree', () => {
  it('counts both ends of every edge', () => {
    const degree = computeDegree([edge('a', 'b'), edge('a', 'c'), edge('b', 'c')]);
    expect(degree.get('a')).toBe(2);
    expect(degree.get('b')).toBe(2);
    expect(degree.get('c')).toBe(2);
  });

  it('a node with no edges simply has no entry', () => {
    const degree = computeDegree([edge('a', 'b')]);
    expect(degree.get('z')).toBeUndefined();
  });
});

describe('pickVisible', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => node({ id: `n${i}` }));
  const degree = new Map(nodes.map((n, i) => [n.id, i])); // n9 busiest, n0 least

  it('sorts by degree, most connected first', () => {
    const result = pickVisible(nodes, degree, null, 10);
    expect(result.map(n => n.id)).toEqual(['n9', 'n8', 'n7', 'n6', 'n5', 'n4', 'n3', 'n2', 'n1', 'n0']);
  });

  it('caps at the given size', () => {
    const result = pickVisible(nodes, degree, null, 3);
    expect(result.map(n => n.id)).toEqual(['n9', 'n8', 'n7']);
  });

  it('keeps the focused node even past the cap, dropping the least connected instead', () => {
    const result = pickVisible(nodes, degree, 'n0', 3);
    expect(result.map(n => n.id)).toContain('n0');
    expect(result).toHaveLength(3);
  });

  it('an empty set stays empty', () => {
    expect(pickVisible([], new Map(), 'anything', 10)).toEqual([]);
  });
});

describe('topNodeIds', () => {
  it('returns the n busiest ids', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' }), node({ id: 'c' })];
    const degree = new Map([
      ['a', 1],
      ['b', 5],
      ['c', 3],
    ]);
    expect(topNodeIds(nodes, degree, 2)).toEqual(new Set(['b', 'c']));
  });
});

describe('levelOfDetail', () => {
  it('small graphs label generously and animate particles', () => {
    const lod = levelOfDetail(50, false);
    expect(lod.particles).toBe(true);
    expect(lod.topLabelCount).toBeGreaterThan(10);
  });

  it('turns particles off well before the node cap, regardless of motion preference', () => {
    expect(levelOfDetail(1500, false).particles).toBe(false);
  });

  it('respects reduced motion even for small graphs', () => {
    expect(levelOfDetail(10, true).particles).toBe(false);
  });

  it('labels fewer nodes by default as the graph grows', () => {
    const small = levelOfDetail(50, false);
    const big = levelOfDetail(1500, false);
    expect(big.topLabelCount).toBeLessThan(small.topLabelCount);
    expect(big.zoomLabelScale).toBeGreaterThan(small.zoomLabelScale);
  });
});

describe('nodeRadius', () => {
  it('a project outranks a note at the same degree', () => {
    expect(nodeRadius('project', 0)).toBeGreaterThan(nodeRadius('note', 0));
  });

  it('more connected nodes draw larger, but the bonus is capped', () => {
    const quiet = nodeRadius('project', 0);
    const busy = nodeRadius('project', 9);
    const hub = nodeRadius('project', 10000);
    expect(busy).toBeGreaterThan(quiet);
    expect(hub).toBeLessThanOrEqual(quiet + 6.0001);
  });
});

describe('capLinks', () => {
  // A hub-and-spoke: h is busy, the rest are quiet leaves
  const edges = [edge('h', 'a'), edge('h', 'b'), edge('h', 'c'), edge('d', 'e')];
  const degree = computeDegree(edges); // h:3, a/b/c:1 each, d:1, e:1

  it('keeps everything under the cap, unchanged', () => {
    expect(capLinks(edges, degree, 10)).toHaveLength(4);
  });

  it('keeps the busiest edges first when over the cap', () => {
    const result = capLinks(edges, degree, 2, null);
    expect(result).toHaveLength(2);
    // Every kept edge touches the hub; the quiet d-e edge loses out
    expect(result.every(e => e.from === 'h' || e.to === 'h')).toBe(true);
  });

  it('always keeps every link touching the node to preserve, even past the cap', () => {
    // d-e would normally lose to the hub's edges, but e is the node being preserved
    const result = capLinks(edges, degree, 1, 'e');
    expect(result.some(e => e.from === 'e' || e.to === 'e')).toBe(true);
  });

  it('an empty list stays empty', () => {
    expect(capLinks([], degree, 10)).toEqual([]);
  });
});
