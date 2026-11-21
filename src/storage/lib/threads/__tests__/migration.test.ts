import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import { describe, expect, it } from 'vitest';
import { AviCopilotDb } from '../db';

describe('database upgrade to version 5', () => {
  it('keeps every chat, meeting and knowledge item, and adds the new tables', async () => {
    const name = `upgrade-${crypto.randomUUID()}`;
    // A version 4 database, as an install from before Wave 2 has it
    const old = new Dexie(name);
    old.version(4).stores({
      threads: 'id, updatedAt, status',
      messages: 'id, threadId, [threadId+seq]',
      meetings: 'id, threadId, startedAt, status',
      segments: 'id, meetingId, [meetingId+tStart]',
      audioChunks: 'id, meetingId, [meetingId+index], status',
      kbItems: 'id, sourceType, [sourceType+sourceId], updatedAt, sourceDate',
      kbChunks: 'id, itemId',
      graphNodes: 'id, type, workspaceId, *sourceItemIds',
      graphEdges: 'id, from, to, sourceItemId',
    });
    await old.table('threads').put({ id: 't1', updatedAt: 1, status: 'idle', title: 'Kept' });
    await old.table('kbItems').put({ id: 'note:a', sourceType: 'note', sourceId: 'a', updatedAt: 1, sourceDate: 1 });
    old.close();

    const db = new AviCopilotDb(name);
    expect((await db.threads.get('t1'))?.title).toBe('Kept');
    expect(await db.kbItems.count()).toBe(1);
    await db.jobs.put({
      id: 'j1',
      kind: 'test',
      key: 'once',
      runAt: 0,
      cron: null,
      timezone: null,
      payload: null,
      status: 'scheduled',
      attempts: 0,
      leaseUntil: null,
      lastError: null,
      lastRunAt: null,
      catchUpMs: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    // The job key is unique: the same key twice is refused
    await expect(db.jobs.add({ ...(await db.jobs.get('j1'))!, id: 'j2' })).rejects.toThrow();
    // Later versions only add tables (version 6: ambient listening; version 7: do-once keys; version 8: the
    // growth numbers; version 9: the growth team's approvals and ledger)
    expect(db.verno).toBe(10);
    expect(await db.doOnce.count()).toBe(0);
    expect(await db.growthMetrics.count()).toBe(0);
    expect(await db.growthReadings.count()).toBe(0);
    expect(await db.growthSources.count()).toBe(0);
    expect(await db.growthLinks.count()).toBe(0);
    expect(await db.ambientSessions.count()).toBe(0);
    expect(await db.ambientUtterances.count()).toBe(0);
    db.close();
  });
});
