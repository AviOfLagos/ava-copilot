import { cleanEmail, db, entityId, localDay, looksLikePhone, workspaceStore } from '@extension/storage';
import type { GraphSlice, KnowledgeItem, ObserveInput, PersonSource } from '@extension/storage';
import type { WatcherConversation } from '../inbox/watchers/types';
import { createLogger } from '../log';
import { isNobody, isSelfName, ownerEmails } from './owner';
import { people } from './people';

/**
 * The places other than calls and invites that meet names (docs/pm-desk.md 5.2), each turned into `observe`
 * inputs by plain code: the Gmail and Slack watchers, the owner's WhatsApp Web tab, GitHub connector results and
 * the knowledge graph's person readings. Only what Ava was already reading; nothing is looked up anywhere.
 */

const logger = createLogger('People');

// Addresses that are a service, not a person
const SERVICE_ADDRESS =
  /^(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|postmaster|newsletters?|news|info|support|help|hello|team|updates?|marketing|billing|accounts?|alerts?|digest|calendar-notification)([+.-].*)?@/i;

/** Gmail rows as inputs: the sender's name and address, never a service address or the owner's own. */
export function gmailInputs(rows: WatcherConversation[], own: Set<string>): ObserveInput[] {
  const inputs: ObserveInput[] = [];
  for (const row of rows) {
    const email = cleanEmail(row.senderEmail);
    if (!email || own.has(email) || SERVICE_ADDRESS.test(email) || /noreply/i.test(email)) continue;
    const text = row.sender.trim() && !isSelfName(row.sender) ? row.sender.trim() : email.split('@')[0];
    inputs.push({
      text,
      source: 'gmail',
      workspaceId: null,
      email,
      ref: `gmail-web|${row.externalId}`,
      context: 'sent you an email',
    });
  }
  return inputs;
}

/**
 * Slack rows as inputs: direct messages only (a channel is not a person), with the DM's own id as the handle, so
 * the same person under a changed display name is still them. One sighting per DM per day.
 */
export function slackInputs(rows: WatcherConversation[], day: string): ObserveInput[] {
  return rows
    .filter(row => row.isPerson === true && row.sender.trim() && !isSelfName(row.sender))
    .map(row => ({
      text: row.sender.trim(),
      source: 'slack' as const,
      workspaceId: null,
      ...(row.senderHandle ? { handle: { kind: 'slack' as const, value: row.senderHandle } } : {}),
      ref: `slack-web|${row.externalId}|${day}`,
      context: 'sent you a message on Slack',
    }));
}

/** Learns from what a watcher read; never throws. */
export async function learnFromWatcher(source: string, rows: WatcherConversation[]): Promise<void> {
  try {
    const inputs =
      source === 'gmail-web'
        ? gmailInputs(rows, await ownerEmails())
        : source === 'slack-web'
          ? slackInputs(rows, localDay())
          : [];
    if (inputs.length) await people.observeAll(inputs);
  } catch (error) {
    logger.warning('Could not learn names from the Inbox', error);
  }
}

/** A WhatsApp chat the owner read or drafted into: its name, or its number when it has no saved name. */
export function whatsappInput(
  chat: string,
  workspaceId: string | null,
  ref: string,
  context: string,
): ObserveInput | null {
  const text = chat.trim();
  if (!text || isSelfName(text)) return null;
  const phone = looksLikePhone(text) ? text : null;
  return {
    text,
    source: 'whatsapp',
    workspaceId,
    phone,
    ...(phone ? { handle: { kind: 'whatsapp', value: phone } } : {}),
    ref,
    context,
  };
}

export async function learnFromWhatsapp(
  chat: string,
  workspaceId: string | null,
  kind: 'read' | 'draft',
): Promise<void> {
  const input = whatsappInput(
    chat,
    workspaceId,
    `whatsapp|${chat.trim().toLowerCase()}|${localDay()}`,
    kind === 'draft' ? 'you wrote to them on WhatsApp' : 'you read their WhatsApp chat',
  );
  if (input) await people.observe(input).catch(error => logger.warning('Could not learn a WhatsApp name', error));
}

// Keys under which GitHub results name people
const GITHUB_PEOPLE_KEYS = new Set([
  'user',
  'author',
  'assignee',
  'assignees',
  'requested_reviewers',
  'reviewers',
  'merged_by',
  'closed_by',
  'owner',
  'sender',
  'committer',
]);

/**
 * The people a GitHub connector result names: the login of each author, assignee and reviewer, with the issue or
 * pull request it was on. Bots are left out. A result cut short is read as far as it goes.
 */
