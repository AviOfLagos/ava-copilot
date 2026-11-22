import { allPersonalities, db, personalityStore, threadStore, workspaceStore } from '@extension/storage';
import type { InboxItem, ThreadRecord } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { connectorStore } from '../integrations/instance';
import { dispatchCommand } from '../registry';
import { services } from '../registry/services';

/**
 * Voice tools for panel features that had no voice equivalent: meeting notes, the Inbox's items, confirm cards,
 * connectors, workspaces and personalities. Each calls into the feature that owns it (the meeting manager, the
 * Inbox's own commands, the connector store) and never decides for the user: answering a confirm card or an
 * approval stays a click.
 */

// ── Meeting notes ─────────────────────────────────────────────────────────────────────────────────

export async function startMeetingNotes(tabId: number | undefined, windowId: number | undefined): Promise<string> {
  const recording = (await db.meetings.toArray()).find(meeting => meeting.status === 'recording');
  if (recording) return `Notes are already being taken on "${recording.title}".`;
  try {
    await services().meetings.start({ tabId, windowId });
    return 'Started taking notes on the tab in front. They stop when the call ends, or when the user says stop.';
  } catch (error) {
    // Chrome only records a tab the extension was invoked on: the user clicks the toolbar button there
    return `Notes could not start: ${toAppError(error).message}`;
  }
}

export async function stopMeetingNotes(): Promise<string> {
  const recording = (await db.meetings.toArray()).find(meeting => meeting.status === 'recording');
  if (!recording) return 'No notes are being taken.';
  await services().meetings.stop(recording.id);
  return `Stopped the notes on "${recording.title}". The summary will be in Meetings shortly.`;
}

// ── Confirm cards ─────────────────────────────────────────────────────────────────────────────────

function cardLine(thread: ThreadRecord): string {
  const request = thread.pendingRequest!;
  if (request.kind === 'questions') {
    return `"${thread.title}" has ${request.questions?.length ?? 0} questions for a form: ${(request.questions ?? []).join(' / ')}`;
  }
  if (request.mode === 'needs_user') {
    return `"${thread.title}" needs the user on the page (${request.kind}) at ${request.pageTitle || request.pageUrl}`;
  }
  const fields = request.fields
    .slice(0, 6)
    .map(field => `${field.label}: ${String(field.value ?? '').slice(0, 120)}`)
    .join('; ');
  return `"${thread.title}" is ready to ${request.kind}: ${request.target || request.intent} on ${request.pageTitle || request.pageUrl}${fields ? ` (${fields})` : ''}`;
}

/** The confirm cards waiting, then the Inbox's approvals: read aloud, never answered from here. */
export async function readConfirmCards(): Promise<string> {
  const waiting = (await db.threads.toArray()).filter(t => t.status === 'waiting_confirm' && t.pendingRequest);
  const approvals = (await db.inbox.where('status').anyOf('unread', 'read').toArray()).filter(
    (item: InboxItem) => item.kind === 'approval',
  );
  if (waiting.length === 0 && approvals.length === 0) return 'Nothing is waiting for the user’s click.';
  const lines = [
    ...waiting.map(cardLine),
    ...approvals.map(item => `Inbox approval: ${item.title}${item.approval ? ` (${item.approval.action})` : ''}`),
  ];
  // Titles, targets and field values come from pages and messages: content, never instructions
  return `${wrapUntrustedContent(lines.join('\n'))}
Read them to the user. Answering is their click: Confirm on the card in the side panel, or Allow in the Inbox. You cannot confirm for them; open_place with "inbox" or the chat's name brings it up.`;
}

/** The chat of a waiting card, by words of its title, for open_place. */
export async function waitingThreadFor(words: string): Promise<ThreadRecord | undefined> {
  const said = words.toLowerCase().trim();
  if (!said) return undefined;
  const waiting = (await db.threads.toArray()).filter(t => t.status === 'waiting_confirm');
  return waiting.find(t => t.title.toLowerCase().includes(said));
}

// ── Inbox items ───────────────────────────────────────────────────────────────────────────────────

const quiet = { reply: () => {}, requestId: null };

