import { t } from '@extension/i18n';
import { kbItemId, kbSettingsStore, kbStore, meetingStore, threadStore } from '@extension/storage';
import type {
  KbExport,
  KbSettingsConfig,
  KbStore,
  KnowledgeChunk,
  KnowledgeItem,
  KnowledgeSourceType,
  MeetingStore,
  ThreadStore,
} from '@extension/storage';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import { isOverDailyBudget } from '../usage/budget';
import { resolveModels } from '../threads/factory';
import { readPageText } from '../reader/probes';
import { ANSWER_INSTRUCTIONS, citationsIn, questionPrompt } from './answer';
import type { KbAnswer } from './answer';
import { chunkMeeting, chunkNote, chunkPage, chunkThread, hashText } from './chunker';
import type { DraftChunk } from './chunker';
import { createEmbedder } from './embedder';
import type { Embedder } from './embedder';
import { KbIndex } from './search';
import type { SearchHit } from './search';

const logger = createLogger('KnowledgeBase');

// Usage of the knowledge base (embeddings and answers) is counted under this session
export const KB_SESSION = 'knowledge-base';
// Chunks embedded per pass
const EMBED_PASS = 100;
// The most characters of a page that are saved
const MAX_PAGE_CHARS = 200_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A change to the knowledge base: one item put or removed, all of it wiped, or many changed at once
export type KbChange = { type: 'put' | 'remove'; itemId: string } | { type: 'wipe' } | { type: 'sync' };

export interface KbDeps {
  store: KbStore;
  threads: ThreadStore;
  meetings: MeetingStore;
  embedder: (settings: KbSettingsConfig) => Promise<Embedder | null>;
  answerModel: () => Promise<ChatModel>;
  overCap: () => Promise<boolean>;
  readTab: (tabId: number) => Promise<{ title: string; url: string; text: string }>;
}

async function overDailyCap(): Promise<boolean> {
  // The cost cap, and the token cap when models with no known price are in use
  return isOverDailyBudget();
}

/** Reads the text a tab shows, the same way the agent's read_page_text does. */
async function readTab(tabId: number): Promise<{ title: string; url: string; text: string }> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:|^file:/.test(tab.url)) {
    throw new Error(t('kb_pageUnreadable'));
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageText,
    args: [{ offset: 0, max: MAX_PAGE_CHARS }],
  });
  const text = (result?.result as { text?: string } | undefined)?.text ?? '';
  return { title: tab.title || tab.url, url: tab.url, text };
}

const defaultDeps: KbDeps = {
  store: kbStore,
  threads: threadStore,
  meetings: meetingStore,
  embedder: settings => createEmbedder(settings, KB_SESSION),
  answerModel: async () => (await resolveModels(null, { sessionId: KB_SESSION, notify: () => {} })).planner,
  overCap: overDailyCap,
  readTab,
};

/**
 * The knowledge base: past chats, meeting notes and transcripts, and saved pages, searched by
 * meaning and by keyword, answering with citations. All writes go through one queue, so indexing a
 * chat while a page is saved never interleaves.
 */
export class KnowledgeBase {
  private readonly deps: KbDeps;
  private index: KbIndex | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private embedding: Promise<number> | null = null;
  private readonly listeners = new Set<(change: KbChange) => void>();

