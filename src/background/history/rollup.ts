import { GENERAL_SUMMARY_ID } from '@extension/storage';
import type { KnowledgeItem, SummarySource, Workspace, WorkspaceSummary } from '@extension/storage';
import { dayLabel } from '../kb/answer';
import { hashText } from '../kb/chunker';

// The pure half of the workspace summaries, which the panel uses too: scoping, actions, the roll-up

const DAY = 24 * 60 * 60 * 1000;

/** Which items a workspace's summary may read: its own only (null: the ones in no workspace). */
export function itemsOf(items: KnowledgeItem[], workspaceId: string | null): KnowledgeItem[] {
  return items.filter(item => (item.workspaceId ?? null) === workspaceId);
}

/** A fingerprint of what a summary read, to know when it is out of date. */
export function fingerprintOf(items: KnowledgeItem[]): string {
  return hashText(
    items
      .map(item => `${item.id}:${item.updatedAt}`)
      .sort()
      .join('|'),
  );
}

/** The "Next actions" lines of a summary, without their checkbox. */
export function actionsOf(text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex(line => /^#{1,4}\s*next actions/i.test(line.trim()));
  if (at < 0) return [];
  const actions: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,4}\s/.test(line.trim())) break;
    const match = /^\s*[-*•]\s*(?:\[[ x]?\]\s*)?(.+)$/i.exec(line);
    if (match) actions.push(match[1].trim());
  }
  return actions.slice(0, 8);
}

/** A summary without a model: the latest sources by date, so a workspace always says something. */
export function plainSummary(sources: SummarySource[]): string {
  if (sources.length === 0) return '';
  return `## Recent work\n${sources
    .slice(0, 8)
    .map(source => `- ${source.title} (${dayLabel(source.date).slice(0, 10)}) [${source.n}]`)
    .join('\n')}`;
}

/** One line of a source's words for a list the user reads: flat, nothing that links or loads. */
export function flat(text: string, max = 160): string {
  const line = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[`<>!]/g, '');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface RollupEntry {
  workspaceId: string;
  name: string;
  latest: { title: string; date: number; sourceType: string } | null;
  // Sources active in the last seven days
  recent: number;
  actions: string[];
}

/**
 * The all-workspaces view: per workspace (and what is in none), its latest activity, how busy its week
 * was, and the next actions its summary lists. Busiest first; workspaces with nothing in them are left out.
 */
export function rollup(
  workspaces: Pick<Workspace, 'id' | 'name'>[],
  summaries: Record<string, WorkspaceSummary>,
  items: KnowledgeItem[],
  now = Date.now(),
  generalName = 'No workspace',
): RollupEntry[] {
  const groups = [
    ...workspaces.map(workspace => ({ id: workspace.id, key: workspace.id, name: workspace.name })),
    { id: null, key: GENERAL_SUMMARY_ID, name: generalName },
  ];
  const entries: RollupEntry[] = [];
  for (const group of groups) {
    const own = itemsOf(items, group.id);
    if (own.length === 0) continue;
    const latest = own.reduce((a, b) => (b.sourceUpdatedAt > a.sourceUpdatedAt ? b : a));
    entries.push({
      workspaceId: group.key,
      name: group.name,
      latest: { title: latest.title, date: latest.sourceUpdatedAt, sourceType: latest.sourceType },
      recent: own.filter(item => now - item.sourceUpdatedAt <= 7 * DAY).length,
      actions: (summaries[group.key]?.actions ?? []).slice(0, 3),
    });
  }
  return entries.sort((a, b) => (b.latest?.date ?? 0) - (a.latest?.date ?? 0));
}

/** The roll-up as Markdown for the morning brief and the agent: every line flattened. */
export function rollupMarkdown(entries: RollupEntry[]): string {
  if (entries.length === 0) return '';
  const parts = entries.map(entry => {
    const head = `**${flat(entry.name, 60)}**: latest "${flat(entry.latest?.title ?? '', 80)}" (${dayLabel(entry.latest?.date ?? 0).slice(0, 10)}), ${entry.recent} active this week`;
    const actions = entry.actions.map(
      action => `- [ ] ${flat(action.replace(/\[\d+\]/g, ''), 140).replace(/[[\]]/g, '')}`,
    );
    return [head, ...actions].join('\n');
  });
  return `**Across your workspaces**\n${parts.join('\n')}`;
}
