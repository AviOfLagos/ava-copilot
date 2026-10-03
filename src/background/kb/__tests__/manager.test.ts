import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, createKbStore, createMeetingStore, createThreadStore, newMeeting } from '@extension/storage';
import type { KbSettingsConfig, KbStore, MeetingNote, MeetingStore, ThreadStore } from '@extension/storage';
import type * as StorageModule from '@extension/storage';
import type { Embedder } from '../embedder';
import { normalize } from '../search';

const settings: KbSettingsConfig = {
  indexChats: true,
  indexMeetings: true,
  retentionDays: 0,
  embedModel: 'fake-embed',
  embedDimensions: 32,
};
vi.mock('@extension/storage', async original => ({
  ...(await original<typeof StorageModule>()),
  kbSettingsStore: { getSettings: async () => settings },
}));

const answers: string[] = [];
const prompts: string[] = [];
vi.mock('../../llm/generate', () => ({
  generatePlainText: async ({ messages }: { messages: { content: string }[] }) => {
    prompts.push(String(messages.at(-1)?.content));
    return answers.shift() ?? 'No answer';
  },
}));

// The real factory pulls in the browser automation, which needs an extension
vi.mock('../../threads/factory', () => ({ resolveModels: async () => ({}) }));

const { KnowledgeBase } = await import('../manager');

/** Words hashed into buckets: texts that share words point the same way. */
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'fake-embed',
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map(text => {
        const vector = new Array(32).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let hash = 0;
          for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
          vector[hash % 32] += 1;
        }
        return normalize(vector);
      });
    },
  };
}

const note: MeetingNote = {
  title: 'Stage 2 sync',
  tldr: ['Stage 2 moves to Friday'],
  decisions: ['The Stage 2 deadline is Friday 10 October'],
  actionItems: [{ owner: 'Ada', task: 'Email the mentors about Stage 2', due: 'Thursday' }],
  openQuestions: [],
  participants: ['Ada'],
};

let db: AviCopilotDb;
let store: KbStore;
let threads: ThreadStore;
let meetings: MeetingStore;
let embedder: ReturnType<typeof fakeEmbedder>;
let overCap: boolean;
let kb: InstanceType<typeof KnowledgeBase>;

beforeEach(() => {
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join(':') },
  });
  db = new AviCopilotDb(`test-${crypto.randomUUID()}`);
  store = createKbStore(db);
  threads = createThreadStore(db);
  meetings = createMeetingStore(db);
  embedder = fakeEmbedder();
  overCap = false;
  Object.assign(settings, { indexChats: true, indexMeetings: true, retentionDays: 0 });
  answers.length = 0;
  prompts.length = 0;
  kb = new KnowledgeBase({
    store,
    threads,
    meetings,
    embedder: async () => embedder,
    answerModel: async () => ({}) as never,
    overCap: async () => overCap,
    readTab: async () => ({
      title: 'Handbook',
      url: 'https://example.com/handbook',
      text: 'Mentors review every Stage 2 submission within two days.',
    }),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
});

async function chat(title: string, turns: [string, string][]) {
  const thread = await threads.create({ title });
  for (const [question, answer] of turns) {
    await threads.addMessage(thread.id, 'user', question);
    await threads.addMessage(thread.id, 'navigator', 'Clicking element 3');
    await threads.addMessage(thread.id, 'planner', answer);
  }
  return thread;
}

async function meeting(fields: Parameters<typeof newMeeting>[0] = {}) {
  const record = newMeeting({ title: 'Meet', status: 'done', note, endedAt: Date.now(), ...fields });
  await db.meetings.put(record);
  await meetings.addSegments([
    { meetingId: record.id, tStart: 724, tEnd: 730, speaker: 'Ada', text: 'Stage 2 closes on Friday.', chunkIndex: 0 },
  ]);
  return record;
}

