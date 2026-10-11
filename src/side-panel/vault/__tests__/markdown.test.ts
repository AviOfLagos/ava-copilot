import { describe, expect, it } from 'vitest';
import type { GraphNode, KnowledgeItem, Workspace } from '@extension/storage';
import { defang, EXPORT_ROOT, readFrontmatter, safeName, vaultNotes } from '../markdown';

const ws = (id: string, name: string) =>
  ({ id, name, about: '', keywords: [], accounts: {}, createdAt: 0 }) as Workspace;
const item = (fields: Partial<KnowledgeItem>): KnowledgeItem =>
  ({
    id: 'thread:t1',
    sourceType: 'thread',
    sourceId: 't1',
    title: 'Sponsor email',
    url: '',
    sourceDate: new Date(2026, 9, 11).getTime(),
    sourceUpdatedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    chunkCount: 1,
    unembedded: 0,
    workspaceId: 'tef',
    ...fields,
  }) as KnowledgeItem;
const node = (id: string, type: GraphNode['type'], label: string, workspaceId = 'tef'): GraphNode => ({
  id,
  type,
  label,
  workspaceId,
  sourceItemIds: [],
  date: new Date(2026, 9, 11).getTime(),
  updatedAt: 0,
});

describe('vaultNotes', () => {
  it('writes each source and entity under its workspace, linked by full path', () => {
    const files = vaultNotes({
      workspaces: [ws('tef', 'Tech Ember Fest'), ws('nexprove', 'Nexprove')],
      items: [item({}), item({ id: 'note:vault:x.md', sourceType: 'note', sourceId: 'vault:x.md', title: 'Mine' })],
      chunks: () => [],
      messages: () => [
        { id: '1', threadId: 't1', seq: 1, actor: 'user', content: 'Draft the sponsor email', ts: 0 },
        { id: '2', threadId: 't1', seq: 2, actor: 'navigator', content: 'clicked', ts: 0 },
        { id: '3', threadId: 't1', seq: 3, actor: 'planner', content: 'Drafted.', ts: 0 },
      ],
      meeting: () => undefined,
      nodes: [
        node('thread:t1', 'thread', 'Sponsor email'),
        node('person:tef:ada', 'person', 'Ada'),
        node('person:nexprove:ada', 'person', 'Ada', 'nexprove'),
      ],
      edges: [{ id: 'e', from: 'thread:t1', to: 'person:tef:ada', kind: 'mentions', sourceItemId: 'thread:t1' }],
    });
    const chat = files.get(`${EXPORT_ROOT}/Tech Ember Fest/Chats/2026-10-11 Sponsor email.md`)!;
    expect(chat).toContain('source: avi-copilot');
    expect(chat).toContain('**You:** Draft the sponsor email');
    expect(chat).not.toContain('clicked');
    expect(chat).toContain(`[[${EXPORT_ROOT}/Tech Ember Fest/People/Ada|Ada]]`);
    // The same name in another workspace is another note
    expect(files.has(`${EXPORT_ROOT}/Nexprove/People/Ada.md`)).toBe(true);
    expect(files.get(`${EXPORT_ROOT}/Tech Ember Fest/People/Ada.md`)).toContain('## Appears in');
    // Notes read from the vault are never written back
    expect([...files.keys()].some(path => path.includes('Mine'))).toBe(false);
  });
});

describe('safeName and readFrontmatter', () => {
  it('makes names every file system takes, and reads what a note says about itself', () => {
    expect(safeName('a/b: c?')).toBe('a b c');
    expect(safeName('...')).toBe('Untitled');
    expect(readFrontmatter('---\nworkspace: "Nexprove"\n---\nHi')).toEqual({
      workspace: 'Nexprove',
      ours: false,
      body: 'Hi',
    });
    expect(readFrontmatter('---\nsource: avi-copilot\n---\nx').ours).toBe(true);
    expect(readFrontmatter('No front matter').workspace).toBeNull();
  });
});

describe('defang', () => {
  it('leaves nothing Obsidian would run or load from elsewhere', () => {
    const text = defang(
      [
        '```dataviewjs',
        'app.vault.adapter.write("x", "y")',
        '```',
        'Inline `$= dv.current()` and `= this.file.name`',
        '<% tp.system.prompt() %>',
        '<img src="https://evil.test/p.png"> <script>x</script>',
        '![pixel](https://evil.test/p.png) ![[Secret note]]',
      ].join('\n'),
    );
    expect(text).not.toMatch(/```dataviewjs/);
    expect(text).toMatch(/^```text$/m);
    expect(text).not.toMatch(/`\$=|`=/);
    expect(text).not.toContain('<%');
    expect(text).not.toMatch(/<img|<script/);
    expect(text).not.toMatch(/!\[/);
    expect(text).toContain('[pixel](https://evil.test/p.png)');
  });
});
