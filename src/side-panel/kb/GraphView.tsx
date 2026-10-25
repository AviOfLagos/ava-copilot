import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Crosshair, Maximize2, Search } from 'lucide-react';
import ForceGraph2D from 'react-force-graph-2d';
import type { ForceGraphMethods, LinkObject, NodeObject } from 'react-force-graph-2d';
import { t } from '@extension/i18n';
import { graphStore, kbStore } from '@extension/storage';
import type { GraphEdge, GraphNode, GraphNodeType, KnowledgeItem } from '@extension/storage';
import { cn } from '@extension/ui';
import { useLive } from '../hooks/useLive';
import { useElementSize, useReducedMotion } from './useElementSize';
import {
  MAX_SHOWN_NODES,
  buildItemAgentIndex,
  capLinks,
  computeDegree,
  filterByScope,
  filterByType,
  filterEdges,
  levelOfDetail,
  nodeRadius,
  pickVisible,
  topNodeIds,
} from './graphData';
import type { TimeRange } from './graphData';

type Key = Parameters<typeof t>[0];
type SimNode = NodeObject<GraphNode>;
type SimLink = LinkObject<GraphNode, GraphEdge>;

// Restrained: people and projects carry the two accent hues, everything else stays neutral. DOM colour
// (chips, the focus card's dot) can use CSS vars directly; the canvas cannot, so paint() below re-reads
// the same tokens as plain numbers at draw time.
const TYPE_STYLE: Record<GraphNodeType, { color: string; label: Key }> = {
  project: { color: 'rgb(var(--primary-rgb))', label: 'graph_type_project' },
  person: { color: 'rgb(var(--call-rgb))', label: 'graph_type_person' },
  organization: { color: 'rgba(200, 205, 215, 0.9)', label: 'graph_type_organization' },
  decision: { color: 'rgba(235, 238, 245, 0.95)', label: 'graph_type_decision' },
  action: { color: 'rgba(170, 178, 192, 0.9)', label: 'graph_type_action' },
  thread: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_thread' },
  meeting: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_meeting' },
  page: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_page' },
  note: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_note' },
  'ai-session': { color: 'rgba(120, 128, 142, 0.85)', label: 'history_type_session' },
  ambient: { color: 'rgba(120, 128, 142, 0.85)', label: 'ambient_kb_type' },
};

// How solid each neutral type reads against the foreground token; project/person use the accent hues instead
const NEUTRAL_ALPHA: Partial<Record<GraphNodeType, number>> = {
  decision: 0.95,
  organization: 0.85,
  action: 0.72,
  meeting: 0.6,
  thread: 0.52,
  page: 0.52,
  note: 0.52,
  'ai-session': 0.52,
};

const EDGE_LABELS: Record<GraphEdge['kind'], { out: Key; in: Key }> = {
  mentions: { out: 'graph_edge_mentions', in: 'graph_edge_mentionedIn' },
  attended: { out: 'graph_edge_attended', in: 'graph_edge_attendedBy' },
  decided_in: { out: 'graph_edge_decidedIn', in: 'graph_edge_decisions' },
  raised_in: { out: 'graph_edge_raisedIn', in: 'graph_edge_actions' },
  assigned_to: { out: 'graph_edge_assignedTo', in: 'graph_edge_assigned' },
  part_of: { out: 'graph_edge_partOf', in: 'graph_edge_parts' },
};

const SOURCES = new Set<GraphNodeType>(['thread', 'meeting', 'page', 'note', 'ai-session']);
const TIME_CHIPS: { value: TimeRange; label: Key }[] = [
  { value: '7d', label: 'graph_time_7d' },
  { value: '30d', label: 'graph_time_30d' },
  { value: '90d', label: 'graph_time_90d' },
  { value: 'all', label: 'graph_time_all' },
];

interface Palette {
  primary: string;
  call: string;
  foreground: string;
  border: string;
}

