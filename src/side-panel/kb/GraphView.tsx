import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Search } from 'lucide-react';
import { t } from '@extension/i18n';
import { graphStore } from '@extension/storage';
import type { GraphEdge, GraphNode, GraphNodeType } from '@extension/storage';
import { cn } from '@extension/ui';
import { useLive } from '../hooks/useLive';

type Key = Parameters<typeof t>[0];

// Restrained: people and projects carry the two accent hues, everything else stays neutral
const TYPE_STYLE: Record<GraphNodeType, { color: string; label: Key; size: number }> = {
  project: { color: 'rgb(var(--primary-rgb))', label: 'graph_type_project', size: 7 },
  person: { color: 'rgb(var(--call-rgb))', label: 'graph_type_person', size: 6 },
  organization: { color: 'rgba(200, 205, 215, 0.9)', label: 'graph_type_organization', size: 6 },
  decision: { color: 'rgba(235, 238, 245, 0.95)', label: 'graph_type_decision', size: 4.5 },
  action: { color: 'rgba(170, 178, 192, 0.9)', label: 'graph_type_action', size: 4.5 },
  thread: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_thread', size: 3.5 },
  meeting: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_meeting', size: 4 },
  page: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_page', size: 3.5 },
  note: { color: 'rgba(120, 128, 142, 0.85)', label: 'graph_type_note', size: 3.5 },
};

const EDGE_LABELS: Record<GraphEdge['kind'], { out: Key; in: Key }> = {
  mentions: { out: 'graph_edge_mentions', in: 'graph_edge_mentionedIn' },
  attended: { out: 'graph_edge_attended', in: 'graph_edge_attendedBy' },
  decided_in: { out: 'graph_edge_decidedIn', in: 'graph_edge_decisions' },
  raised_in: { out: 'graph_edge_raisedIn', in: 'graph_edge_actions' },
  assigned_to: { out: 'graph_edge_assignedTo', in: 'graph_edge_assigned' },
  part_of: { out: 'graph_edge_partOf', in: 'graph_edge_parts' },
};

const SOURCES = new Set<GraphNodeType>(['thread', 'meeting', 'page', 'note']);
// The map shows at most this many nodes: the most connected ones
const MAX_NODES = 160;

interface Point {
  x: number;
  y: number;
}

/**
 * A force layout, run to rest before drawing: linked nodes pull together, all nodes push apart, and a
 * weak pull to the middle keeps it on screen. Small graphs only, so the simple quadratic way is enough.
 */
export function layout(ids: string[], links: [string, string][], iterations = 220): Map<string, Point> {
  const at = new Map<string, Point>();
  ids.forEach((id, index) => {
    const angle = index * 2.399963;
    const radius = 10 * Math.sqrt(index + 1);
    at.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  const list = ids.map(id => at.get(id)!);
  const pairs = links.filter(([a, b]) => at.has(a) && at.has(b)).map(([a, b]) => [at.get(a)!, at.get(b)!] as const);
  for (let step = 0; step < iterations; step++) {
    const cool = 1 - step / iterations;
    const move = new Map<Point, Point>(list.map(point => [point, { x: -point.x * 0.01, y: -point.y * 0.01 }]));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const distance2 = Math.max(dx * dx + dy * dy, 1);
        const push = 120 / distance2;
        move.get(a)!.x += dx * push;
        move.get(a)!.y += dy * push;
        move.get(b)!.x -= dx * push;
        move.get(b)!.y -= dy * push;
      }
    }
    for (const [a, b] of pairs) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const pull = 0.04;
      move.get(a)!.x += dx * pull;
      move.get(a)!.y += dy * pull;
      move.get(b)!.x -= dx * pull;
      move.get(b)!.y -= dy * pull;
    }
    for (const point of list) {
      const delta = move.get(point)!;
      const length = Math.hypot(delta.x, delta.y);
      const limit = 6 * cool + 0.2;
      const scale = length > limit ? limit / length : 1;
      point.x += delta.x * scale;
      point.y += delta.y * scale;
    }
  }
  return at;
}

interface GraphViewProps {
  workspaceId: string | null;
  onOpenSource: (node: GraphNode) => void;
}

/**
 * The knowledge graph of one workspace: a map of what is connected to what, and the node in focus
 * with every link it has, each a step further. The trail above says how you got there.
 */
