import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessage, ThreadRecord } from '@extension/storage';
import { retryFromMessage } from '../retry';
import type { RetryFromStore } from '../retry';

function message(seq: number, actor: ThreadMessage['actor'], content: string): ThreadMessage {
  return { id: `msg-${seq}`, threadId: 't1', seq, actor, content, ts: seq };
}

function thread(fields: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: 't1',
    title: 'Original',
    createdAt: 0,
    updatedAt: 0,
    model: null,
    boundTabIds: [],
    boundGroupId: null,
    boundUrl: null,
    status: 'error',
    error: { kind: 'failed', message: 'oops' },
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
    workspaceId: 'ws1',
    agentId: 'agent1',
    origin: 'voice',
    ...fields,
  };
}

/** A minimal in-memory stand-in for ThreadStore, just the methods retryFromMessage calls. */
function fakeStore(source: ThreadRecord, messages: ThreadMessage[]) {
  const forked: ThreadRecord = { ...thread({ id: 'fork1', title: `${source.title} (branch)` }) };
  const updates: { id: string; changes: Partial<ThreadRecord> }[] = [];
  const store: RetryFromStore = {
    get: vi.fn(async id => (id === source.id ? source : undefined)),
    messages: vi.fn(async id => (id === source.id ? messages : [])),
    fork: vi.fn(async (threadId, seq) => {
      expect(threadId).toBe(source.id);
      return { ...forked, forkedFrom: { threadId, seq } };
    }),
    update: vi.fn(async (id, changes) => {
      updates.push({ id, changes });
      return true;
    }),
  };
  return { store, forked, updates };
}

describe('retryFromMessage', () => {
  it('forks just before the message, carries over workspace/agent/origin, and resends its text', async () => {
    const source = thread();
    const messages = [message(1, 'user', 'first question'), message(2, 'user', 'second question')];
    const { store, forked, updates } = fakeStore(source, messages);
    const send = vi.fn(async request => `sent:${request.threadId}:${request.text}`);

    const result = await retryFromMessage(store, send, source.id, 2, 42);

    expect(store.fork).toHaveBeenCalledWith(source.id, 1); // just before seq 2
    expect(updates).toEqual([{ id: forked.id, changes: { workspaceId: 'ws1', agentId: 'agent1', origin: 'voice' } }]);
    expect(send).toHaveBeenCalledWith({
      threadId: forked.id,
      text: 'second question',
      windowId: 42,
      workspaceId: 'ws1',
      origin: 'voice',
      agentId: 'agent1',
    });
    expect(result).toBe(`sent:${forked.id}:second question`);
  });

  it('carries a missing workspace/agent through as null rather than undefined', async () => {
    const source = thread({ workspaceId: null, agentId: null, origin: 'user' });
    const messages = [message(1, 'user', 'only question')];
    const { store, updates } = fakeStore(source, messages);
    const send = vi.fn(async () => 'new-thread');

    await retryFromMessage(store, send, source.id, 1);

    expect(updates[0].changes).toEqual({ workspaceId: null, agentId: null, origin: 'user' });
  });

  it('throws when the thread does not exist', async () => {
    const source = thread();
    const { store } = fakeStore(source, []);
    (store.get as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await expect(retryFromMessage(store, vi.fn(), 'missing', 1)).rejects.toThrow();
  });

  it('throws when the seq is not a user message (nothing sensible to retry)', async () => {
    const source = thread();
    const messages = [message(1, 'user', 'q'), message(2, 'planner', 'the answer')];
    const { store } = fakeStore(source, messages);

    await expect(retryFromMessage(store, vi.fn(), source.id, 2)).rejects.toThrow();
  });
});
