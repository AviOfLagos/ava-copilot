import type { GraphEdge, GraphNode, GraphNodeType } from '@extension/storage';

/**
 * Pure data shaping for the knowledge graph view: filters (agent, time range, type), degree,
 * what to actually draw, and how much detail to show at a given size. No DOM, no canvas, no
 * Dexie — so it is cheap to unit test and cheap to re-run on every render.
 */

export type TimeRange = '7d' | '30d' | '90d' | 'all';

export const TIME_RANGES: readonly TimeRange[] = ['7d', '30d', '90d', 'all'];

// How many days back each range reaches; null is "no limit"
const TIME_RANGE_DAYS: Record<TimeRange, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// The map shows at most this many nodes: the most connected ones, a knob on the ~2 000 node cap
export const MAX_SHOWN_NODES = 2000;

/** A knowledge item reduced to what the graph needs from it: its id and the agent whose work it was. */
export interface AgentOwned {
  id: string;
  agentId?: string | null;
}

/** Looks up a knowledge item's agent by its id, or null when it has none or is unknown. */
export type ItemAgentIndex = ReadonlyMap<string, string | null>;

export function buildItemAgentIndex(items: readonly AgentOwned[]): ItemAgentIndex {
  return new Map(items.map(item => [item.id, item.agentId ?? null]));
}

/**
 * The agents behind a node: a source node's own item, or every item that named an entity. Nodes
 * never carry an agentId of their own; it is always looked up through sourceItemIds.
 */
export function nodeAgentIds(node: Pick<GraphNode, 'sourceItemIds'>, index: ItemAgentIndex): Set<string> {
  const ids = new Set<string>();
  for (const itemId of node.sourceItemIds) {
    const agentId = index.get(itemId);
    if (agentId) ids.add(agentId);
  }
  return ids;
}

/** Whether a node belongs to the given agent; no agent picked (null) always matches. */
export function matchesAgent(
  node: Pick<GraphNode, 'sourceItemIds'>,
  index: ItemAgentIndex,
  agentId: string | null,
): boolean {
  return !agentId || nodeAgentIds(node, index).has(agentId);
}

/** Whether a node's date falls in the given range; 'all' always matches. */
export function matchesTimeRange(node: Pick<GraphNode, 'date'>, range: TimeRange, now = Date.now()): boolean {
  const days = TIME_RANGE_DAYS[range];
  return days == null || node.date >= now - days * DAY_MS;
}

export interface ScopeFilters {
  agentId: string | null;
  timeRange: TimeRange;
}

/**
 * The nodes in scope before type chips narrow what is drawn: a node's workspace is already applied
 * by the query that fetched it, so this is agent and time range only. Degree and the "most
 * connected" ranking are computed from this set, not the type-filtered one, so toggling a type
 * chip never changes how connected something is.
 */
export function filterByScope(
  nodes: readonly GraphNode[],
  index: ItemAgentIndex,
  filters: ScopeFilters,
  now = Date.now(),
): GraphNode[] {
  return nodes.filter(node => matchesAgent(node, index, filters.agentId) && matchesTimeRange(node, filters.timeRange, now));
}

/** The scoped nodes actually eligible to draw: type chips apply here; the focused node is always kept. */
export function filterByType(
  nodes: readonly GraphNode[],
  hiddenTypes: ReadonlySet<GraphNodeType>,
  focusId: string | null,
): GraphNode[] {
  return nodes.filter(node => node.id === focusId || !hiddenTypes.has(node.type));
}

/** Edges whose two ends are both in the given set of node ids. */
export function filterEdges(edges: readonly GraphEdge[], nodeIds: ReadonlySet<string>): GraphEdge[] {
  return edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
}

/** How many edges touch each node, counting both ends. */
export function computeDegree(edges: readonly Pick<GraphEdge, 'from' | 'to'>[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const edge of edges) {
    count.set(edge.from, (count.get(edge.from) ?? 0) + 1);
    count.set(edge.to, (count.get(edge.to) ?? 0) + 1);
  }
  return count;
}

