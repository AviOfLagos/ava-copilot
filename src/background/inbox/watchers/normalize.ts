import type { InboxDraft } from '../store';
import type { WatcherConversation } from './types';

const MAX_SENDER = 120;
const MAX_SNIPPET = 2000;

/**
 * A watcher's raw rows as Inbox drafts: trimmed, capped, and anything without a sender or an id
 * dropped (a probe that misread the page leaves no usable trace rather than a blank row). Pure, so
 * it is unit tested the same as any other probe-parsing logic, without a page to run in.
 */
export function toInboxDrafts(source: string, rows: WatcherConversation[]): InboxDraft[] {
  const drafts: InboxDraft[] = [];
  for (const row of rows) {
    const sender = row.sender.trim().slice(0, MAX_SENDER);
    const externalId = row.externalId.trim();
    if (!sender || !externalId) continue;
    const snippet = row.snippet.trim().slice(0, MAX_SNIPPET);
    drafts.push({
      source,
      externalId,
      kind: 'message',
      title: sender,
      body: snippet || '(no preview)',
      priority: 'normal',
    });
  }
  return drafts;
}