function readPalette(): Palette {
  const root = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => root?.getPropertyValue(name).trim() || fallback;
  return {
    primary: read('--primary-rgb', '110 231 200'),
    call: read('--call-rgb', '150 160 255'),
    foreground: read('--color-foreground', '232 234 240'),
    border: read('--color-border', '150 158 172'),
  };
}

/** A node's canvas colour: the two accent hues for projects/people, a graded neutral for everything else. */
function typeColor(type: GraphNodeType, palette: Palette): { rgb: string; alpha: number } {
  if (type === 'project') return { rgb: palette.primary, alpha: 1 };
  if (type === 'person') return { rgb: palette.call, alpha: 1 };
  return { rgb: palette.foreground, alpha: NEUTRAL_ALPHA[type] ?? 0.6 };
}

interface GraphViewProps {
  workspaceId: string | null;
  // The agent the knowledge is scoped to; null is every agent (and knowledge with none)
  agentId?: string | null;
  onOpenSource: (node: GraphNode) => void;
  // Forces a redraw with fresh theme colours when the panel's look changes; the colours themselves are
  // always read live from the page, this is only here so toggling the theme repaints promptly.
  isDarkMode?: boolean;
  // False inside the pop-out tab, which already is the "bigger view" there is nothing further to open
  canPopout?: boolean;
}

/**
 * The knowledge graph of one workspace: live force-directed physics, drag, zoom/pan, hover and
 * click, plus the node in focus with every link it has (the focus card, the trail, search and
 * "Most connected" below the canvas are the accessible way in — they stay plain DOM).
 */
