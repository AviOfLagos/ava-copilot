import { Dexie } from 'dexie';
import type { ModelConfig } from '../settings/agentModels';
import type { ConfirmRequest } from '../settings/gateSettings';
import { db as defaultDb } from './db';
import type { AviCopilotDb, MessageActor, ThreadMessage, ThreadRecord } from './db';

const TITLE_LENGTH = 60;

/**
 * Makes a thread title from its first message: the first line, cut at a word near 60 characters.
 */
export function titleFrom(text: string): string {
  const firstLine = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  if (firstLine.length <= TITLE_LENGTH) {
    return firstLine;
  }
  const cut = firstLine.slice(0, TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function newThread(fields: Partial<ThreadRecord> = {}): ThreadRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: '',
    createdAt: now,
    updatedAt: now,
    model: null,
    boundTabIds: [],
    boundGroupId: null,
    boundUrl: null,
    status: 'idle',
    error: null,
    activity: '',
    activeTask: null,
    runStartedAt: null,
    pendingRequest: null,
    pinned: false,
    archived: false,
    tags: [],
    memory: '',
    memoryUpToSeq: 0,
    forkedFrom: null,
    meetingId: null,
    ...fields,
  };
}

/**
 * Sorts threads for the list: pinned first, then the most recently active.
 */
export function sortThreads(threads: ThreadRecord[]): ThreadRecord[] {
  return [...threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

/**
 * Whether a thread matches a search: every word appears in its title or tags.
 */
export function matchesSearch(thread: ThreadRecord, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${thread.title} ${thread.tags.join(' ')}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

/**
 * Thread and message storage, over a database that defaults to the extension's own.
 * Tests pass their own database.
 */
export function createThreadStore(db: AviCopilotDb = defaultDb) {
  const messagesOf = (threadId: string) =>
    db.messages.where('[threadId+seq]').between([threadId, Dexie.minKey], [threadId, Dexie.maxKey]);

  const store = {
    db,

    async create(fields: Partial<ThreadRecord> = {}): Promise<ThreadRecord> {
      const thread = newThread(fields);
      await db.threads.add(thread);
      return thread;
    },

    get: (id: string) => db.threads.get(id),

    /** Threads for the list, pinned first. Archived threads only when asked for. */
    async list(options: { archived?: boolean; search?: string } = {}): Promise<ThreadRecord[]> {
      const all = await db.threads.toArray();
      // A search finds words said in a chat too, as chat apps do, not only its title
      const said = new Set<string>();
      const words = (options.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length) {
        await db.messages
          .filter(message => {
            const text = message.content.toLowerCase();
            return words.every(word => text.includes(word));
          })
          .each(message => void said.add(message.threadId));
      }
      return sortThreads(
        all.filter(
          thread =>
            thread.archived === (options.archived ?? false) &&
            (!options.search || matchesSearch(thread, options.search) || said.has(thread.id)),
        ),
      );
    },

    /** Changes fields of a thread. Returns false when the thread does not exist. */
    async update(id: string, changes: Partial<ThreadRecord>, touch = false): Promise<boolean> {
      const updated = await db.threads.update(id, touch ? { ...changes, updatedAt: Date.now() } : changes);
      return updated === 1;
    },

    rename: (id: string, title: string) => store.update(id, { title: titleFrom(title) || title.trim() }),
    setPinned: (id: string, pinned: boolean) => store.update(id, { pinned }),
    setArchived: (id: string, archived: boolean) => store.update(id, { archived }),
    setModel: (id: string, model: ModelConfig | null) => store.update(id, { model }),
    setPendingRequest: (id: string, request: ConfirmRequest | null) =>
      store.update(id, { pendingRequest: request, status: request ? 'waiting_confirm' : 'running' }),

    /** Deletes a thread and all its messages. */
    async remove(id: string): Promise<void> {
      await db.transaction('rw', db.threads, db.messages, async () => {
        await messagesOf(id).delete();
        await db.threads.delete(id);
      });
    },

    /** Adds a message at the end of a thread, and names the thread after its first user message. */
    async addMessage(threadId: string, actor: MessageActor, content: string): Promise<ThreadMessage> {
      return db.transaction('rw', db.threads, db.messages, async () => {
        const last = await messagesOf(threadId).last();
        const message: ThreadMessage = {
          id: crypto.randomUUID(),
          threadId,
          seq: (last?.seq ?? 0) + 1,
          actor,
          content,
          ts: Date.now(),
        };
        await db.messages.add(message);
        const thread = await db.threads.get(threadId);
        const changes: Partial<ThreadRecord> = { updatedAt: message.ts };
        if (thread && !thread.title && actor === 'user') {
          changes.title = titleFrom(content);
        }
        await db.threads.update(threadId, changes);
        return message;
      });
    },

    /** The messages of a thread in order, optionally only those after a position. */
    async messages(threadId: string, afterSeq = 0): Promise<ThreadMessage[]> {
      return db.messages
        .where('[threadId+seq]')
        .between([threadId, afterSeq + 1], [threadId, Dexie.maxKey], true, true)
        .toArray();
    },

    /**
     * Starts a new thread holding a copy of another thread's messages up to and including `seq`.
     * The copy shares no tabs or running state with the original.
     */
    async fork(threadId: string, seq: number): Promise<ThreadRecord> {
      return db.transaction('rw', db.threads, db.messages, async () => {
        const source = await db.threads.get(threadId);
        if (!source) {
          throw new Error(`Thread ${threadId} does not exist`);
        }
        const copied = (await messagesOf(threadId).toArray()).filter(message => message.seq <= seq);
        const fork = newThread({
          title: `${source.title} (branch)`,
          model: source.model,
          tags: [...source.tags],
          // Memory only carries over when it covers no message past the branch point
          memory: source.memoryUpToSeq <= seq ? source.memory : '',
          memoryUpToSeq: source.memoryUpToSeq <= seq ? source.memoryUpToSeq : 0,
          forkedFrom: { threadId, seq },
        });
        await db.threads.add(fork);
        await db.messages.bulkAdd(copied.map(message => ({ ...message, id: crypto.randomUUID(), threadId: fork.id })));
        return fork;
      });
    },

    /** Threads that were running or waiting when the background last stopped. */
    async unfinished(): Promise<ThreadRecord[]> {
      return db.threads.where('status').anyOf('running', 'waiting_confirm').toArray();
    },
  };
  return store;
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

export const threadStore = createThreadStore();
