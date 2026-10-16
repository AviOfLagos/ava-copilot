import { memo, useMemo } from 'react';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './flow.css';
import { Ban, CircleAlert, CircleCheck, CircleDashed, CirclePause, CircleX, LoaderCircle } from 'lucide-react';
import { t } from '@extension/i18n';
import type { RunStepStatus } from '@extension/storage';
import { cn } from '@extension/ui';
import { buildDiagram } from './diagram';
import type { DiagramInput, FlowNodeData, WireState } from './diagram';
import { GROUP_LABEL, groupOf, NODE_META, nodeSubtitle, STATUS_LABEL } from './meta';

/**
 * The workflow as an n8n-style diagram (React Flow, MIT; the attribution link is hidden, credited here):
 * cards top to bottom, the wire turning mint as each step finishes, amber only on a step that waits for the
 * user's click, and a draft's changes marked on the cards.
 */

type FlowNode = Node<FlowNodeData, 'flow'>;

function StatusMark({ status }: { status: RunStepStatus | null }) {
  if (!status) return null;
  const label = t(STATUS_LABEL[status]);
  const common = { role: 'img', 'aria-label': label, className: 'size-3.5 shrink-0' } as const;
  switch (status) {
    case 'running':
      return <LoaderCircle {...common} className={cn(common.className, 'text-primary animate-spin')} />;
    case 'succeeded':
      return <CircleCheck {...common} className={cn(common.className, 'text-primary')} />;
    case 'waiting_user':
      return <CirclePause {...common} className={cn(common.className, 'text-hold')} />;
    case 'failed':
      return <CircleX {...common} className={cn(common.className, 'text-destructive')} />;
    case 'unknown_outcome':
      return <CircleAlert {...common} className={cn(common.className, 'text-destructive')} />;
    case 'queued':
      return <CircleDashed {...common} className={cn(common.className, 'text-muted-foreground/60')} />;
    default:
      return <Ban {...common} className={cn(common.className, 'text-muted-foreground')} />;
  }
}

const CHANGE_LABEL = { added: 'flow_diff_added', changed: 'flow_diff_changed', removed: 'flow_diff_removed' } as const;

const FlowNodeCard = memo(function FlowNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const { node, change, status, unavailable, direction, note } = data;
  const detail = unavailable ? t('flow_node_notYet') : (note ?? nodeSubtitle(node));
  const across = direction === 'LR';
  const { icon: Icon } = NODE_META[node.type];
  const group = groupOf(node.type);
  return (
    <div
      data-flow-node={node.id}
      data-status={status ?? 'none'}
      data-change={change ?? 'none'}
      // The whole name on hover: cards are narrow in the side panel
      title={`${node.label}\n${detail}`}
      className={cn(
        'glass relative flex size-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-[border-color,box-shadow,opacity] duration-200 ease-out',
        status === 'running' && 'border-primary/70 shadow-[0_0_0_3px_rgb(var(--primary-rgb)/0.14)]',
        status === 'succeeded' && 'border-primary/40',
        (status === 'failed' || status === 'unknown_outcome') && 'border-destructive/60',
        status === 'waiting_user' && 'border-hold shadow-[0_0_0_3px_rgb(var(--hold-rgb)/0.18)]',
        (status === 'skipped' || status === 'cancelled' || status === 'interrupted') && 'opacity-55',
        change === 'added' && 'outline-primary/70 outline-dashed outline-1 outline-offset-2',
        change === 'changed' && 'outline-foreground/45 outline-dashed outline-1 outline-offset-2',
        change === 'removed' && 'border-destructive/50 border-dashed opacity-60',
        selected && 'ring-ring ring-1',
      )}>
      <Handle
        type="target"
        position={across ? Position.Left : Position.Top}
        isConnectable={false}
        className="flow-handle"
      />
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg',
          group === 'trigger' ? 'bg-primary/15 text-foreground' : 'bg-secondary text-foreground',
        )}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="label-mono block !text-[9px] leading-none">{t(GROUP_LABEL[group])}</span>
        <span
          className={cn(
            'mt-0.5 block truncate text-[12.5px] font-medium leading-tight',
            change === 'removed' && 'line-through',
          )}>
          {node.label}
        </span>
        <span
          className={cn(
            'block truncate text-[11px] leading-tight',
            note && !unavailable ? 'text-destructive' : 'text-muted-foreground',
          )}>
          {detail}
        </span>
      </span>
      <StatusMark status={status} />
      {change && (
        <span
          className={cn(
            'absolute -top-2 right-2 rounded-full border px-1.5 py-px font-mono text-[9.5px] leading-tight',
            change === 'added' && 'border-primary/50 bg-popover text-foreground',
            change === 'changed' && 'border-foreground/30 bg-popover text-foreground',
            change === 'removed' && 'border-destructive/50 bg-popover text-foreground',
          )}>
          {t(CHANGE_LABEL[change])}
        </span>
      )}
      <Handle
        type="source"
        position={across ? Position.Right : Position.Bottom}
        isConnectable={false}
        className="flow-handle"
      />
    </div>
  );
});