export default function GraphView({
  workspaceId,
  agentId = null,
  onOpenSource,
  isDarkMode,
  canPopout = true,
}: GraphViewProps) {
  const nodes = useLive(() => graphStore.nodes(workspaceId ?? undefined), [workspaceId], [] as GraphNode[]);
  const edges = useLive(() => graphStore.edges(), [], [] as GraphEdge[]);
  const kbItems = useLive(() => kbStore.items(), [], [] as KnowledgeItem[]);
  const itemAgentIndex = useMemo(() => buildItemAgentIndex(kbItems), [kbItems]);

  const [trail, setTrail] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<GraphNodeType>>(new Set(['thread', 'page', 'note', 'ai-session']));
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const focusId = trail.at(-1) ?? null;

  // Agent and time range narrow the universe before type chips decide what is drawn; degree and "most
  // connected" are computed from this scoped set, so a type chip never changes how connected something is.
  const scoped = useMemo(
    () => filterByScope(nodes, itemAgentIndex, { agentId, timeRange }),
    [nodes, itemAgentIndex, agentId, timeRange],
  );
  const byId = useMemo(() => new Map(scoped.map(node => [node.id, node])), [scoped]);
  const links = useMemo(() => edges.filter(edge => byId.has(edge.from) && byId.has(edge.to)), [edges, byId]);
  const degree = useMemo(() => computeDegree(links), [links]);

  const typeFiltered = useMemo(() => filterByType(scoped, hidden, focusId), [scoped, hidden, focusId]);
  const shown = useMemo(
    () => pickVisible(typeFiltered, degree, focusId, MAX_SHOWN_NODES),
    [typeFiltered, degree, focusId],
  );
  const shownIds = useMemo(() => new Set(shown.map(node => node.id)), [shown]);
  // Every edge joining two shown nodes: used for hover/focus neighbour lookups, so a node still reads as
  // connected even if its link was thinned out of renderEdges below
  const shownEdges = useMemo(() => filterEdges(links, shownIds), [links, shownIds]);

  const reducedMotion = useReducedMotion();
  const lod = useMemo(() => levelOfDetail(shown.length, reducedMotion), [shown.length, reducedMotion]);
  const topIds = useMemo(() => topNodeIds(shown, degree, lod.topLabelCount), [shown, degree, lod.topLabelCount]);
  // What is actually drawn: thinned at high density, or the hairball's overlapping strokes composite
  // toward solid black long before the node cap is reached. The focused node's own links are exempt.
  const renderEdges = useMemo(
    () => capLinks(shownEdges, degree, lod.maxLinks, focusId),
    [shownEdges, degree, lod.maxLinks, focusId],
  );

  const focus = focusId ? byId.get(focusId) : undefined;
  const focusLinks = useMemo(() => {
    if (!focusId) return [] as [Key, GraphNode[]][];
    const groups = new Map<Key, GraphNode[]>();
    for (const edge of links) {
      const outgoing = edge.from === focusId;
      if (!outgoing && edge.to !== focusId) continue;
      const other = byId.get(outgoing ? edge.to : edge.from);
      if (!other) continue;
      const label = outgoing ? EDGE_LABELS[edge.kind].out : EDGE_LABELS[edge.kind].in;
      const list = groups.get(label) ?? [];
      if (!list.some(node => node.id === other.id)) list.push(other);
      groups.set(label, list);
    }
    return [...groups.entries()];
  }, [focusId, links, byId]);

  // Hovering previews a node's neighbours; otherwise the focused node's own links stay highlighted
  const highlightId = hoverId ?? focusId;
  const highlightIds = useMemo(() => {
    if (!highlightId) return null;
    if (highlightId === focusId) return new Set([focusId, ...focusLinks.flatMap(([, list]) => list.map(n => n.id))]);
    const ids = new Set([highlightId]);
    for (const edge of shownEdges) {
      if (edge.from === highlightId) ids.add(edge.to);
      else if (edge.to === highlightId) ids.add(edge.from);
    }
    return ids;
  }, [highlightId, focusId, focusLinks, shownEdges]);

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = words.length
      ? scoped.filter(node => words.every(word => node.label.toLowerCase().includes(word)))
      : scoped.filter(node => !SOURCES.has(node.type));
    return pool.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, 12);
  }, [query, scoped, degree]);

  // --- The force graph itself -------------------------------------------------------------------

  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>();
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphEdge> | undefined>(undefined);
  const paletteRef = useRef<Palette>(readPalette());
  const autoFitted = useRef(false);
  // Keeps the same node objects across data refreshes, so x/y/fx/fy survive a live update instead of
  // every node re-spawning at a random spot. Only edges are rebuilt each time; they carry no position.
  const simNodesCache = useRef(new Map<string, SimNode>());

  useEffect(() => {
    autoFitted.current = false;
    // A rough fit shortly after the physics starts, so the first paint is never badly off-frame while
    // waiting for the engine to fully settle; onEngineStop below does the final, precise one
    const timer = setTimeout(() => fgRef.current?.zoomToFit(400, 48), 400);
    return () => clearTimeout(timer);
  }, [workspaceId, agentId]);

  const simNodes = useMemo(() => {
    const cache = simNodesCache.current;
    const next = new Map<string, SimNode>();
    for (const graphNode of shown) {
      const existing = cache.get(graphNode.id);
      if (existing) {
        existing.type = graphNode.type;
        existing.label = graphNode.label;
        existing.workspaceId = graphNode.workspaceId;
        existing.sourceItemIds = graphNode.sourceItemIds;
        existing.date = graphNode.date;
        existing.updatedAt = graphNode.updatedAt;
        next.set(graphNode.id, existing);
      } else {
        next.set(graphNode.id, { ...graphNode });
      }
    }
    simNodesCache.current = next;
    return [...next.values()];
  }, [shown]);

  const graphData = useMemo(() => ({ nodes: simNodes, links: renderEdges as SimLink[] }), [simNodes, renderEdges]);

  const isHotLink = useCallback(
    (edge: SimLink) => !!highlightId && (edge.from === highlightId || edge.to === highlightId),
    [highlightId],
  );

  const handleRenderFramePre = useCallback(() => {
    paletteRef.current = readPalette();
  }, []);

  const paintNode = useCallback(
    (node: SimNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = nodeRadius(node.type, degree.get(String(node.id)) ?? 0);
      const dim = !!highlightIds && !highlightIds.has(String(node.id));
      const { rgb, alpha } = typeColor(node.type, paletteRef.current);

      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.beginPath();
      ctx.arc(x, y, node.id === focusId ? radius + 2 : radius, 0, 2 * Math.PI);
      ctx.fillStyle = `rgb(${rgb} / ${alpha})`;
      ctx.fill();
      if (node.id === focusId || node.id === hoverId) {
        ctx.lineWidth = 1.5 / globalScale;
        ctx.strokeStyle = `rgb(${paletteRef.current.foreground} / 0.9)`;
        ctx.stroke();
      }
      if (node.fx != null) {
        ctx.beginPath();
        ctx.arc(x + radius * 0.72, y - radius * 0.72, 1.5, 0, 2 * Math.PI);
        ctx.fillStyle = `rgb(${paletteRef.current.foreground} / 0.85)`;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const label =
        !dim &&
        (node.id === focusId ||
          node.id === hoverId ||
          topIds.has(String(node.id)) ||
          globalScale >= lod.zoomLabelScale);
      if (label) {
        const text = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
        const fontSize = 11 / globalScale;
        const gap = (radius + 4) / globalScale;
        ctx.font = `${fontSize}px "Geist Variable", system-ui, sans-serif`;
        ctx.fillStyle = `rgb(${paletteRef.current.foreground} / 0.92)`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(text, x + gap, y);
      }
    },
    // isDarkMode is not read directly: colours always come from paletteRef, refreshed at actual draw
    // time by onRenderFramePre. It is still a dep so toggling the theme forces one fresh paint while
    // the canvas is otherwise idle, instead of leaving the last theme's colours on screen.
    [degree, focusId, hoverId, highlightIds, topIds, lod.zoomLabelScale, isDarkMode],
  );

  const paintNodeArea = useCallback(
    (node: SimNode, color: string, ctx: CanvasRenderingContext2D) => {
      const radius = nodeRadius(node.type, degree.get(String(node.id)) ?? 0) + 2;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    },
    [degree],
  );

  // A busy graph has far more overlapping strokes per pixel than a quiet one; even a faint colour
  // composites toward solid ink when repeated often enough, so the baseline fades further as the
  // rendered link count grows, independent of the harder cap in lod.maxLinks
  const restAlpha = useMemo(() => Math.min(0.16, 7 / Math.max(1, renderEdges.length)), [renderEdges.length]);
  const linkColor = useCallback(
    (edge: SimLink) => {
      const hot = isHotLink(edge);
      const alpha = hot ? 0.8 : highlightIds ? restAlpha * 0.5 : restAlpha;
      return `rgb(${paletteRef.current.foreground} / ${alpha})`;
    },
    [isHotLink, highlightIds, restAlpha],
  );

  const linkWidth = useCallback((edge: SimLink) => (isHotLink(edge) ? 1.6 : 1), [isHotLink]);
  const linkParticles = useCallback(
    (edge: SimLink) => (lod.particles && isHotLink(edge) ? 2 : 0),
    [lod.particles, isHotLink],
  );
  const linkParticleColor = useCallback(() => `rgb(${paletteRef.current.primary})`, []);

  const handleEngineStop = useCallback(() => {
    if (autoFitted.current) return;
    autoFitted.current = true;
    fgRef.current?.zoomToFit(600, 48);
  }, []);

  const fit = useCallback(() => fgRef.current?.zoomToFit(500, 48), []);

  const handleDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const fg = fgRef.current;
      if (!fg) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const graphPoint = fg.screen2GraphCoords(event.clientX - rect.left, event.clientY - rect.top);
      let closest: SimNode | null = null;
      let bestDistance = Infinity;
      for (const simNode of simNodes) {
        if (simNode.x == null || simNode.y == null) continue;
        const distance = Math.hypot(simNode.x - graphPoint.x, simNode.y - graphPoint.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          closest = simNode;
        }
      }
      if (!closest || closest.fx == null) return;
      const radius = nodeRadius(closest.type, degree.get(String(closest.id)) ?? 0);
      if (bestDistance > radius + 8) return;
      closest.fx = undefined;
      closest.fy = undefined;
      fg.d3ReheatSimulation();
    },
    [simNodes, degree],
  );

  const popout = useCallback(() => {
    const params = new URLSearchParams();
    if (workspaceId) params.set('workspace', workspaceId);
    if (agentId) params.set('agent', agentId);
    const query = params.toString();
    void chrome.tabs.create({ url: chrome.runtime.getURL('graph.html') + (query ? `?${query}` : '') });
  }, [workspaceId, agentId]);

  const go = (id: string) => setTrail(current => [...current.filter(item => item !== id), id].slice(-6));
  const toggleType = (type: GraphNodeType) =>
    setHidden(current => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });

  if (nodes.length === 0) {
    return <p className="text-muted-foreground p-4 text-[12.5px]">{t('graph_empty')}</p>;
  }

  const chip = (type: GraphNodeType, label: Key) => (
    <button
      key={type}
      type="button"
      aria-pressed={!hidden.has(type)}
      onClick={() => toggleType(type)}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px]',
        hidden.has(type) ? 'text-muted-foreground' : 'bg-accent text-foreground',
      )}>
      <span className="size-2 rounded-full" style={{ background: TYPE_STYLE[type].color }} />
      {t(label)}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3 pt-2">
      <div role="group" aria-label={t('graph_filters_label')} className="flex flex-wrap gap-1">
        {chip('project', 'graph_type_projects')}
        {chip('person', 'graph_type_people')}
        {chip('organization', 'graph_type_organizations')}
        {chip('decision', 'graph_type_decisions')}
        {chip('action', 'graph_type_actions')}
        {chip('meeting', 'graph_type_meetings')}
        {chip('thread', 'graph_type_chats')}
      </div>

      <div role="group" aria-label={t('graph_time_label')} className="flex flex-wrap gap-1">
        {TIME_CHIPS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={timeRange === value}
            onClick={() => setTimeRange(value)}
            className={cn(
              'h-6 rounded-full border px-2 text-[11px]',
              timeRange === value ? 'bg-accent text-foreground' : 'text-muted-foreground',
            )}>
            {t(label)}
          </button>
        ))}
      </div>

      <div
        ref={containerRef}
        role="img"
        aria-label={t('graph_map', [String(shown.length)])}
        onDoubleClick={handleDoubleClick}
        className="glass relative min-h-[220px] w-full flex-[3] overflow-hidden rounded-2xl">
        {width > 0 && height > 0 && (
          <ForceGraph2D
            ref={fgRef}
            width={width}
            height={height}
            graphData={graphData}
            linkSource="from"
            linkTarget="to"
            backgroundColor="rgba(0,0,0,0)"
            showPointerCursor
            // Settles in a couple of seconds rather than the default's five-plus, so the "smooth zoom to
            // fit on load" is actually smooth and not a long wait before the view looks right
            d3AlphaDecay={0.06}
            onRenderFramePre={handleRenderFramePre}
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={paintNodeArea}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkCurvature={0.2}
            linkDirectionalParticles={linkParticles}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleSpeed={0.006}
            linkDirectionalParticleColor={linkParticleColor}
            onNodeHover={node => setHoverId(node ? String(node.id) : null)}
            onNodeClick={node => {
              go(String(node.id));
              const current = fgRef.current;
              if (current && node.x != null && node.y != null) current.centerAt(node.x, node.y, 400);
            }}
            onNodeDragEnd={node => {
              node.fx = node.x;
              node.fy = node.y;
            }}
            onEngineStop={handleEngineStop}
            cooldownTime={8000}
          />
        )}
        <div className="absolute right-2 top-2 flex gap-1">
          <button
            type="button"
            onClick={fit}
            title={t('graph_fit')}
            aria-label={t('graph_fit')}
            className="glass hover:bg-accent flex size-7 items-center justify-center rounded-lg">
            <Crosshair className="size-3.5" />
          </button>
          {canPopout && (
            <button
              type="button"
              onClick={popout}
              title={t('graph_popout')}
              aria-label={t('graph_popout')}
              className="glass hover:bg-accent flex size-7 items-center justify-center rounded-lg">
              <Maximize2 className="size-3.5" />
            </button>
          )}
        </div>
        {shown.length === 0 && (
          <p className="text-muted-foreground absolute inset-x-3 top-1/2 -translate-y-1/2 text-center text-[12.5px]">
            {t('graph_filtered_empty')}
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-[2] flex-col gap-2 overflow-y-auto">
        {trail.length > 0 && (
          <nav aria-label={t('graph_trail')} className="flex flex-wrap items-center gap-0.5 text-[12px]">
            {trail.map((id, index) => (
              <span key={id} className="flex items-center gap-0.5">
                {index > 0 && <ChevronRight className="text-muted-foreground size-3" aria-hidden="true" />}
                <button
                  type="button"
                  onClick={() => setTrail(trail.slice(0, index + 1))}
                  className={cn(
                    'max-w-[120px] truncate rounded-md px-1 py-0.5 hover:bg-accent',
                    index === trail.length - 1 ? 'font-medium' : 'text-muted-foreground',
                  )}>
                  {byId.get(id)?.label ?? id}
                </button>
              </span>
            ))}
          </nav>
        )}

        {focus ? (
          <section aria-label={focus.label} className="glass rounded-2xl p-3">
            <div className="flex items-start gap-2">
              <span
                className="mt-1.5 size-2.5 shrink-0 rounded-full"
                style={{ background: TYPE_STYLE[focus.type].color }}
              />
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-[13.5px] font-medium">{focus.label}</h3>
                <p className="text-muted-foreground text-[11.5px]">
                  {t(TYPE_STYLE[focus.type].label)} · {new Date(focus.date).toLocaleDateString()}
                </p>
              </div>
              {SOURCES.has(focus.type) && (
                <button
                  type="button"
                  onClick={() => onOpenSource(focus)}
                  className="text-muted-foreground hover:bg-accent flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] hover:text-foreground">
                  {t('graph_open')}
                  <ArrowUpRight className="size-3.5" />
                </button>
              )}
            </div>
            {focusLinks.map(([label, list]) => (
              <div key={label} className="mt-2.5">
                <h4 className="label-mono mb-1">{t(label)}</h4>
                <ul className="flex flex-wrap gap-1">
                  {list.map(node => (
                    <li key={node.id}>
                      <button
                        type="button"
                        onClick={() => go(node.id)}
                        className="hover:bg-accent flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-left text-[12px]">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: TYPE_STYLE[node.type].color }}
                        />
                        <span className="truncate">{node.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}

        <label className="glass flex items-center gap-2 rounded-xl px-2.5 py-1.5">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('graph_search')}
            aria-label={t('graph_search')}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
          />
        </label>
        <section aria-label={query ? t('graph_found') : t('graph_mostConnected')}>
          <h4 className="label-mono mb-1 px-1">{query ? t('graph_found') : t('graph_mostConnected')}</h4>
          <ul>
            {matches.map(node => (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => go(node.id)}
                  className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: TYPE_STYLE[node.type].color }} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{node.label}</span>
                  <span className="text-muted-foreground font-mono text-[11px]">{degree.get(node.id) ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
