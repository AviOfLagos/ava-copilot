import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb } from '@extension/storage';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { registerVoiceTool } from '../registry';

/** One line per item for the voice tool's answer: title only, never the untrusted body. */
function lineOf(item: { kind: string; title: string; priority: string }): string {
  const mark = item.kind === 'approval' ? 'approval - ' : item.priority === 'high' ? 'high priority - ' : '';
  return `- ${mark}${item.title}`;
}

export async function inboxSummaryText(database: AviCopilotDb = defaultDb): Promise<string> {
  const open = await database.inbox.where('status').anyOf('unread', 'read').toArray();
  if (open.length === 0) return 'The Inbox is empty.';
  const approvals = open.filter(item => item.kind === 'approval').length;
  const top = [...open]
    .sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || b.createdAt - a.createdAt)
    .slice(0, 5);
  const header =
    approvals > 0
      ? `${open.length} items are waiting, including ${approvals} approval${approvals === 1 ? '' : 's'}.`
      : `${open.length} item${open.length === 1 ? '' : 's'} are waiting.`;
  return [header, 'Top items:', ...top.map(lineOf)].join('\n');
}

export function registerInboxVoiceTools(): void {
  registerVoiceTool({
    declaration: {
      name: 'read_inbox',
      description:
        "Reads the user's Inbox out loud: how many items are waiting, including any approvals, and the " +
        'most important ones by title. Never reads a message body, only titles.',
    },
    guardLabel: 'read your inbox',
    async handler() {
      return wrapUntrustedContent(await inboxSummaryText());
    },
  });
}