/** The busiest nodes first; the focused node is kept even past the cap. */
export function pickVisible(
  nodes: readonly GraphNode[],
  degree: ReadonlyMap<string, number>,
  focusId: string | null,
  cap = MAX_SHOWN_NODES,
): GraphNode[] {
  const sorted = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  if (sorted.length <= cap) return sorted;
  const kept = sorted.slice(0, cap);
  if (focusId && !kept.some(node => node.id === focusId)) {
    const focus = sorted.find(node => node.id === focusId);
    if (focus) kept[kept.length - 1] = focus;
  }
  return kept;
}

/** The most connected ids, for always-on labels and the "most connected" list. */
export function topNodeIds(
  nodes: readonly GraphNode[],
  degree: ReadonlyMap<string, number>,
  count: number,
): Set<string> {
  return new Set(
    [...nodes]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, count)
      .map(node => node.id),
  );
}

export interface LevelOfDetail {
  // How many of the busiest nodes are always labelled, however far the view is zoomed out
  topLabelCount: number;
  // Above this zoom level (globalScale from the canvas paint callback) every visible node is labelled
  zoomLabelScale: number;
  // Particles travel the focused node's links; turned off once there are too many nodes to animate, or when
  // the caller says motion is unwanted
  particles: boolean;
  // At most this many links are drawn (the focused node's own links are always kept on top of this).
  // A dense graph has far more edges than nodes, and even a faint stroke repeated thousands of times
  // over the same pixels composites toward solid black; thinning the edges drawn is what actually
  // keeps a big graph legible, not just fewer labels.
  maxLinks: number;
}

/** How much detail the view can afford at this size: fewer, later labels, fewer links and no particles
 * once it is big. */
export function levelOfDetail(shownCount: number, reducedMotion: boolean): LevelOfDetail {
  if (shownCount <= 200)
    return { topLabelCount: 15, zoomLabelScale: 1.4, particles: !reducedMotion, maxLinks: Infinity };
  if (shownCount <= 800) return { topLabelCount: 10, zoomLabelScale: 2, particles: !reducedMotion, maxLinks: 1500 };
  return { topLabelCount: 6, zoomLabelScale: 3, particles: false, maxLinks: 600 };
}

/**
 * The links actually drawn: the ones joining the busiest nodes first (they read as the graph's real
 * structure), always keeping every link touching keepNodeId (typically the focus or hovered node) so
 * highlighting one never shows it with links missing.
 */
export function capLinks(
  edges: readonly GraphEdge[],
  degree: ReadonlyMap<string, number>,
  maxLinks: number,
  keepNodeId: string | null = null,
): GraphEdge[] {
  if (edges.length <= maxLinks) return [...edges];
  const weight = (edge: GraphEdge) => (degree.get(edge.from) ?? 0) + (degree.get(edge.to) ?? 0);
  const touchesKept = (edge: GraphEdge) => edge.from === keepNodeId || edge.to === keepNodeId;
  const always = keepNodeId ? edges.filter(touchesKept) : [];
  const rest = (keepNodeId ? edges.filter(edge => !touchesKept(edge)) : [...edges]).sort(
    (a, b) => weight(b) - weight(a),
  );
  return [...always, ...rest.slice(0, Math.max(0, maxLinks - always.length))];
}

// A node's radius at its base size (by type) before its degree bonus
export const TYPE_BASE_SIZE: Record<GraphNodeType, number> = {
  project: 7,
  person: 6,
  organization: 6,
  decision: 4.5,
  action: 4.5,
  thread: 3.5,
  meeting: 4,
  page: 3.5,
  note: 3.5,
  'ai-session': 3.5,
  ambient: 3.5,
};

/** A node's drawn radius: its type's base size, plus a little for how connected it is, capped so hubs stay readable. */
export function nodeRadius(type: GraphNodeType, degree: number): number {
  return TYPE_BASE_SIZE[type] + Math.min(6, Math.sqrt(degree));
}
