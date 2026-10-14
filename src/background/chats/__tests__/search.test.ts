import { describe, expect, it, vi } from 'vitest';
import { describeHits, queryWords, rankChats, readChatText, snippetOf } from '../search';

const thread = (id: string, title: string, updatedAt: number, workspaceId: string | null = null) => ({
  id,
  title,
  updatedAt,
  workspaceId,
});
const said = (threadId: string, content: string, ts: number, actor: 'user' | 'planner' | 'system' = 'user') => ({
  threadId,
  content,
  ts,
  actor,
});

describe('search_chats ranking', () => {
  const threads = [
    thread('a', 'Invoice for Acme', 100, 'work'),
    thread('b', 'Weekend plans', 300),
    thread('c', 'Pricing call', 200, 'work'),
    thread('d', 'Acme pricing sheet', 400, 'side'),
  ];
  const messages = [
    said('a', 'Send the Acme invoice by Friday', 90),
    said('b', 'Book the cabin; ask Ada about Acme tickets', 290),
    said('c', 'The pricing for Acme is 40 a seat', 190, 'planner'),
    said('c', 'Moved to the workspace Acme', 195, 'system'),
    said('d', 'Pricing sheet draft', 390),
  ];

  it('matches titles and messages, chats with every word first, then the newest', () => {
    const hits = rankChats(threads, messages, 'acme pricing');
    expect(hits.map(hit => hit.threadId)).toEqual(['d', 'c', 'b', 'a']);
    expect(hits.find(hit => hit.threadId === 'c')?.snippet).toBe('The pricing for Acme is 40 a seat');
  });

  it('puts the asking workspace first and leaves out the asking chat', () => {
    const hits = rankChats(threads, messages, 'acme pricing', { workspaceId: 'work', exclude: ['d'] });
    expect(hits.map(hit => [hit.threadId, hit.inWorkspace])).toEqual([
      ['c', true],
      ['a', true],
      ['b', false],
    ]);
  });

  it('ignores the copilot notes, short words and an empty query', () => {
    expect(rankChats(threads, messages, 'workspace')).toEqual([]);
    expect(rankChats(threads, messages, 'a ?')).toEqual([]);
    expect(queryWords('The  Acme, acme! café')).toEqual(['the', 'acme', 'café']);
  });

  it('says which results come from outside the workspace', () => {
    const hits = rankChats(threads, messages, 'cabin', { workspaceId: 'work' });
    const text = describeHits(hits, 'cabin', { id: 'work', name: 'Work' }, new Map([['work', 'Work']]));
    expect(text).toContain('Nothing in the workspace "Work" matches "cabin".');
    expect(text).toContain('From chats outside "Work"');
    expect(text).toContain('id b | "Weekend plans"');
    expect(describeHits([], 'zzz', null, new Map())).toBe('No chat matches "zzz".');
  });

  it('cuts a snippet around the first word found', () => {
    const long = `${'x '.repeat(200)}the needle is here ${'y '.repeat(200)}`;
    const snippet = snippetOf(long, ['needle'], 60);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet).toContain('needle');
    expect(snippet.length).toBeLessThanOrEqual(62);
  });
});

describe('read_chat', () => {
  const meta = { title: 'Acme', updatedAt: Date.UTC(2026, 9, 10) };

  it('gives the last messages as lines, leaving out notes and naming attachments', async () => {
    const text = await readChatText(meta, [
      { actor: 'user', content: 'Hello', attachments: [{ name: 'shot.png' } as never] },
      { actor: 'system', content: 'Placed in Work' },
      { actor: 'planner', content: 'Hi there' },
    ]);
    expect(text).toBe(
      'Chat "Acme", last active 2026-10-10, its last 2 messages:\nUser: Hello [attached: shot.png]\nAssistant: Hi there',
    );
  });

  it('summarises the older part of a long chat and keeps the last ones', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      actor: 'user' as const,
      content: `message ${i} ${'words '.repeat(80)}`,
    }));
    const summarise = vi.fn(async () => 'They talked about words.');
    const text = await readChatText(meta, messages, 20, summarise);
    expect(summarise).toHaveBeenCalledOnce();
    expect(text).toContain('Summary of the earlier part:\nThey talked about words.');
    expect(text).toContain('User: message 19');
    expect(text).not.toContain('User: message 13 ');
  });

  it('cuts instead when the summary fails', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ actor: 'user' as const, content: 'w '.repeat(400) + i }));
    const text = await readChatText(meta, messages, 20, async () => {
      throw new Error('offline');
    });
    expect(text).toContain('Summary of the earlier part:\nUser: w');
  });
});