describe('KnowledgeBase', () => {
  it('indexes a chat and embeds it', async () => {
    const thread = await chat('Deadlines', [['When is Stage 2 due?', 'Friday 10 October.']]);
    const item = await kb.indexThread(thread.id);
    await kb.embedPending();

    expect(item).toMatchObject({ id: `thread:${thread.id}`, sourceType: 'thread', title: 'Deadlines' });
    const chunks = await store.chunks(item!.id);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('User: When is Stage 2 due?\nCopilot: Friday 10 October.');
    expect(chunks[0].vector).toHaveLength(32);
    expect((await store.item(item!.id))!.unembedded).toBe(0);
  });

  it('only embeds what changed when a chat is indexed again', async () => {
    const long = 'word '.repeat(300);
    const thread = await chat('Long', [
      [long, 'First answer'],
      [long, 'Second answer'],
    ]);
    await kb.indexThread(thread.id);
    await kb.embedPending();
    const before = embedder.calls.flat().length;

    await threads.addMessage(thread.id, 'user', 'And one more question');
    await kb.indexThread(thread.id);
    await kb.embedPending();
    // The earlier chunks kept their embeddings; only the changed last chunk was embedded
    expect(embedder.calls.flat().length - before).toBe(1);
  });

  it('skips meeting threads and respects the setting, unless forced', async () => {
    const meetingThread = await threads.create({ title: 'Meeting – x', meetingId: 'm1' });
    await threads.addMessage(meetingThread.id, 'user', 'hello');
    expect(await kb.indexThread(meetingThread.id)).toBeNull();

    settings.indexChats = false;
    const thread = await chat('Off', [['q', 'a']]);
    expect(await kb.indexThread(thread.id)).toBeNull();
    expect(await kb.indexThread(thread.id, true)).not.toBeNull();
  });

  it('indexes a finished meeting with its note and transcript', async () => {
    const record = await meeting();
    const item = await kb.indexMeeting(record.id);
    const chunks = await store.chunks(item!.id);
    expect(item!.title).toBe('Stage 2 sync');
    expect(chunks.map(chunk => chunk.label)).toEqual(['note', '12:04']);
    expect(await kb.indexMeeting((await meeting({ status: 'recording' })).id)).toBeNull();
  });

  it('answers with citations to the meeting and its timestamp', async () => {
    const record = await meeting({ startedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    await chat('Lunch', [['Where is lunch?', 'At the cafe.']]);
    await kb.sweep();

    answers.push('Stage 2 is due Friday 10 October [1], and it closes on Friday [2].');
    const result = await kb.ask('What did we decide about Stage 2 deadlines last week?');
    expect(prompts[0]).toContain('[1] Meeting "Stage 2 sync"');
    expect(result.citations.map(citation => citation.anchor)).toEqual(
      expect.arrayContaining([
        { kind: 'meeting', meetingId: record.id, t: -1 },
        { kind: 'meeting', meetingId: record.id, t: 724 },
      ]),
    );
  });

  it('says so instead of asking a model when nothing matches', async () => {
    const result = await kb.ask('anything?');
    expect(result).toEqual({ answer: 'kb_answer_nothing', citations: [] });
    expect(prompts).toEqual([]);
  });

  it('searches by keyword when there is no embedding model, and refuses past the daily cap', async () => {
    kb = new KnowledgeBase({
      store,
      threads,
      meetings,
      embedder: async () => null,
      overCap: async () => overCap,
    });
    const thread = await chat('Deadlines', [['When is Stage 2 due?', 'Friday.']]);
    await kb.indexThread(thread.id);
    expect((await kb.search('stage due')).map(hit => hit.item.id)).toEqual([`thread:${thread.id}`]);

    overCap = true;
    await expect(kb.ask('stage?')).rejects.toThrow('usage_capReached_short');
  });

  it('saves a page and finds it', async () => {
    const item = await kb.savePage(1);
    expect(item).toMatchObject({ sourceType: 'page', url: 'https://example.com/handbook', title: 'Handbook' });
    const hits = await kb.search('who reviews submissions');
    expect(hits[0].chunk.anchor).toEqual({ kind: 'page', url: 'https://example.com/handbook' });
  });

  it('sweeps settled chats and done meetings that changed, and nothing else', async () => {
    const settled = await chat('Settled', [['q1', 'a1']]);
    const running = await chat('Running', [['q2', 'a2']]);
    await threads.update(running.id, { status: 'running' });
    await meeting();

    await kb.sweep();
    const ids = (await store.items()).map(item => item.sourceId);
    expect(ids).toContain(settled.id);
    expect(ids).not.toContain(running.id);
    expect((await store.items()).filter(item => item.sourceType === 'meeting')).toHaveLength(1);
  });

  it('removes items past retention, and a deleted chat', async () => {
    const old = await chat('Old', [['q', 'a']]);
    await db.threads.update(old.id, { createdAt: Date.now() - 100 * 24 * 60 * 60 * 1000 });
    const recent = await chat('Recent', [['q', 'a']]);
    await kb.indexThread(old.id);
    await kb.indexThread(recent.id);

    settings.retentionDays = 30;
    expect(await kb.applyRetention()).toBe(1);
    // A sweep does not add it back
    await kb.sweep();
    expect((await store.items()).map(item => item.title)).toEqual(['Recent']);

    await kb.forget('thread', recent.id);
    expect(await store.items()).toEqual([]);
    expect(await store.chunks()).toEqual([]);
  });

  it('exports, wipes and imports back', async () => {
    await kb.indexMeeting((await meeting()).id);
    await kb.embedPending();
    const data = await kb.exportAll();
    expect(data.items).toHaveLength(1);

    await kb.wipe();
    expect(await store.items()).toEqual([]);
    expect(await kb.search('Stage 2')).toEqual([]);

    expect(await kb.importAll(JSON.parse(JSON.stringify(data)))).toBe(1);
    expect((await store.chunks()).every(chunk => chunk.vector?.length === 32)).toBe(true);
    expect((await kb.search('mentors email')).length).toBeGreaterThan(0);
  });

  it('keeps chunks for the next sweep when embedding fails', async () => {
    embedder.embed = async () => {
      throw new Error('quota');
    };
    const thread = await chat('Deadlines', [['q', 'a']]);
    await kb.indexThread(thread.id);
    expect(await kb.embedPending()).toBe(0);
    expect((await store.item(`thread:${thread.id}`))!.unembedded).toBe(1);
  });
});