export default function GraphView({ workspaceId, onOpenSource }: GraphViewProps) {
  const nodes = useLive(() => graphStore.nodes(workspaceId ?? undefined), [workspaceId], [] as GraphNode[]);
  const edges = useLive(() => graphStore.edges(), [], [] as GraphEdge[]);
  const [trail, setTrail] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<GraphNodeType>>(new Set(['thread', 'page', 'note']));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const focusId = trail.at(-1) ?? null;

  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
  const links = useMemo(() => edges.filter(edge => byId.has(edge.from) && byId.has(edge.to)), [edges, byId]);
  const degree = useMemo(() => {
    const count = new Map<string, number>();
    for (const edge of links) {
      count.set(edge.from, (count.get(edge.from) ?? 0) + 1);
      count.set(edge.to, (count.get(edge.to) ?? 0) + 1);
    }
    return count;
  }, [links]);

  const shown = useMemo(() => {
    const visible = nodes.filter(node => !hidden.has(node.type) || node.id === focusId);
    return visible.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, MAX_NODES);
  }, [nodes, hidden, degree, focusId]);
  const positions = useMemo(
    () =>
      layout(
        shown.map(node => node.id),
        links.map(edge => [edge.from, edge.to]),
      ),
    [shown, links],
  );

  const focus = focusId ? byId.get(focusId) : undefined;
  const focusLinks = useMemo(() => {
    if (!focusId) return [];
    const groups = new Map<Key, GraphNode[]>();
    for (const edge of links) {
      const outgoing = edge.from === focusId;
      if (!outgoing && edge.to !== focusId) continue;
      const other = byId.get(outgoing ? edge.to : edge.from)!;
      const label = outgoing ? EDGE_LABELS[edge.kind].out : EDGE_LABELS[edge.kind].in;
      const list = groups.get(label) ?? [];
      if (!list.some(node => node.id === other.id)) list.push(other);
      groups.set(label, list);
    }
    return [...groups.entries()];
  }, [focusId, links, byId]);

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const pool = words.length
      ? nodes.filter(node => words.every(word => node.label.toLowerCase().includes(word)))
      : nodes.filter(node => !SOURCES.has(node.type));
    return pool.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, 12);
  }, [query, nodes, degree]);

  // Draws the map: links, then nodes, with names on the focus, its neighbours and the busiest nodes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const pen = canvas.getContext('2d');
    if (!pen) return;
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    // A canvas cannot read CSS variables: the theme's colours are looked up once per draw
    const root = getComputedStyle(document.documentElement);
    const paint = (color: string) =>
      color.replace(/var\((--[\w-]+)\)/g, (_, name: string) => root.getPropertyValue(name).trim() || '200 200 200');
    pen.clearRect(0, 0, width, height);
    const points = shown.map(node => positions.get(node.id)!).filter(Boolean);
    if (points.length === 0) return;
    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));
    const scale = Math.min((width - 40) / Math.max(maxX - minX, 1), (height - 40) / Math.max(maxY - minY, 1), 3);
    const place = (p: Point) => ({
      x: width / 2 + (p.x - (minX + maxX) / 2) * scale,
      y: height / 2 + (p.y - (minY + maxY) / 2) * scale,
    });
    const near = new Set(focusId ? [focusId, ...focusLinks.flatMap(([, list]) => list.map(node => node.id))] : []);

    pen.lineWidth = 1;
    for (const edge of links) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b || !shown.some(n => n.id === edge.from) || !shown.some(n => n.id === edge.to)) continue;
      const lit = focusId && (edge.from === focusId || edge.to === focusId);
      pen.strokeStyle = lit ? 'rgba(220, 225, 235, 0.55)' : 'rgba(150, 158, 172, 0.16)';
      const pa = place(a);
      const pb = place(b);
      pen.beginPath();
      pen.moveTo(pa.x, pa.y);
      pen.lineTo(pb.x, pb.y);
      pen.stroke();
    }
    const busiest = new Set(shown.slice(0, 10).map(node => node.id));
    pen.font = '11px Geist Variable, system-ui, sans-serif';
    for (const node of shown) {
      const p = positions.get(node.id);
      if (!p) continue;
      const { x, y } = place(p);
      const style = TYPE_STYLE[node.type];
      const dim = focusId && !near.has(node.id);
      pen.globalAlpha = dim ? 0.3 : 1;
      pen.fillStyle = paint(style.color);
      pen.beginPath();
      pen.arc(x, y, node.id === focusId ? style.size + 3 : style.size, 0, Math.PI * 2);
      pen.fill();
      if (node.id === focusId || near.has(node.id) || (!focusId && busiest.has(node.id))) {
        pen.fillStyle = 'rgba(235, 238, 245, 0.92)';
        const label = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
        // A name that would run off the right edge sits on the dot's left
        const textWidth = pen.measureText(label).width;
        const left = x + style.size + 4 + textWidth > width - 4;
        pen.fillText(label, left ? x - style.size - 4 - textWidth : x + style.size + 4, y + 4);
      }
    }
    pen.globalAlpha = 1;
    canvas.onclick = event => {
      const box = canvas.getBoundingClientRect();
      const cx = event.clientX - box.left;
      const cy = event.clientY - box.top;
      let best: { id: string; distance: number } | null = null;
      for (const node of shown) {
        const p = positions.get(node.id);
        if (!p) continue;
        const { x, y } = place(p);
        const distance = Math.hypot(x - cx, y - cy);
        if (distance < 14 && (!best || distance < best.distance)) best = { id: node.id, distance };
      }
      if (best) setTrail(current => [...current.filter(id => id !== best!.id), best!.id].slice(-6));
    };
  }, [shown, positions, links, focusId, focusLinks]);

  const go = (id: string) => setTrail(current => [...current.filter(item => item !== id), id].slice(-6));
  const toggle = (type: GraphNodeType) =>
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
      onClick={() => toggle(type)}
      className={cn(
        'flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px]',
        hidden.has(type) ? 'text-muted-foreground' : 'bg-accent text-foreground',
      )}>
      <span className="size-2 rounded-full" style={{ background: TYPE_STYLE[type].color }} />
      {t(label)}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3 pt-2">
      <div className="flex flex-wrap gap-1">
        {chip('project', 'graph_type_projects')}
        {chip('person', 'graph_type_people')}
        {chip('organization', 'graph_type_organizations')}
        {chip('decision', 'graph_type_decisions')}
        {chip('action', 'graph_type_actions')}
        {chip('meeting', 'graph_type_meetings')}
        {chip('thread', 'graph_type_chats')}
      </div>

      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t('graph_map', [String(shown.length)])}
        className="glass h-[260px] w-full shrink-0 cursor-pointer rounded-2xl"
      />

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
  );
}
