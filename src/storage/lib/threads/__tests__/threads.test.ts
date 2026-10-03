import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../db';
import { createThreadStore, matchesSearch, newThread, sortThreads, titleFrom } from '../threads';
import type { ThreadStore } from '../threads';

let db: AviCopilotDb;
let store: ThreadStore;

beforeEach(() => {
  db = new AviCopilotDb(`test-${crypto.randomUUID()}`);
  store = createThreadStore(db);
});

afterEach(async () => {
  await db.delete();
});

describe('titleFrom', () => {
  it('keeps a short first line as it is', () => {
    expect(titleFrom('  Post the update in #general\nwith details  ')).toBe('Post the update in #general');
  });

  it('cuts a long line at a word', () => {
    const title = titleFrom('Reply to the last three unread emails in Gmail with short drafts that I can review later');
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('Reply to the last three unread emails in Gmail with short…');
  });
});

describe('sortThreads and matchesSearch', () => {
  it('puts pinned threads first, then the most recent', () => {
    const old = newThread({ title: 'old', updatedAt: 1 });
    const recent = newThread({ title: 'recent', updatedAt: 3 });
    const pinned = newThread({ title: 'pinned', updatedAt: 2, pinned: true });
    expect(sortThreads([old, recent, pinned]).map(t => t.title)).toEqual(['pinned', 'recent', 'old']);
  });

  it('matches every word against the title and tags', () => {
    const thread = newThread({ title: 'Stage 2 deadlines', tags: ['zedu'] });
    expect(matchesSearch(thread, 'stage zedu')).toBe(true);
    expect(matchesSearch(thread, 'deadlines gmail')).toBe(false);
    expect(matchesSearch(thread, '')).toBe(true);
  });
});

describe('thread store', () => {
  it('numbers messages in order and names the thread after the first user message', async () => {
    const thread = await store.create();
    await store.addMessage(thread.id, 'user', 'Fill the quote form for Ada');
    await store.addMessage(thread.id, 'navigator', 'Typed the name');
    await store.addMessage(thread.id, 'user', 'Now submit it');

    const messages = await store.messages(thread.id);
    expect(messages.map(m => m.seq)).toEqual([1, 2, 3]);
    expect((await store.get(thread.id))?.title).toBe('Fill the quote form for Ada');
    expect((await store.messages(thread.id, 2)).map(m => m.content)).toEqual(['Now submit it']);
  });

  it('keeps the messages of different threads apart', async () => {
    const a = await store.create();
    const b = await store.create();
    await store.addMessage(a.id, 'user', 'task a');
    await store.addMessage(b.id, 'user', 'task b');
    await store.addMessage(a.id, 'planner', 'answer a');
    expect((await store.messages(a.id)).map(m => m.content)).toEqual(['task a', 'answer a']);
    expect((await store.messages(b.id)).map(m => [m.seq, m.content])).toEqual([[1, 'task b']]);
  });

  it('lists live threads, archived ones separately, and searches', async () => {
    const a = await store.create({ title: 'Gmail drafts' });
    const b = await store.create({ title: 'Form builder' });
    await store.setArchived(b.id, true);
    await store.setPinned(a.id, true);

    expect((await store.list()).map(t => t.title)).toEqual(['Gmail drafts']);
    expect((await store.list({ archived: true })).map(t => t.title)).toEqual(['Form builder']);
    expect((await store.list({ search: 'form' })).length).toBe(0);
    expect((await store.list({ archived: true, search: 'form' })).length).toBe(1);
  });

  it('deletes a thread with its messages', async () => {
    const thread = await store.create();
    await store.addMessage(thread.id, 'user', 'hello');
    await store.remove(thread.id);
    expect(await store.get(thread.id)).toBeUndefined();
    expect(await db.messages.count()).toBe(0);
  });

  it('forks a thread at a message, copying what came before', async () => {
    const thread = await store.create({ title: 'Plan', model: { provider: 'gemini', modelName: 'gemini-3.8-flash' } });
    await store.addMessage(thread.id, 'user', 'one');
    await store.addMessage(thread.id, 'planner', 'two');
    await store.addMessage(thread.id, 'user', 'three');

    const fork = await store.fork(thread.id, 2);
    expect(fork.title).toBe('Plan (branch)');
    expect(fork.model?.modelName).toBe('gemini-3.8-flash');
    expect(fork.forkedFrom).toEqual({ threadId: thread.id, seq: 2 });
    expect(fork.boundTabIds).toEqual([]);
    expect((await store.messages(fork.id)).map(m => [m.seq, m.content])).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
    // The original is untouched
    expect((await store.messages(thread.id)).length).toBe(3);
  });

  it('carries thread memory into a fork only when it ends before the branch point', async () => {
    const thread = await store.create({ memory: 'summary of 1-2', memoryUpToSeq: 2 });
    for (const text of ['a', 'b', 'c', 'd']) await store.addMessage(thread.id, 'user', text);
    expect((await store.fork(thread.id, 3)).memory).toBe('summary of 1-2');
    expect((await store.fork(thread.id, 1)).memory).toBe('');
  });

  it('finds threads that were running or waiting when the background stopped', async () => {
    await store.create({ status: 'running' });
    await store.create({ status: 'waiting_confirm' });
    await store.create({ status: 'idle' });
    await store.create({ status: 'error' });
    expect((await store.unfinished()).map(t => t.status).sort()).toEqual(['running', 'waiting_confirm']);
  });
});
