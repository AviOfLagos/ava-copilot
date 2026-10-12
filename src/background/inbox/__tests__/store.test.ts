import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import type { InboxDraft } from '../store';
import { RATE_LIMIT_THRESHOLD, RATE_LIMIT_WINDOW_MS, RETENTION_MS } from '../constants';
import {
  addInboxItem,
  digestExternalId,
  digestTitle,
  markDone,
  markRead,
  markUnread,
  pruneDone,
  shouldFoldIntoDigest,
  snoozeItem,
  unreadCount,
  wakeSnoozed,
} from '../store';

let db: AviCopilotDb;

beforeEach(() => {
  db = new AviCopilotDb(`inbox-${crypto.randomUUID()}`);
});

const message = (externalId: string, source = 'whatsapp-web'): InboxDraft => ({
  source,
  externalId,
  kind: 'message',
  title: `Sender ${externalId}`,
  body: 'hello',
});

describe('shouldFoldIntoDigest', () => {
  it('folds only once a source has reached the threshold', () => {
    expect(shouldFoldIntoDigest(RATE_LIMIT_THRESHOLD - 1, RATE_LIMIT_THRESHOLD)).toBe(false);
    expect(shouldFoldIntoDigest(RATE_LIMIT_THRESHOLD, RATE_LIMIT_THRESHOLD)).toBe(true);
    expect(shouldFoldIntoDigest(RATE_LIMIT_THRESHOLD + 10, RATE_LIMIT_THRESHOLD)).toBe(true);
  });
});

describe('digestTitle', () => {
  it('is singular for one, plural otherwise', () => {
    expect(digestTitle(1)).toBe('1 new message');
    expect(digestTitle(6)).toBe('6 new messages');
  });
});