const NODE_TYPES = { flow: FlowNodeCard };

const WIRE: Record<WireState, { stroke: string; dash?: string }> = {
  idle: { stroke: 'var(--color-input)' },
  done: { stroke: 'rgb(var(--primary-rgb) / 0.85)' },
  active: { stroke: 'rgb(var(--primary-rgb))', dash: '5 4' },
  added: { stroke: 'rgb(var(--primary-rgb) / 0.75)', dash: '4 3' },
  removed: { stroke: 'rgb(var(--destructive-rgb) / 0.6)', dash: '4 3' },
  skipped: { stroke: 'var(--color-border)', dash: '2 4' },
};

export interface FlowDiagramProps extends Omit<DiagramInput, 'box'> {
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
  height?: number;
  // About how wide the diagram is shown, for picking its direction (the panel is narrow, the full tab wide)
  width?: number;
  label: string;
}

export default function FlowDiagram({
  spec,
  diff,
  steps,
  notes,
  selectedId,
  onSelect,
  height = 320,
  width = 370,
  label,
}: FlowDiagramProps) {
  const notesKey = JSON.stringify(notes ?? {});
  const { nodes, edges } = useMemo(() => {
    const diagram = buildDiagram({ spec, diff, steps, notes, box: { width, height } });
    const flowNodes: FlowNode[] = diagram.nodes.map(node => ({ ...node, selected: node.id === selectedId }));
    const flowEdges: Edge[] = diagram.edges.map(edge => {
      const wire = WIRE[edge.state];
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: edge.state === 'active',
        label: edge.when ? (edge.when === 'true' ? t('flow_branch_yes') : t('flow_branch_no')) : undefined,
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
        style: { stroke: wire.stroke, strokeWidth: 1.5, strokeDasharray: wire.dash },
        focusable: false,
      };
    });
    return { nodes: flowNodes, edges: flowEdges };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notes by value: the panel builds a new object each render
  }, [spec, diff, steps, notesKey, selectedId, width, height]);

  // A new shape is laid out and fitted again; status changes only repaint
  const shape = useMemo(
    () => nodes.map(node => node.id).join('|') + edges.map(edge => edge.id).join('|'),
    [nodes, edges],
  );
  const light = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';

  return (
    <div
      role="group"
      aria-label={label}
      // Never squeezed by the scrolling column it sits in: the diagram keeps its height
      className="flow-canvas relative shrink-0 overflow-hidden rounded-2xl border bg-[var(--glass-bottom)]"
      style={{ height }}>
      <ReactFlow
        key={shape}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        colorMode={light ? 'light' : 'dark'}
        fitView
        fitViewOptions={{ padding: 0.14, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        zoomOnDoubleClick={false}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        {/* Top right: a workflow starts with one trigger at the top centre, so the corner is free */}
        <Controls showInteractive={false} position="top-right" orientation="horizontal" />
      </ReactFlow>
    </div>
  );
}
