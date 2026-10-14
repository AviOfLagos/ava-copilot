import { describe, expect, it } from 'vitest';
import type { KnowledgeChunk, KnowledgeItem, WorkspaceSummary } from '@extension/storage';
import { chunkSession } from '../chunk';
import { importBatch, sessionSourceId } from '../importer';
import { actionsOf, fingerprintOf, plainSummary, rollup, rollupMarkdown } from '../rollup';
import { summaryInput } from '../summary-prompt';
import type { ImportedConversation } from '../tools';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T09:00:00Z');

const item = (id: string, workspaceId: string | null, title: string, at: number): KnowledgeItem => ({
  id,
  sourceType: 'ai-session',
  sourceId: id,
  title,
  url: '',
  sourceDate: at,
  sourceUpdatedAt: at,
  createdAt: at,
  updatedAt: at,
  chunkCount: 1,
  unembedded: 0,
  workspaceId,
  origin: { tool: 'claude-code', project: '/code/x', importId: 'imp' },
});
const chunk = (itemId: string, text: string): KnowledgeChunk => ({
  id: `${itemId}#0`,
  itemId,
  index: 0,
  text,
  label: 'turn 1',
  anchor: { kind: 'note', itemId },
  hash: text,
  vector: null,
  embedModel: null,
});

const items = [
  item('a1', 'acme', 'Acme pricing page', NOW - DAY),
  item('a2', 'acme', 'Acme launch email', NOW - 2 * DAY),
  item('f1', 'fest', 'Fest speaker list', NOW - 3 * 60_000),
  item('g1', null, 'Random question', NOW - 10 * DAY),
];
const texts: Record<string, string> = {
  a1: 'User: price at 20 dollars',
  a2: 'User: send the launch email Friday',
  f1: 'User: FEST-ONLY-SECRET-PLAN invite Ada',
  g1: 'User: GENERAL-ONLY what is a monad',
};

describe('summaryInput', () => {
  it("reads only the workspace's own items: nothing from another workspace or from none", () => {
    const { prompt, sources } = summaryInput({ id: 'acme', name: 'Acme' }, items, id => [chunk(id, texts[id])], NOW);
    expect(sources.map(source => source.title)).toEqual(['Acme pricing page', 'Acme launch email']);
    expect(prompt).toContain('price at 20 dollars');
    expect(prompt).toContain('send the launch email Friday');
    expect(prompt).not.toContain('FEST-ONLY');
    expect(prompt).not.toContain('Fest speaker list');
    expect(prompt).not.toContain('GENERAL-ONLY');
    // Sources are data, never instructions
    expect(prompt).toMatch(/nano_untrusted_content/);
    expect(prompt).toMatch(/\[1\] Claude Code session "Acme pricing page"/);
  });

  it('reads what is in no workspace for the general summary', () => {
    const { prompt, sources } = summaryInput(
      { id: null, name: 'No workspace' },
      items,
      id => [chunk(id, texts[id])],
      NOW,
    );
    expect(sources.map(source => source.itemId)).toEqual(['g1']);
    expect(prompt).not.toMatch(/Acme|FEST/);
  });
});

describe('actions and the roll-up', () => {
  const text = `## Where we are\nPricing is set [1].\n## Next actions\n- [ ] Send the launch email (by 2026-10-17) [2]\n- [ ] Update the pricing page [1]\n## Decisions\n- Price is $20 [1]`;

  it('takes the next actions out of a summary', () => {
    expect(actionsOf(text)).toEqual(['Send the launch email (by 2026-10-17) [2]', 'Update the pricing page [1]']);
    expect(actionsOf('no sections')).toEqual([]);
  });

  it('lists each workspace with its latest activity and actions, most recent first', () => {
    const summary = { actions: actionsOf(text) } as WorkspaceSummary;
    const entries = rollup(
      [
        { id: 'acme', name: 'Acme' },
        { id: 'fest', name: 'Tech Fest' },
        { id: 'empty', name: 'Empty' },
      ],
      { acme: summary },
      items,
      NOW,
    );
    expect(entries.map(entry => entry.name)).toEqual(['Tech Fest', 'Acme', 'No workspace']);
    expect(entries[1]).toMatchObject({ recent: 2, latest: { title: 'Acme pricing page' } });
    expect(entries[1].actions).toHaveLength(2);
    const markdown = rollupMarkdown(entries);
    expect(markdown).toContain('**Acme**: latest "Acme pricing page"');
    expect(markdown).toContain('- [ ] Send the launch email (by 2026-10-17)');
    expect(markdown).not.toContain('[2]');
  });

  it('writes a plain summary and a fingerprint that changes with the items', () => {
    expect(
      plainSummary([{ n: 1, itemId: 'a1', title: 'Acme pricing page', sourceType: 'ai-session', date: NOW }]),
    ).toMatch(/Recent work\n- Acme pricing page \(2026-10-14\) \[1\]/);
    expect(fingerprintOf(items)).not.toBe(fingerprintOf([...items.slice(1), { ...items[0], updatedAt: NOW + 1 }]));
  });
});