describe('digestExternalId', () => {
  it('is stable within one window and changes in the next', () => {
    const start = Date.UTC(2026, 9, 12, 8, 0, 0);
    const a = digestExternalId(start, RATE_LIMIT_WINDOW_MS);
    const b = digestExternalId(start + RATE_LIMIT_WINDOW_MS - 1, RATE_LIMIT_WINDOW_MS);
    const c = digestExternalId(start + RATE_LIMIT_WINDOW_MS + 1, RATE_LIMIT_WINDOW_MS);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});

describe('addInboxItem', () => {
  it('adds a new item as unread', async () => {
    const item = await addInboxItem(message('c1'), db);
    expect(item.status).toBe('unread');
    expect(item.kind).toBe('message');
    expect(await db.inbox.count()).toBe(1);
  });

  it('dedupes by source+externalId: the same message never lands twice', async () => {
    const first = await addInboxItem(message('c1'), db);
    const second = await addInboxItem({ ...message('c1'), body: 'a different body entirely' }, db);
    expect(second.id).toBe(first.id);
    expect(second.body).toBe('hello');
    expect(await db.inbox.count()).toBe(1);
  });

  it('never folds approvals, results or alerts, only messages', async () => {
    for (let i = 0; i < RATE_LIMIT_THRESHOLD + 3; i++) {
      await addInboxItem(
        { source: 'workflow:w1', externalId: `a${i}`, kind: 'approval', title: 'Approve?', body: '' },
        db,
      );
    }
    const rows = await db.inbox.toArray();
    expect(rows).toHaveLength(RATE_LIMIT_THRESHOLD + 3);
    expect(rows.every(row => row.kind === 'approval')).toBe(true);
  });

  it('folds a burst from one source into one digest, and keeps counting while it continues', async () => {
    for (let i = 0; i < RATE_LIMIT_THRESHOLD + 2; i++) {
      await addInboxItem(message(`c${i}`), db);
    }
    const rows = await db.inbox.toArray();
    const messages = rows.filter(row => row.kind === 'message');
    const digests = rows.filter(row => row.kind === 'alert');
    expect(messages).toHaveLength(RATE_LIMIT_THRESHOLD);
    expect(digests).toHaveLength(1);
    expect(digests[0].digestCount).toBe(RATE_LIMIT_THRESHOLD + 2);
    expect(digests[0].status).toBe('unread');
  });

  it('keeps sources apart: a burst on one source never folds another source', async () => {
    for (let i = 0; i < RATE_LIMIT_THRESHOLD + 2; i++) {
      await addInboxItem(message(`w${i}`, 'whatsapp-web'), db);
    }
    await addInboxItem(message('s1', 'slack-web'), db);
    const slack = await db.inbox.where('source').equals('slack-web').toArray();
    expect(slack).toHaveLength(1);
    expect(slack[0].kind).toBe('message');
  });

  it('a folded digest already marked done wakes back up when more messages arrive', async () => {
    for (let i = 0; i < RATE_LIMIT_THRESHOLD + 1; i++) {
      await addInboxItem(message(`c${i}`), db);
    }
    const digestId = (await db.inbox.toArray()).find(row => row.kind === 'alert')!.id;
    await markDone(digestId, db);
    expect((await db.inbox.get(digestId))!.status).toBe('done');

    await addInboxItem(message('one-more'), db);
    const digest = await db.inbox.get(digestId);
    expect(digest!.status).toBe('unread');
    expect(digest!.digestCount).toBe(RATE_LIMIT_THRESHOLD + 2);
  });

  it('a rate-limit window that has passed lets a source start fresh', async () => {
    // Fake timers would also stall Dexie's own scheduling, so the old burst is seeded straight into
    // the table with a `createdAt` already outside the window, rather than turning the clock back.
    const now = Date.now();
    const old = now - RATE_LIMIT_WINDOW_MS - 1000;
    for (let i = 0; i < RATE_LIMIT_THRESHOLD; i++) {
      await db.inbox.put({
        id: `whatsapp-web|old${i}`,
        source: 'whatsapp-web',
        externalId: `old${i}`,
        kind: 'message',
        title: `Sender ${i}`,
        body: 'hello',
        links: [],
        priority: 'normal',
        status: 'unread',
        snoozeUntil: null,
        workspaceId: null,
        agentId: null,
        runId: null,
        approval: null,
        digestCount: null,
        createdAt: old,
        updatedAt: old,
      });
    }
    const next = await addInboxItem(message('fresh'), db);
    expect(next.kind).toBe('message');
    const alerts = (await db.inbox.toArray()).filter(row => row.kind === 'alert');
    expect(alerts).toHaveLength(0);
  });
});

describe('status changes', () => {
  it('marks read, unread and done', async () => {
    const item = await addInboxItem(message('c1'), db);
    expect(await markRead(item.id, db)).toBe(true);
    expect((await db.inbox.get(item.id))!.status).toBe('read');
    expect(await markDone(item.id, db)).toBe(true);
    expect((await db.inbox.get(item.id))!.status).toBe('done');
    expect(await markUnread(item.id, db)).toBe(true);
    expect((await db.inbox.get(item.id))!.status).toBe('unread');
  });

  it('reports false for an item that does not exist', async () => {
    expect(await markRead('nope', db)).toBe(false);
  });

  it('snoozes with a wake time, and wakeSnoozed only wakes a still-snoozed item', async () => {
    const item = await addInboxItem(message('c1'), db);
    const until = Date.now() + 60_000;
    await snoozeItem(item.id, until, db);
    let stored = await db.inbox.get(item.id);
    expect(stored!.status).toBe('snoozed');
    expect(stored!.snoozeUntil).toBe(until);

    // The user already woke it by hand before the job ran: the job must not re-snooze it
    await markRead(item.id, db);
    await wakeSnoozed(item.id, db);
    stored = await db.inbox.get(item.id);
    expect(stored!.status).toBe('read');
  });

  it('wakeSnoozed clears snoozeUntil and returns to unread', async () => {
    const item = await addInboxItem(message('c1'), db);
    await snoozeItem(item.id, Date.now() + 1000, db);
    await wakeSnoozed(item.id, db);
    const stored = await db.inbox.get(item.id);
    expect(stored!.status).toBe('unread');
    expect(stored!.snoozeUntil).toBeNull();
  });
});

describe('unreadCount', () => {
  it('counts only unread items', async () => {
    const a = await addInboxItem(message('c1'), db);
    await addInboxItem(message('c2'), db);
    await markDone(a.id, db);
    expect(await unreadCount(db)).toBe(1);
  });
});

describe('pruneDone', () => {
  it('removes done items past the retention window, keeps everything else', async () => {
    const old = await addInboxItem(message('old'), db);
    const recentDone = await addInboxItem(message('recent-done'), db);
    const stillUnread = await addInboxItem(message('unread'), db);
    const now = Date.now();
    await db.inbox.update(old.id, { status: 'done', updatedAt: now - RETENTION_MS - 1000 });
    await db.inbox.update(recentDone.id, { status: 'done', updatedAt: now - 1000 });

    const removed = await pruneDone(db, now);
    expect(removed).toBe(1);
    expect(await db.inbox.get(old.id)).toBeUndefined();
    expect(await db.inbox.get(recentDone.id)).toBeDefined();
    expect(await db.inbox.get(stillUnread.id)).toBeDefined();
  });
});
