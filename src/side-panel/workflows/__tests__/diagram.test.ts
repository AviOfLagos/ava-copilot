import { describe, expect, it } from 'vitest';
import type { RunStep } from '@extension/storage';
import { diffSpecs } from '@src/background/workflows/diff';
import { morningTechNews } from '@src/background/workflows/templates';
import type { WorkflowSpec } from '@src/background/workflows/spec';
import { buildDiagram, NODE_HEIGHT } from '../diagram';

const spec = morningTechNews('UTC');

function step(nodeId: string, status: RunStep['status']): RunStep {
  return {
    id: nodeId,
    runId: 'r',
    nodeId,
    index: 0,
    status,
    sideEffect: false,
    attempts: 1,
    startedAt: null,
    endedAt: null,
    input: null,
    output: null,
    error: null,
  };
}

describe('buildDiagram', () => {
  it('lays the nodes out top to bottom, with parallel steps side by side', () => {
    const { nodes, edges } = buildDiagram({ spec });
    const at = (id: string) => nodes.find(node => node.id === id)!.position;
    expect(at('morning').y).toBeLessThan(at('hn').y);
    expect(at('hn').y).toBe(at('hf').y);
    expect(at('hn').x).not.toBe(at('hf').x);
    expect(at('pick').y).toBeGreaterThanOrEqual(at('hn').y + NODE_HEIGHT);
    expect(at('brief').y).toBeGreaterThan(at('pick').y);
    expect(edges.map(edge => edge.id)).toEqual(['morning>hn', 'morning>hf', 'hn>pick', 'hf>pick', 'pick>brief']);
    expect(edges.every(edge => edge.state === 'idle')).toBe(true);
  });

  it('lights the run: finished wires fill, the running step moves, skipped ones fade', () => {
    const { nodes, edges } = buildDiagram({
      spec,
      steps: [step('morning', 'succeeded'), step('hn', 'succeeded'), step('hf', 'running'), step('pick', 'queued')],
    });
    const wire = (id: string) => edges.find(edge => edge.id === id)!.state;
    expect(wire('morning>hn')).toBe('done');
    expect(wire('morning>hf')).toBe('active');
    expect(wire('hn>pick')).toBe('idle');
    expect(nodes.find(node => node.id === 'hf')!.data.status).toBe('running');
    expect(nodes.find(node => node.id === 'brief')!.data.status).toBeNull();
  });

  it('marks a draft: new and changed nodes, and removed ones drawn as ghosts', () => {
    const next: WorkflowSpec = {
      ...spec,
      nodes: [
        ...spec.nodes
          .filter(node => node.id !== 'hf')
          .map(node => (node.id === 'pick' ? { ...node, label: 'Pick three' } : node)),
        {
          id: 'gh',
          type: 'step.http_get',
          label: 'GitHub trending',
          url: 'https://github.com/trending',
          format: 'text',
          maxBytes: 500_000,
        },
      ],
      edges: [
        ...spec.edges.filter(edge => edge.from !== 'hf' && edge.to !== 'hf'),
        { from: 'morning', to: 'gh' },
        { from: 'gh', to: 'pick' },
      ],
      allowHosts: [...spec.allowHosts, 'github.com'],
    };
    const { nodes, edges } = buildDiagram({ spec: next, diff: diffSpecs(spec, next) });
    const change = (id: string) => nodes.find(node => node.id === id)?.data.change;
    expect(change('gh')).toBe('added');
    expect(change('pick')).toBe('changed');
    expect(change('hf')).toBe('removed');
    expect(change('hn')).toBeNull();
    expect(edges.find(edge => edge.id === 'gh>pick')!.state).toBe('added');
    expect(edges.find(edge => edge.id === 'hf>pick')!.state).toBe('removed');
  });

  it('labels condition branches, and flags kinds not built yet', () => {
    const branched: WorkflowSpec = {
      ...spec,
      nodes: [
        ...spec.nodes,
        {
          id: 'any',
          type: 'step.condition',
          label: 'Anything?',
          left: '{{steps.pick.output}}',
          op: 'is_not_empty',
          right: '',
        },
        { id: 'say', type: 'out.speak', label: 'Say it', text: '{{steps.pick.output}}' },
      ],
      edges: [...spec.edges, { from: 'pick', to: 'any' }, { from: 'any', to: 'say', when: 'true' }],
    };
    const { nodes, edges } = buildDiagram({ spec: branched });
    expect(edges.find(edge => edge.id === 'any>say:true')!.when).toBe('true');
    expect(nodes.find(node => node.id === 'say')!.data.unavailable).toBe(true);
    expect(nodes.find(node => node.id === 'any')!.data.unavailable).toBe(false);
  });
});
