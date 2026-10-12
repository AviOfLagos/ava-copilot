import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, InboxItem } from '@extension/storage';

/**
 * What workflows leave in the Inbox: approvals a run waits on, alerts (paused, outcome unknown, failed),
 * and results from out.inbox steps. One item per source and external id, so a step run twice, or a run
 * woken twice, never leaves two.
 */

export type InboxDraft = Pick<InboxItem, 'source' | 'externalId' | 'kind' | 'title' | 'body'> &
  Partial<Pick<InboxItem, 'links' | 'priority' | 'workspaceId' | 'agentId' | 'runId' | 'approval'>>;

// The prefix of an approval's request id: "workflow-step:<runId>:<nodeId>"
export const APPROVAL_PREFIX = 'workflow-step:';

export const workflowSource = (workflowId: string) => `workflow:${workflowId}`;
export const inboxItemId = (source: string, externalId: string) => `${source}|${externalId}`;

/** Adds an item once; an item already there keeps its status (the user may have read or done it). */
export async function postToInbox(draft: InboxDraft, database: AviCopilotDb = defaultDb): Promise<InboxItem> {
  const id = inboxItemId(draft.source, draft.externalId);
  return database.transaction('rw', database.inbox, async () => {
    const existing = await database.inbox.get(id);
    if (existing) return existing;
    const now = Date.now();
    const item: InboxItem = {
      id,
      links: [],
      priority: 'normal',
      workspaceId: null,
      agentId: null,
      runId: null,
      approval: null,
      ...draft,
      // From a page or a model: kept as data, cut to a size the Inbox shows
      title: draft.title.slice(0, 200),
      body: draft.body.slice(0, 8000),
      status: 'unread',
      snoozeUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    await database.inbox.put(item);
    return item;
  });
}

/** Marks an item done, e.g. an approval the user answered in the panel. */
export async function settleInboxItem(source: string, externalId: string, database: AviCopilotDb = defaultDb) {
  await database.inbox.update(inboxItemId(source, externalId), { status: 'done', updatedAt: Date.now() });
}

/** The run and node an approval's request id names, or null. */
export function parseApprovalRequest(requestId: string): { runId: string; nodeId: string } | null {
  if (!requestId.startsWith(APPROVAL_PREFIX)) return null;
  const [runId, nodeId] = requestId.slice(APPROVAL_PREFIX.length).split(':');
  return runId && nodeId ? { runId, nodeId } : null;
}
