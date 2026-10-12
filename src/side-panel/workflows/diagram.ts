import { graphlib, layout } from '@dagrejs/dagre';
import type { RunStep, RunStepStatus } from '@extension/storage';
import { edgeKey } from '@src/background/workflows/diff';
import type { NodeChange, SpecDiff } from '@src/background/workflows/diff';
import { NOT_YET_AVAILABLE } from '@src/background/workflows/spec';
import type { WorkflowEdge, WorkflowNode, WorkflowSpec } from '@src/background/workflows/spec';

/**
 * The diagram of a workflow as positioned nodes and edges: laid out top to bottom with dagre, lit by the
 * steps of a run (the wire fills as steps finish) and marked by a draft's diff (new, changed, removed).
 * Pure, so it is tested without a browser.
 */

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 62;

export interface FlowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  change: NodeChange | null;
  status: RunStepStatus | null;
  // A kind of step not built yet: it would stop a run
  unavailable: boolean;
}

export interface DiagramNode {
  id: string;
  type: 'flow';
  position: { x: number; y: number };
  width: number;
  height: number;
  data: FlowNodeData;
  ariaLabel: string;
}

export type WireState = 'idle' | 'done' | 'active' | 'added' | 'removed' | 'skipped';

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  when?: 'true' | 'false';
  state: WireState;
}

export interface DiagramInput {
  spec: WorkflowSpec;
  diff?: SpecDiff | null;
  steps?: RunStep[] | null;
}

/** The state of a wire: lit once its source finished, moving while its target runs, or the diff's mark. */
function wireState(edge: WorkflowEdge, diff: SpecDiff | null | undefined, steps: Map<string, RunStep>): WireState {
  const change = diff?.edges.get(edgeKey(edge));
  if (change) return change;
  const source = steps.get(edge.from);
  const target = steps.get(edge.to);
  if (target?.status === 'running' || target?.status === 'waiting_user') return 'active';
  if (target?.status === 'skipped') return 'skipped';
  if (source?.status === 'succeeded' && target && target.status !== 'queued') return 'done';
  return 'idle';
}

export function buildDiagram({ spec, diff, steps }: DiagramInput): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const byNode = new Map((steps ?? []).map(step => [step.nodeId, step]));
  const ghosts = diff?.removedNodes ?? [];
  const allNodes = [...spec.nodes, ...ghosts];
  const allEdges = [
    ...spec.edges,
    // Removed edges stay drawn while both ends are on the diagram
    ...(diff?.removedEdges ?? []).filter(
      edge => allNodes.some(node => node.id === edge.from) && allNodes.some(node => node.id === edge.to),
    ),
  ];

  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 20, ranksep: 34, marginx: 8, marginy: 8 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of allNodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of allEdges) graph.setEdge(edge.from, edge.to);
  layout(graph);

  const nodes: DiagramNode[] = allNodes.map(node => {
    const point = graph.node(node.id) as { x: number; y: number };
    const change = diff?.nodes.get(node.id) ?? null;
    const status = byNode.get(node.id)?.status ?? null;
    return {
      id: node.id,
      type: 'flow',
      position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: { node, change, status, unavailable: NOT_YET_AVAILABLE.has(node.type) },
      ariaLabel: [node.label, change, status].filter(Boolean).join(', '),
    };
  });
  const edges: DiagramEdge[] = allEdges.map(edge => ({
    id: edgeKey(edge),
    source: edge.from,
    target: edge.to,
    when: edge.when,
    state: wireState(edge, diff, byNode),
  }));
  return { nodes, edges };
}
