import { Dexie } from 'dexie';
import { kbItemId } from '@extension/storage';
import type {
  AviCopilotDb,
  KnowledgeItem,
  MeetingRecord,
  PlaceKind,
  PlaceRef,
  Task,
  ThreadRecord,
  WorkspaceSetBy,
} from '@extension/storage';
import type { PlaceItem } from './rules';

/**
 * Everything that can sit in a workspace, read and moved one way (docs/pm-desk.md, Part 3): open tasks, chats, meetings
 * and knowledge items. A chat or meeting takes its knowledge item (and a meeting its notes chat) along; those are not
 * listed on their own. Plain reads and writes: the rules and the sheet decide, this only does.
 */
export interface ItemSource {
  list(): Promise<PlaceItem[]>;
  get(ref: PlaceRef): Promise<PlaceItem | null>;
  /** Puts a thing in a workspace (or none) and records who did. False when the thing is gone. */
  set(ref: PlaceRef, workspaceId: string | null, setBy: WorkspaceSetBy | null): Promise<boolean>;
  /** How many things of any kind sit in a workspace, done or not. */
  countIn(workspaceId: string): Promise<number>;
}

export interface ItemSourceDeps {
  db: AviCopilotDb;
  // Moves knowledge items and keeps the search index in step (the knowledge base's own `setWorkspace`)
  kbSetWorkspace: (ids: string[], workspaceId: string | null, setBy: WorkspaceSetBy | null) => Promise<number>;
  now?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;
// Chats older than this stay where they are; a long-finished chat is not worth sorting
const CHAT_WITHIN = 90 * DAY;
const MAX_CHATS = 300;
// Knowledge items that follow their source and are never placed on their own
const FOLLOWERS = new Set<KnowledgeItem['sourceType']>(['thread', 'meeting']);

const oneLine = (text: string, max = 120) => text.replace(/\s+/g, ' ').trim().slice(0, max);
const without = (text: string) => text.replace(/<nano_[a-z_]+[\s\S]*?<\/nano_[a-z_]+>/g, ' ');

export function createItemSource({ db, kbSetWorkspace, now = Date.now }: ItemSourceDeps): ItemSource {
  const firstAsk = async (threadId: string): Promise<string> => {
    const first = await db.messages
      .where('[threadId+seq]')
      .between([threadId, Dexie.minKey], [threadId, Dexie.maxKey])
      .filter(message => message.actor === 'user')
      .first();
    return first ? oneLine(without(first.content), 600) : '';
  };

  const task = (record: Task): PlaceItem => ({
    ref: { kind: 'task', id: record.id },
    title: oneLine(record.title),
    text: `${record.title} ${record.detail ?? ''}`,
    names: record.ownerName ? [record.ownerName] : [],
    workspaceId: record.workspaceId,
    setBy: record.workspaceSetBy ?? null,
  });

  const thread = async (record: ThreadRecord): Promise<PlaceItem> => ({
    ref: { kind: 'thread', id: record.id },
    title: oneLine(record.title),
    text: `${record.title}\n${await firstAsk(record.id)}`,
    names: [],
    workspaceId: record.workspaceId ?? null,
    setBy: record.workspaceSetBy ?? null,
  });

  // A meeting's words are what Avi typed it is about; never an invite's or a page's title, which anyone can write
  const meeting = (record: MeetingRecord): PlaceItem => ({
    ref: { kind: 'meeting', id: record.id },
    title: oneLine(record.note?.title || record.title || record.topic || ''),
    text: record.topicSource === 'user' ? (record.topic ?? '') : '',
    names: record.roster ?? [],
    workspaceId: record.workspaceId ?? null,
    setBy: record.workspaceSetBy ?? null,
  });

  // A saved page's title is the page's own words: its address is the only thing the rules read of it
  const knowledge = (record: KnowledgeItem): PlaceItem => ({
    ref: { kind: 'kb', id: record.id },
    title: oneLine(record.title),
    text: record.sourceType === 'page' ? record.url : `${record.title} ${record.url}`,
    names: [],
    workspaceId: record.workspaceId ?? null,
    setBy: record.workspaceSetBy ?? null,
  });

  const get = async (ref: PlaceRef): Promise<PlaceItem | null> => {
    switch (ref.kind) {
      case 'task': {
        const found = await db.tasks.get(ref.id);
        return found ? task(found) : null;
      }
      case 'thread': {
        const found = await db.threads.get(ref.id);
        return found ? thread(found) : null;
      }
      case 'meeting': {
        const found = await db.meetings.get(ref.id);
        return found ? meeting(found) : null;
      }
      default: {
        const found = await db.kbItems.get(ref.id);
        return found ? knowledge(found) : null;
      }
    }
  };

  return {
    async list() {
      const items: PlaceItem[] = (await db.tasks.where('status').equals('open').toArray()).map(task);
      const since = now() - CHAT_WITHIN;
      const chats = (await db.threads.toArray())
        .filter(
          record =>
            !record.archived &&
            !record.meetingId &&
            record.origin !== 'brief' &&
            !record.tags.includes('brief') &&
            record.updatedAt >= since,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHATS);
      for (const record of chats) items.push(await thread(record));
      items.push(...(await db.meetings.where('status').equals('done').toArray()).map(meeting));
      items.push(...(await db.kbItems.toArray()).filter(record => !FOLLOWERS.has(record.sourceType)).map(knowledge));
      return items;
    },

    get,

    countIn: workspaceId => countIn(db, workspaceId),

    async set(ref, workspaceId, setBy) {
      if (!(await get(ref))) return false;
      switch (ref.kind) {
        case 'task':
          // Where a task is says nothing about how recently it was worked on, so its date is left alone
          await db.tasks.update(ref.id, { workspaceId, workspaceSetBy: setBy ?? 'rule' });
          return true;
        case 'thread': {
          await db.threads.update(ref.id, { workspaceId, workspaceSetBy: setBy ?? undefined });
          await kbSetWorkspace([kbItemId('thread', ref.id)], workspaceId, null);
          return true;
        }
        case 'meeting': {
          const record = await db.meetings.get(ref.id);
          await db.meetings.update(ref.id, { workspaceId, workspaceSetBy: setBy ?? undefined });
          if (record?.threadId) {
            await db.threads.update(record.threadId, { workspaceId, workspaceSetBy: setBy ?? undefined });
          }
          await kbSetWorkspace([kbItemId('meeting', ref.id)], workspaceId, null);
          return true;
        }
        default:
          await kbSetWorkspace([ref.id], workspaceId, setBy);
          return true;
      }
    },
  };
}

export const KIND_LABEL: Record<PlaceKind, string> = {
  task: 'Task',
  thread: 'Chat',
  meeting: 'Meeting',
  kb: 'Knowledge',
};

/** How many things of any kind sit in a workspace, done or not: whether it is empty. */
export async function countIn(db: AviCopilotDb, workspaceId: string): Promise<number> {
  const [tasks, threads, meetings, knowledge] = await Promise.all([
    db.tasks.where('workspaceId').equals(workspaceId).count(),
    db.threads.filter(thread => thread.workspaceId === workspaceId).count(),
    db.meetings.filter(meeting => meeting.workspaceId === workspaceId).count(),
    db.kbItems.filter(item => item.workspaceId === workspaceId).count(),
  ]);
  return tasks + threads + meetings + knowledge;
}
