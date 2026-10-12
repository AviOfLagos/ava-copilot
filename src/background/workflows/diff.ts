import type { WorkflowEdge, WorkflowNode, WorkflowSpec } from './spec';

/**
 * What a draft changes compared with the version it replaces: nodes added, changed or removed (by id),
 * edges added or removed, and settings changed. The panel lights the diagram with it before the user
 * clicks Create or Apply.
 */

export type NodeChange = 'added' | 'changed' | 'removed';

export interface SpecDiff {
  nodes: Map<string, NodeChange>;
  // Nodes only the base has, to draw as ghosts
  removedNodes: WorkflowNode[];
  edges: Map<string, 'added' | 'removed'>;
  removedEdges: WorkflowEdge[];
  // Top-level settings that differ: name, description, allowHosts, budget
  settings: string[];
  // Hosts the draft may reach that the base could not
  newHosts: string[];
  counts: { added: number; changed: number; removed: number };
}

export const edgeKey = (edge: WorkflowEdge): string => `${edge.from}>${edge.to}${edge.when ? `:${edge.when}` : ''}`;

// Nodes are flat records, so sorting the keys makes equal nodes stringify the same
function stable(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

export function diffSpecs(base: WorkflowSpec | null, next: WorkflowSpec): SpecDiff {
  const nodes = new Map<string, NodeChange>();
  const edges = new Map<string, 'added' | 'removed'>();
  const before = new Map((base?.nodes ?? []).map(node => [node.id, node]));
  const after = new Map(next.nodes.map(node => [node.id, node]));

  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (!old) nodes.set(node.id, 'added');
    else if (stable(old) !== stable(node)) nodes.set(node.id, 'changed');
  }
  const removedNodes = (base?.nodes ?? []).filter(node => !after.has(node.id));
  for (const node of removedNodes) nodes.set(node.id, 'removed');

  const beforeEdges = new Map((base?.edges ?? []).map(edge => [edgeKey(edge), edge]));
  const afterEdges = new Set(next.edges.map(edgeKey));
  for (const edge of next.edges) if (!beforeEdges.has(edgeKey(edge))) edges.set(edgeKey(edge), 'added');
  const removedEdges = (base?.edges ?? []).filter(edge => !afterEdges.has(edgeKey(edge)));
  for (const edge of removedEdges) edges.set(edgeKey(edge), 'removed');

  const settings: string[] = [];
  if (base) {
    if (base.name !== next.name) settings.push('name');
    if (base.description !== next.description) settings.push('description');
    if (JSON.stringify([...base.allowHosts].sort()) !== JSON.stringify([...next.allowHosts].sort())) {
      settings.push('allowHosts');
    }
    if (stable(base.budget) !== stable(next.budget)) settings.push('budget');
  }
  const newHosts = next.allowHosts.filter(host => !(base?.allowHosts ?? []).includes(host));

  const count = (change: NodeChange) => [...nodes.values()].filter(value => value === change).length;
  return {
    nodes,
    removedNodes,
    edges,
    removedEdges,
    settings,
    newHosts,
    counts: { added: count('added'), changed: count('changed'), removed: count('removed') },
  };
}
