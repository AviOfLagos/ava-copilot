import type {
  GraphEdge,
  GraphNode,
  KnowledgeChunk,
  KnowledgeItem,
  MeetingRecord,
  ThreadMessage,
  Workspace,
} from '@extension/storage';

/** The folder in the vault that the copilot writes; nothing outside it is ever written. */
export const EXPORT_ROOT = 'Nex Copilot';
// Every file the copilot writes says so, and only such files are ever changed or removed
export const MARKER = 'source: avi-copilot';
const NO_WORKSPACE = 'No workspace';
const MAX_BODY_CHARS = 60_000;

export interface VaultSource {
  workspaces: Workspace[];
  items: KnowledgeItem[];
  chunks: (itemId: string) => KnowledgeChunk[];
  messages: (threadId: string) => ThreadMessage[];
  meeting: (meetingId: string) => MeetingRecord | undefined;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const FOLDERS: Record<GraphNode['type'], string> = {
  thread: 'Chats',
  meeting: 'Meetings',
  page: 'Pages',
  note: 'Notes',
  'ai-session': 'AI sessions',
  ambient: 'Heard',
  person: 'People',
  project: 'Projects',
  organization: 'Organizations',
  decision: 'Decisions',
  action: 'Actions',
};

/** A name Obsidian and every file system accept, kept short. */
export function safeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80)
      .trim() || 'Untitled'
  );
}

function day(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function yamlValue(value: string): string {
  return JSON.stringify(value);
}

/**
 * Makes words from web pages, meetings and chats inert in Obsidian, which can run or load what a note
 * holds. Rather than look for dangerous patterns, it escapes the characters they are made of, so none
 * can form: backslashes first (so text cannot pre-escape an escape), then every backtick and tilde (no
 * code block, so nothing for Dataview or a plugin to run, and no inline query), every "!" before "[" (no
 * image or embed loads), and "&" and "<" (no HTML, no Templater tag). Links that would act inside
 * Obsidian or run script are cut. Text stays readable; it just never runs.
 */
export function defang(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/~/g, '\\~')
    .replace(/!(?=\s*\[)/g, '\\!')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\b(javascript|vbscript|data|obsidian|file):/gi, '$1\u200b:');
}

/** A name or title as one inert line. */
function oneLine(text: string): string {
  return defang(text.replace(/\s+/g, ' ').trim());
}

/**
 * Every note the copilot keeps in the vault, by path: each source with its words, and each person,
 * project and organization with what it is linked to. Links are full paths, so the same name in two
 * workspaces stays two notes.
 */