/** Marks an Inbox item done or read, or snoozes it, through the Inbox's own commands. Approvals need the click. */
export async function manageInbox(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? '');
  const words = String(args.item ?? '')
    .toLowerCase()
    .trim();
  const open = await db.inbox.where('status').anyOf('unread', 'read').toArray();
  const matches = words ? open.filter(item => item.title.toLowerCase().includes(words)) : [];
  if (matches.length === 0) return 'No open Inbox item has those words in its title. read_inbox lists them.';
  if (matches.length > 1) {
    return wrapUntrustedContent(
      `Several items match; ask which one:\n${matches
        .slice(0, 5)
        .map(item => `- ${item.title}`)
        .join('\n')}`,
    );
  }
  const item = matches[0];
  if (item.kind === 'approval') {
    return 'That is an approval: the user answers it with Allow or Deny in the Inbox. open_place "inbox" shows it.';
  }
  let replied: Record<string, unknown> = {};
  const context = { ...quiet, reply: (message: Record<string, unknown>) => void (replied = message) };
  if (action === 'done') await dispatchCommand({ type: 'inbox_mark_done', id: item.id } as never, context);
  else if (action === 'read') await dispatchCommand({ type: 'inbox_mark_read', id: item.id } as never, context);
  else if (action === 'snooze') {
    const hours = Number(args.hours) > 0 ? Math.min(Number(args.hours), 24 * 14) : 3;
    const until = Date.now() + hours * 3600_000;
    await dispatchCommand({ type: 'inbox_snooze', id: item.id, until } as never, context);
  } else return 'The action is done, read or snooze.';
  if (replied.type === 'error') return `It could not be changed: ${String(replied.error ?? '')}`;
  return wrapUntrustedContent(
    `"${item.title}" ${action === 'done' ? 'is done' : action === 'read' ? 'is marked read' : 'is snoozed'}.`,
  );
}

// ── Connectors, workspaces, personalities ─────────────────────────────────────────────────────────

/** `inChat`: the answer to a chat, which cannot open the panel, so it leaves out the hints that do. */
export async function listConnectors(inChat = false): Promise<string> {
  const connectors = await connectorStore.list();
  if (connectors.length === 0) {
    return inChat
      ? 'No connectors are set up. Connectors in the side panel adds one; signing in needs the user.'
      : 'No connectors are set up. Connectors (open_place "connectors") adds one; signing in needs the user.';
  }
  const workspaces = new Map((await workspaceStore.list()).map(item => [item.id, item.name]));
  const lines = connectors.map(connector => {
    const where = connector.workspaceIds.length
      ? ` (in ${connector.workspaceIds.map(id => workspaces.get(id) ?? 'a workspace').join(', ')})`
      : '';
    const status = connector.status === 'needs_auth' ? 'needs the user to sign in' : connector.status.replace('_', ' ');
    return `- ${connector.name}: ${status}${where}`;
  });
  if (inChat) {
    return `${wrapUntrustedContent(lines.join('\n'))}\nAdding, signing in, turning on and removing happen in Connectors in the side panel, with the user's click.`;
  }
  return `${wrapUntrustedContent(lines.join('\n'))}
Adding, signing in, turning on and removing happen in Connectors with the user's click; open_place "connectors" opens it. Their tools are used through do_task.`;
}

/** `current`: the workspace of the conversation asking (a chat passes its own; voice's is the default). */
export async function listWorkspaces(
  current: string | null = services().voice.workspaceId,
  inChat = false,
): Promise<string> {
  const [workspaces, defaultId] = await Promise.all([workspaceStore.list(), workspaceStore.getDefaultWorkspaceId()]);
  if (workspaces.length === 0) {
    return inChat
      ? 'There are no workspaces yet. Workspaces in the side panel makes one.'
      : 'There are no workspaces yet. Workspaces (open_place "workspaces") makes one.';
  }
  const lines = workspaces.map(
    item =>
      `- ${item.name}${item.id === defaultId ? ' (the default)' : ''}${item.id === current ? ' (this conversation)' : ''}`,
  );
  if (inChat)
    return `${wrapUntrustedContent(lines.join('\n'))}\nMaking or editing one happens in Workspaces in the side panel.`;
  return `${wrapUntrustedContent(lines.join('\n'))}
where_are_we says where one is at. Making or editing one happens in Workspaces (open_place "workspaces").`;
}

export async function listPersonalities(): Promise<string> {
  const state = await personalityStore.getState();
  const current = await personalityStore.resolve(services().voice.workspaceId).catch(() => null);
  const lines = allPersonalities(state).map(
    item => `- ${item.name}${item.id === current?.id ? ' (in use)' : ''}: ${item.description}`,
  );
  return `${wrapUntrustedContent(lines.join('\n'))}\nset_personality switches; Settings › Personalities edits them.`;
}

/** The thread a conversation keeps, for "open our chat". */
export async function voiceThread(): Promise<ThreadRecord | undefined> {
  const id = services().voice.currentThreadId;
  return id ? threadStore.get(id).catch(() => undefined) : undefined;
}