describe('importBatch', () => {
  const conversation = (updatedAt: number, project = '/Users/me/code/acme'): ImportedConversation => ({
    id: 's1',
    tool: 'claude-code',
    title: 'Ship the pricing page',
    project,
    branch: 'main',
    startedAt: NOW - DAY,
    updatedAt,
    turns: [
      { role: 'user', text: 'Ship the pricing page', at: NOW - DAY },
      { role: 'assistant', text: 'Shipped.', at: updatedAt },
    ],
  });

  function harness() {
    const stored = new Map<string, KnowledgeItem>();
    const writes: { sourceId: string; workspaceId: string | null; chunks: number }[] = [];
    const deps = {
      kb: {
        saveSessions: async (
          sessions: { sourceId: string; workspaceId: string | null; sourceUpdatedAt: number; chunks: unknown[] }[],
        ) => {
          for (const session of sessions) {
            writes.push({
              sourceId: session.sourceId,
              workspaceId: session.workspaceId,
              chunks: session.chunks.length,
            });
            stored.set(`ai-session:${session.sourceId}`, {
              ...item(`ai-session:${session.sourceId}`, session.workspaceId, '', session.sourceUpdatedAt),
            });
          }
          return [];
        },
      },
      store: { item: async (id: string) => stored.get(id) },
      workspaces: async () => [{ id: 'acme', name: 'Acme', about: '', keywords: [], accounts: {}, createdAt: 0 }],
      mappings: async () => ({}) as Record<string, string | null>,
    };
    return { deps, writes };
  }

  it('routes, stores, and on a re-read only writes what changed', async () => {
    const { deps, writes } = harness();
    expect(await importBatch('imp', [conversation(NOW)], deps)).toEqual({
      added: 1,
      updated: 0,
      unchanged: 0,
      redacted: 0,
    });
    expect(writes).toEqual([{ sourceId: 'claude-code:s1', workspaceId: 'acme', chunks: 1 }]);

    expect(await importBatch('imp', [conversation(NOW)], deps)).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(writes).toHaveLength(1);

    expect(await importBatch('imp', [conversation(NOW + 60_000)], deps)).toMatchObject({ updated: 1 });
    expect(await importBatch('imp', [conversation(NOW + 60_000)], deps, true)).toMatchObject({ updated: 1 });
    expect(writes).toHaveLength(3);
  });

  it('chunks a session with where it came from, citing its turns', () => {
    const chunks = chunkSession('ai-session:claude-code:s1', conversation(NOW));
    expect(chunks[0].text).toMatch(
      /^Claude Code session in \/Users\/me\/code\/acme \(branch main\) on \d{4}-\d\d-\d\d/,
    );
    expect(chunks[0].text).toContain('User: Ship the pricing page');
    expect(chunks[0].anchor).toEqual({ kind: 'note', itemId: 'ai-session:claude-code:s1' });
    expect(sessionSourceId({ tool: 'codex', id: 'x' })).toBe('codex:x');
  });
});

describe('markup from imported sessions', () => {
  it('never reaches the brief as a link, an image or HTML', async () => {
    const { flat, plainSummary } = await import('../rollup');
    const evil =
      'Fix login ![x](https://evil.example/?k=1) [click](javascript:alert(1)) <img src=x> **bold**\n# Heading';
    const line = flat(evil);
    expect(line).not.toMatch(/[[\]<>!*#]/);
    expect(line).not.toContain('\n');
    const list = plainSummary([
      { n: 1, title: evil, date: Date.parse('2026-10-14'), text: '', sourceType: 'ai-session' } as never,
    ]);
    expect(list).not.toMatch(/!\[|\]\(|<img/);
  });
});