export function githubPeople(text: string): { login: string; name: string | null; ref: string | null }[] {
  const found = new Map<string, { login: string; name: string | null; ref: string | null }>();
  const add = (login: unknown, name: unknown, ref: string | null, type: unknown) => {
    if (typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login) || type === 'Bot' || /\[bot\]$/.test(login))
      return;
    const key = login.toLowerCase();
    if (!found.has(key))
      found.set(key, { login, name: typeof name === 'string' && name.trim() ? name.trim() : null, ref });
  };
  const walk = (value: unknown, key: string | null, ref: string | null, depth: number) => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, ref, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const here = typeof record.html_url === 'string' && typeof record.number === 'number' ? record.html_url : ref;
    if (key && GITHUB_PEOPLE_KEYS.has(key)) add(record.login, record.name, here, record.type);
    for (const [child, inner] of Object.entries(record)) walk(inner, child, here, depth + 1);
  };
  try {
    walk(JSON.parse(text), null, null, 0);
  } catch {
    // Cut short or not JSON: the logins that are there
    for (const match of text.matchAll(
      /"(user|author|assignee|merged_by|owner)"\s*:\s*\{[^{}]*?"login"\s*:\s*"([^"]+)"/g,
    )) {
      add(match[2], null, null, null);
    }
  }
  return [...found.values()];
}

/** Learns from a GitHub connector's answer, in the chat's workspace; the owner's own login is left out. */
export async function learnFromGithub(text: string, workspaceId: string | null): Promise<void> {
  try {
    const workspaces = await workspaceStore.list().catch(() => []);
    const own = new Set(
      workspaces.map(workspace => workspace.accounts.github?.replace(/^@/, '').toLowerCase()).filter(Boolean),
    );
    const inputs: ObserveInput[] = githubPeople(text)
      .filter(person => !own.has(person.login.toLowerCase()))
      .slice(0, 30)
      .map(person => ({
        text: person.name ?? person.login,
        source: 'github',
        workspaceId,
        handle: { kind: 'github', value: person.login },
        ...(person.ref ? { ref: `github|${person.ref}` } : {}),
        context: 'on an issue or pull request on GitHub',
      }));
    if (inputs.length) await people.observeAll(inputs);
  } catch (error) {
    logger.warning('Could not learn names from GitHub', error);
  }
}

const GRAPH_SOURCES: Partial<Record<KnowledgeItem['sourceType'], PersonSource>> = {
  thread: 'chat',
  'ai-session': 'chat',
  note: 'note',
  page: 'note',
};

/**
 * The knowledge graph's person readings of a chat, note or page. A meeting's are learned from the call itself
 * (./meet.ts). Each person node gets its person's id once one is known.
 */
export async function learnFromReading(item: KnowledgeItem, names: string[]): Promise<void> {
  const source = GRAPH_SOURCES[item.sourceType];
  if (!source || names.length === 0) return;
  const workspaceId = item.workspaceId ?? null;
  for (const name of names.slice(0, 20)) {
    if (isSelfName(name) || isNobody(name)) continue;
    const result = await people
      .observe({
        text: name,
        source,
        workspaceId,
        ref: `kb|${item.id}`,
        context: source === 'chat' ? 'was named in a chat' : 'was named in a note',
      })
      .catch(() => null);
    if (result?.kind === 'person') {
      await db.graphNodes.update(entityId('person', workspaceId, name), { personId: result.personId }).catch(() => 0);
    }
  }
}

/**
 * The owners of a chat's or note's actions that went on the task board, each with its task: a known name links
 * the task to its person, an unknown one is asked about. A meeting's are learned from its note (./meet.ts).
 */
export function taskOwnerInputs(
  item: Pick<KnowledgeItem, 'id' | 'sourceType' | 'workspaceId'>,
  slice: Pick<GraphSlice, 'entities' | 'edges'>,
): ObserveInput[] {
  if (!GRAPH_SOURCES[item.sourceType]) return [];
  const inputs: ObserveInput[] = [];
  for (const action of slice.entities) {
    if (action.type !== 'action' || !action.taskId) continue;
    const edge = slice.edges.find(other => other.from === action.id && other.kind === 'assigned_to');
    const owner = (edge && slice.entities.find(entity => entity.id === edge.to)?.label) || '';
    if (!owner || isSelfName(owner) || isNobody(owner)) continue;
    inputs.push({
      text: owner,
      source: 'task',
      workspaceId: action.workspaceId ?? item.workspaceId ?? null,
      taskId: action.taskId,
      ref: `kb|${item.id}`,
      context: 'was given a task in a chat or note',
    });
  }
  return inputs.slice(0, 30);
}

export async function learnTaskOwners(item: KnowledgeItem, slice: GraphSlice): Promise<void> {
  const inputs = taskOwnerInputs(item, slice);
  if (inputs.length) await people.observeAll(inputs);
}