  constructor(deps: Partial<KbDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private changed(change?: KbChange): void {
    this.index = null;
    if (change) for (const listener of this.listeners) listener(change);
  }

  /** Hears every item added, changed or removed, e.g. to keep the knowledge graph in step. */
  onChange(listener: (change: KbChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stores a source's chunks. A chunk whose text did not change keeps its embedding, so indexing a
   * long chat again only embeds the new turns.
   */
  private async write(
    fields: Pick<
      KnowledgeItem,
      | 'sourceType'
      | 'sourceId'
      | 'title'
      | 'url'
      | 'sourceDate'
      | 'sourceUpdatedAt'
      | 'workspaceId'
      | 'agentId'
      | 'origin'
    >,
    drafts: DraftChunk[],
  ): Promise<KnowledgeItem | null> {
    const id = kbItemId(fields.sourceType, fields.sourceId);
    if (drafts.length === 0) {
      await this.deps.store.remove(id);
      this.changed({ type: 'remove', itemId: id });
      return null;
    }
    const previous = await this.deps.store.item(id);
    const old = new Map((await this.deps.store.chunks(id)).map(chunk => [chunk.hash, chunk]));
    const now = Date.now();
    const chunks: KnowledgeChunk[] = drafts.map((draft, index) => {
      const hash = hashText(draft.text);
      const kept = old.get(hash);
      return {
        id: `${id}#${index}`,
        itemId: id,
        index,
        text: draft.text,
        label: draft.label,
        anchor: draft.anchor,
        hash,
        vector: kept?.vector ?? null,
        embedModel: kept?.embedModel ?? null,
      };
    });
    const item: KnowledgeItem = {
      ...fields,
      id,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      chunkCount: chunks.length,
      unembedded: 0,
    };
    await this.deps.store.put(item, chunks);
    this.changed({ type: 'put', itemId: item.id });
    return item;
  }

  /** Adds or refreshes a chat. Meeting threads are skipped: their meeting is indexed instead. */
  indexThread(threadId: string, force = false): Promise<KnowledgeItem | null> {
    return this.serial(async () => {
      const settings = await kbSettingsStore.getSettings();
      const thread = await this.deps.threads.db.threads.get(threadId);
      if (!thread) {
        await this.deps.store.remove(kbItemId('thread', threadId));
        this.changed({ type: 'remove', itemId: kbItemId('thread', threadId) });
        return null;
      }
      if ((!settings.indexChats && !force) || thread.meetingId) {
        return null;
      }
      const messages = await this.deps.threads.messages(threadId);
      return this.write(
        {
          sourceType: 'thread',
          sourceId: threadId,
          title: thread.title || t('threads_untitled'),
          url: '',
          sourceDate: thread.createdAt,
          sourceUpdatedAt: thread.updatedAt,
          workspaceId: thread.workspaceId ?? null,
          // Chats from an agent's runs are filed under that agent
          agentId: thread.agentId ?? null,
        },
        chunkThread(threadId, messages),
      );
    });
  }

  /** Adds or refreshes a finished meeting: its note and its transcript. */
  indexMeeting(meetingId: string, force = false): Promise<KnowledgeItem | null> {
    return this.serial(async () => {
      const settings = await kbSettingsStore.getSettings();
      const meeting = await this.deps.meetings.get(meetingId);
      if (!meeting || meeting.status !== 'done' || (!settings.indexMeetings && !force)) {
        return null;
      }
      const segments = await this.deps.meetings.segments(meetingId);
      return this.write(
        {
          sourceType: 'meeting',
          sourceId: meetingId,
          title: meeting.note?.title || meeting.title || t('meeting_untitled'),
          url: meeting.url,
          sourceDate: meeting.startedAt,
          sourceUpdatedAt: meeting.endedAt ?? meeting.startedAt,
          workspaceId: meeting.workspaceId ?? null,
        },
        chunkMeeting(meeting, segments),
      );
    });
  }

  /** Saves the page a tab shows. */
  async savePage(
    tabId: number,
    workspaceId: string | null = null,
    agentId: string | null = null,
  ): Promise<KnowledgeItem> {
    const page = await this.deps.readTab(tabId);
    if (!page.text.trim()) {
      throw new Error(t('kb_pageEmpty'));
    }
    const item = await this.serial(async () => {
      const now = Date.now();
      return this.write(
        {
          sourceType: 'page',
          sourceId: page.url,
          title: page.title,
          url: page.url,
          sourceDate: now,
          sourceUpdatedAt: now,
          workspaceId,
          agentId,
        },
        chunkPage(page.url, page.text),
      );
    });
    void this.embedPending();
    return item!;
  }

  /** Keeps something the user asked to remember: a fact, a decision, text from a page. */
  async saveNote(text: string, title?: string, workspaceId: string | null = null): Promise<KnowledgeItem> {
    const body = text.trim();
    if (!body) throw new Error(t('kb_noteEmpty'));
    const sourceId = crypto.randomUUID();
    const item = await this.serial(async () => {
      const now = Date.now();
      return this.write(
        {
          sourceType: 'note',
          sourceId,
          title: title?.trim() || body.split('\n')[0].slice(0, 60),
          url: '',
          sourceDate: now,
          sourceUpdatedAt: now,
          workspaceId,
        },
        chunkNote(kbItemId('note', sourceId), body),
      );
    });
    void this.embedPending();
    return item!;
  }

  /** Keeps or refreshes the user's own notes from their Obsidian vault, by path. */
  async saveVaultNotes(
    notes: { path: string; title: string; text: string; workspaceId: string | null; modified: number }[],
  ): Promise<number> {
    let saved = 0;
    for (const note of notes) {
      const sourceId = `vault:${note.path}`;
      await this.serial(() =>
        this.write(
          {
            sourceType: 'note',
            sourceId,
            title: note.title,
            url: '',
            sourceDate: note.modified,
            sourceUpdatedAt: note.modified,
            workspaceId: note.workspaceId,
          },
          chunkNote(kbItemId('note', sourceId), note.text),
        ),
      );
      saved++;
    }
    void this.embedPending();
    return saved;
  }

  /**
   * Keeps or refreshes conversations brought in from other AI tools (`src/background/history`), already
   * redacted and routed. Returns the items written.
   */
  async saveSessions(
    sessions: {
      sourceId: string;
      title: string;
      sourceDate: number;
      sourceUpdatedAt: number;
      workspaceId: string | null;
      origin: NonNullable<KnowledgeItem['origin']>;
      chunks: DraftChunk[];
    }[],
  ): Promise<KnowledgeItem[]> {
    const saved: KnowledgeItem[] = [];
    for (const session of sessions) {
      const { chunks, ...fields } = session;
      const item = await this.serial(() =>
        this.write({ ...fields, sourceType: 'ai-session', url: '', agentId: null }, chunks),
      );
      if (item) saved.push(item);
    }
    void this.embedPending();
    return saved;
  }

  /** Moves items to another workspace (or none), e.g. when the user maps an imported project folder. */
  setWorkspace(itemIds: string[], workspaceId: string | null): Promise<number> {
    return this.serial(async () => {
      const now = Date.now();
      let moved = 0;
      for (const id of itemIds) {
        const item = await this.deps.store.item(id);
        if (!item || (item.workspaceId ?? null) === workspaceId) continue;
        await this.deps.store.db.kbItems.update(id, { workspaceId, updatedAt: now });
        this.changed({ type: 'put', itemId: id });
        moved++;
      }
      return moved;
    });
  }

  /** Lets go of vault notes the user deleted or moved. */
  async removeVaultNotes(paths: string[]): Promise<void> {
    for (const path of paths) await this.remove(kbItemId('note', `vault:${path}`));
  }

  remove(itemId: string): Promise<void> {
    return this.serial(async () => {
      await this.deps.store.remove(itemId);
      this.changed({ type: 'remove', itemId });
    });
  }

  /** Removes a source's item, e.g. when its chat is deleted. */
  forget(sourceType: KnowledgeSourceType, sourceId: string): Promise<void> {
    return this.remove(kbItemId(sourceType, sourceId));
  }

  wipe(): Promise<void> {
    return this.serial(async () => {
      await this.deps.store.wipe();
      this.changed({ type: 'wipe' });
    });
  }

  exportAll(): Promise<KbExport> {
    return this.deps.store.exportAll();
  }

  async importAll(data: KbExport): Promise<number> {
    const count = await this.serial(async () => {
      const added = await this.deps.store.importAll(data);
      this.changed({ type: 'sync' });
      return added;
    });
    void this.embedPending();
    return count;
  }

  /** Drops items older than the retention setting. */
  async applyRetention(now = Date.now()): Promise<number> {
    const { retentionDays } = await kbSettingsStore.getSettings();
    if (retentionDays <= 0) return 0;
    return this.serial(async () => {
      const removed = await this.deps.store.removeOlderThan(now - retentionDays * DAY_MS);
      if (removed > 0) this.changed({ type: 'sync' });
      return removed;
    });
  }

  /**
   * Brings the knowledge base up to date: applies retention, indexes chats and meetings that
   * changed since they were last indexed, and embeds whatever is still missing an embedding.
   */
  async sweep(): Promise<void> {
    const settings = await kbSettingsStore.getSettings();
    await this.applyRetention();
    const cutoff = settings.retentionDays > 0 ? Date.now() - settings.retentionDays * DAY_MS : 0;
    const indexed = new Map((await this.deps.store.items()).map(item => [item.id, item]));

    if (settings.indexChats) {
      for (const thread of await this.deps.threads.db.threads.toArray()) {
        const item = indexed.get(kbItemId('thread', thread.id));
        const settled = thread.status === 'idle' || thread.status === 'error';
        if (
          settled &&
          !thread.meetingId &&
          thread.createdAt >= cutoff &&
          (!item || item.sourceUpdatedAt < thread.updatedAt)
        ) {
          await this.indexThread(thread.id);
        }
      }
    }
    if (settings.indexMeetings) {
      for (const meeting of await this.deps.meetings.db.meetings.where('status').equals('done').toArray()) {
        if (!indexed.has(kbItemId('meeting', meeting.id)) && meeting.startedAt >= cutoff) {
          await this.indexMeeting(meeting.id);
        }
      }
    }
    await this.embedPending();
  }

  /** Runs a sweep a little later, once, however many times it is asked for meanwhile. */
  scheduleSweep(delayMs = 3000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweep().catch(error => logger.error('Knowledge base sweep failed', error));
    }, delayMs);
  }

  /** Embeds chunks that have no embedding yet. Failures leave them for the next sweep. */
  embedPending(): Promise<number> {
    // One pass at a time, so no chunk is paid for twice
    this.embedding ??= this.embedAll().finally(() => {
      this.embedding = null;
    });
    return this.embedding;
  }

  private async embedAll(): Promise<number> {
    const settings = await kbSettingsStore.getSettings();
    const embedder = await this.deps.embedder(settings);
    if (!embedder) return 0;
    let done = 0;
    for (;;) {
      if (await this.deps.overCap()) break;
      const pending = await this.deps.store.needingEmbedding(embedder.model, EMBED_PASS);
      if (pending.length === 0) break;
      try {
        const titles = await Promise.all(
          pending.map(async chunk => (await this.deps.store.item(chunk.itemId))?.title ?? ''),
        );
        const vectors = await embedder.embed(
          pending.map(chunk => chunk.text),
          'document',
          titles,
        );
        if (vectors.length !== pending.length) {
          throw new Error(`Expected ${pending.length} embeddings, got ${vectors.length}`);
        }
        await this.serial(async () => {
          await this.deps.store.setVectors(
            pending.map((chunk, index) => ({ id: chunk.id, vector: vectors[index], embedModel: embedder.model })),
          );
          this.changed();
        });
        done += pending.length;
      } catch (error) {
        logger.error('Embedding failed', error);
        break;
      }
    }
    return done;
  }

  private async loadIndex(): Promise<KbIndex> {
    if (!this.index) {
      this.index = new KbIndex(await this.deps.store.items(), await this.deps.store.chunks());
    }
    return this.index;
  }

  /** The passages that best match a query, by meaning when embeddings are available and by keyword. */
  async search(
    query: string,
    limit = 8,
    workspaceId: string | null = null,
    agentId: string | null = null,
  ): Promise<SearchHit[]> {
    const index = await this.loadIndex();
    if (index.size === 0) return [];
    const settings = await kbSettingsStore.getSettings();
    let vector: number[] | null = null;
    const embedder = (await this.deps.overCap()) ? null : await this.deps.embedder(settings);
    if (embedder) {
      try {
        [vector] = await embedder.embed([query], 'query');
      } catch (error) {
        // Keyword search still answers
        logger.error('Could not embed the query', error);
      }
    }
    return index.search(query, vector, { limit, embedModel: embedder?.model ?? null, workspaceId, agentId });
  }

  /** Answers a question from the knowledge base, citing the sources it used. */
  async ask(question: string, workspaceId: string | null = null, agentId: string | null = null): Promise<KbAnswer> {
    if (await this.deps.overCap()) {
      throw new Error(t('usage_capReached_short'));
    }
    const hits = await this.search(question, 8, workspaceId, agentId);
    if (hits.length === 0) {
      return { answer: t('kb_answer_nothing'), citations: [] };
    }
    const answer = (
      await generatePlainText({
        chatModel: await this.deps.answerModel(),
        messages: [systemMessage(ANSWER_INSTRUCTIONS), userMessage(questionPrompt(question, hits))],
      })
    ).trim();
    return { answer, citations: citationsIn(answer, hits) };
  }
}