export function vaultNotes(source: VaultSource): Map<string, string> {
  const workspaceName = new Map(source.workspaces.map(workspace => [workspace.id, safeName(workspace.name)]));
  const folderOf = (workspaceId: string | null | undefined) =>
    `${EXPORT_ROOT}/${(workspaceId && workspaceName.get(workspaceId)) || NO_WORKSPACE}`;
  const nodes = new Map(source.nodes.map(node => [node.id, node]));
  const paths = new Map<string, string>();
  const taken = new Set<string>();

  // Where each source and entity lives; a name already taken gets its date or id added
  const pathFor = (node: Pick<GraphNode, 'id' | 'type' | 'label' | 'date' | 'workspaceId'>) => {
    if (paths.has(node.id)) return paths.get(node.id)!;
    const dated = ['thread', 'meeting', 'ai-session'].includes(node.type)
      ? `${day(node.date)} ${safeName(node.label)}`
      : safeName(node.label);
    let path = `${folderOf(node.workspaceId)}/${FOLDERS[node.type]}/${dated}`;
    if (taken.has(path.toLowerCase())) path = `${path} ${node.id.slice(-6).replace(/[^\w]/g, '')}`;
    taken.add(path.toLowerCase());
    paths.set(node.id, path);
    return path;
  };
  const link = (node: GraphNode) => `[[${pathFor(node)}|${defang(node.label).replace(/[[\]|]/g, ' ')}]]`;

  // The copilot's own sources; notes read from the vault are not written back
  const items = source.items.filter(item => !item.sourceId.startsWith('vault:'));
  for (const item of items) {
    pathFor({
      id: item.id,
      type: item.sourceType,
      label: item.title,
      date: item.sourceDate,
      workspaceId: item.workspaceId ?? null,
    });
  }
  const entities = source.nodes.filter(node => ['person', 'project', 'organization'].includes(node.type));
  for (const node of entities) pathFor(node);

  const linksOf = (id: string) =>
    source.edges
      .filter(edge => edge.from === id || edge.to === id)
      .map(edge => ({ edge, other: nodes.get(edge.from === id ? edge.to : edge.from) }))
      .filter((entry): entry is { edge: GraphEdge; other: GraphNode } => !!entry.other);

  const files = new Map<string, string>();
  const frontmatter = (type: string, workspaceId: string | null | undefined, date: number, id: string) =>
    [
      '---',
      MARKER,
      `type: ${type}`,
      `workspace: ${yamlValue((workspaceId && workspaceName.get(workspaceId)) || NO_WORKSPACE)}`,
      `date: ${day(date)}`,
      `id: ${yamlValue(id)}`,
      '---',
    ].join('\n');

  for (const item of items) {
    let body = '';
    if (item.sourceType === 'thread') {
      body = source
        .messages(item.sourceId)
        .filter(message => message.actor === 'user' || message.actor === 'planner')
        .map(message => `**${message.actor === 'user' ? 'You' : 'Copilot'}:** ${message.content}`)
        .join('\n\n');
    } else if (item.sourceType === 'meeting') {
      body = source.meeting(item.sourceId)?.markdown ?? '';
    }
    if (!body)
      body = source
        .chunks(item.id)
        .map(chunk => chunk.text)
        .join('\n\n');
    if (item.url) body = `Source: ${item.url}\n\n${body}`;

    const links = linksOf(item.id);
    const named = (type: GraphNode['type']) =>
      links.filter(entry => entry.other.type === type).map(entry => link(entry.other));
    const decisions = links
      .filter(entry => entry.edge.kind === 'decided_in')
      .map(entry => `- ${oneLine(entry.other.label)}`);
    const actions = links
      .filter(entry => entry.edge.kind === 'raised_in')
      .map(entry => {
        const owner = linksOf(entry.other.id).find(link => link.edge.kind === 'assigned_to')?.other;
        return `- [ ] ${oneLine(entry.other.label)}${owner ? ` (${link(owner)})` : ''}`;
      });
    const sections = [
      frontmatter(item.sourceType, item.workspaceId, item.sourceDate, item.id),
      `# ${oneLine(item.title)}`,
      defang(body.slice(0, MAX_BODY_CHARS)),
      named('person').length || named('project').length || named('organization').length
        ? [
            '## Linked',
            named('project').length ? `- Projects: ${named('project').join(', ')}` : '',
            named('person').length ? `- People: ${named('person').join(', ')}` : '',
            named('organization').length ? `- Organizations: ${named('organization').join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '',
      decisions.length ? `## Decisions\n${decisions.join('\n')}` : '',
      actions.length ? `## Actions\n${actions.join('\n')}` : '',
    ];
    files.set(`${paths.get(item.id)}.md`, `${sections.filter(Boolean).join('\n\n')}\n`);
  }

  for (const node of entities) {
    const links = linksOf(node.id);
    const sources = links.filter(
      entry =>
        ['thread', 'meeting', 'page', 'note', 'ai-session'].includes(entry.other.type) && paths.has(entry.other.id),
    );
    const parts = links.filter(entry => entry.edge.kind === 'part_of').map(entry => entry.other);
    const assigned = links.filter(entry => entry.edge.kind === 'assigned_to').map(entry => entry.other);
    const sections = [
      frontmatter(node.type, node.workspaceId, node.date, node.id),
      `# ${oneLine(node.label)}`,
      sources.length ? `## Appears in\n${sources.map(entry => `- ${link(entry.other)}`).join('\n')}` : '',
      parts.filter(part => part.type === 'decision').length
        ? `## Decisions\n${parts
            .filter(part => part.type === 'decision')
            .map(part => `- ${oneLine(part.label)}`)
            .join('\n')}`
        : '',
      [...parts.filter(part => part.type === 'action'), ...assigned].length
        ? `## Actions\n${[...new Set([...parts.filter(part => part.type === 'action'), ...assigned])]
            .map(part => `- [ ] ${oneLine(part.label)}`)
            .join('\n')}`
        : '',
    ];
    files.set(`${paths.get(node.id)}.md`, `${sections.filter(Boolean).join('\n\n')}\n`);
  }
  return files;
}

/** What a vault note says about itself: its workspace, and whether the copilot wrote it. */
export function readFrontmatter(text: string): { workspace: string | null; ours: boolean; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { workspace: null, ours: false, body: text };
  const yaml = match[1];
  const workspace = /^workspace:\s*"?([^"\n]+?)"?\s*$/m.exec(yaml)?.[1]?.trim() ?? null;
  return { workspace, ours: yaml.split(/\r?\n/).includes(MARKER), body: text.slice(match[0].length) };
}
