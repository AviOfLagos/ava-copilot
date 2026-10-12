import { t } from '@extension/i18n';
import type { ThreadMessage, ThreadRecord } from '@extension/storage';

// The slice of ThreadStore this needs, so a test can hand it a fake rather than a real Dexie store
export interface RetryFromStore {
  get(threadId: string): Promise<ThreadRecord | undefined>;
  messages(threadId: string): Promise<ThreadMessage[]>;
  fork(threadId: string, seq: number): Promise<ThreadRecord>;
  update(id: string, changes: Partial<ThreadRecord>): Promise<boolean>;
}

export type RetrySendFn = (request: {
  threadId?: string | null;
  text: string;
  windowId?: number;
  workspaceId?: string | null;
  origin?: ThreadRecord['origin'];
  agentId?: string | null;
}) => Promise<string>;

/**
 * "Retry from here": a new thread holding everything up to just before a user message, with that
 * message sent again in the fork, with a fresh agent and nothing already sent repeated. `fork` itself
 * does not carry over a thread's workspace, agent or origin, so this copies them onto the new thread
 * before sending - a chat must never drift out of its workspace, and a voice-started thread's fork
 * should still auto-speak its answer the way the original would have.
 */
export async function retryFromMessage(
  store: RetryFromStore,
  send: RetrySendFn,
  threadId: string,
  seq: number,
  windowId?: number,
): Promise<string> {
  const [source, messages] = await Promise.all([store.get(threadId), store.messages(threadId)]);
  if (!source) {
    throw new Error(`Thread ${threadId} does not exist`);
  }
  const target = messages.find(message => message.seq === seq && message.actor === 'user');
  if (!target) {
    throw new Error(t('retry_messageNotFound'));
  }

  const fork = await store.fork(threadId, seq - 1);
  await store.update(fork.id, {
    workspaceId: source.workspaceId ?? null,
    agentId: source.agentId ?? null,
    origin: source.origin,
  });
  return send({
    threadId: fork.id,
    text: target.content,
    windowId,
    workspaceId: source.workspaceId ?? null,
    origin: source.origin,
    agentId: source.agentId ?? null,
  });
}
