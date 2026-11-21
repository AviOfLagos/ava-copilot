import { t } from '@extension/i18n';
import { db, permissionRulesStore, productStore, teamItemId, teamScope, teamStore } from '@extension/storage';
import type { InboxItem, ProductProfile, TeamAction, TeamItem } from '@extension/storage';
import { addInboxItem, inboxItemId } from '../inbox/store';
import { createLogger } from '../log';
import { digest } from '../once';
import { localDay } from '../rounds/plan';
import { grantAsk, grantRefusal, recordGrant, recordSpend, remoteLeft, spendRefusal } from './ledger';
import type { BetaRule, RemoteGrants } from './ledger';
import { modeFor, offersAlways, TEAM_LIMITS } from './modes';
import { personaRefusal } from './persona';
import { findCustomerDetails, findingsText } from './privacy';

/**
 * What a growth agent wants to do in the world goes through here, and only here (docs/growth-team.md, Part 9).
 * `propose` decides in code how the item reaches the user's click:
 *
 * - always asked: its own request in the Inbox;
 * - a batch: the agent's drafts of the day, approved with one tap or one by one;
 * - auto, inside a hard limit: only a kind the user allowed every time, and it is reported after.
 *
 * An item is written down before anything happens, under a do-once key, so the same thing proposed twice is one
 * item and an approved item is carried out once. Nothing here posts or sends by itself: an approved item with
 * nothing registered to carry it out is held, and says so.
 */

const logger = createLogger('GrowthTeam');

export const ITEM_PREFIX = 'team-item:';
export const BATCH_PREFIX = 'team-batch:';

export interface Proposal {
  workspaceId: string;
  agentId: string | null;
  agentName: string;
  action: TeamAction;
  title: string;
  body: string;
  target: string;
  why: string;
  // What makes this the same thing if it is proposed again (a feedback id, a contact). Default: the text itself.
  onceKey?: string;
  // Names and companies from the customer's own record, looked for in the text
  customerNames?: string[];
  // The agent said it names a customer: a hint, never the only check
  declaredNamesCustomer?: boolean;
  // Links that may carry an id (the admin console's page for a feedback item)
  allowedLinks?: string[];
  amountUsd?: number;
  fields?: Record<string, string>;
}

export type ProposeResult =
  // Waits for the user's click
  | { state: 'queued'; item: TeamItem }
  // Ran by itself inside its limit (allowed every time), and how it ended
  | { state: 'ran'; item: TeamItem }
  // The same thing was proposed before: here is what became of it
  | { state: 'exists'; item: TeamItem }
  // Code said no, and why
  | { state: 'refused'; why: string };

/** Carries out one kind of approved work. Throwing, or `ok: false`, leaves the item failed with the reason. */
export type TeamExecutor = (
  item: TeamItem,
) => Promise<{ ok: true; note: string; link?: string } | { ok: false; why: string }>;

const executors = new Map<TeamAction, TeamExecutor>();

/**
 * Registers what carries out an approved item of one kind. Without one, an approved item is held.
 *
 * An executor sends, posts or grants in the world, so it must pass `reviewAction` (`src/background/gate/review.ts`)
 * before it does, like every other commit action: the user's yes here does not replace the gate.
 */
export function registerTeamExecutor(action: TeamAction, executor: TeamExecutor): void {
  executors.set(action, executor);
}

export function clearTeamExecutorsForTests(): void {
  executors.clear();
}

export interface QueueDeps {
  now?: () => number;
  // What the product itself says about beta places (its rule, and what is left this week), when it can be asked
  remoteGrants?: (profile: ProductProfile) => Promise<(RemoteGrants & { rule?: BetaRule | null }) | null>;
}

const startOfLocalDay = (at: number) => {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const clean = (text: string, max: number) => text.replace(/\s+\n/g, '\n').trim().slice(0, max);
const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

const actionName = (action: TeamAction): string => {
  switch (action) {
    case 'post':
      return t('team_action_post');
    case 'reply':
      return t('team_action_reply');
    case 'outreach_email':
      return t('team_action_outreach');
    case 'follow_up':
      return t('team_action_followUp');
    case 'listing':
      return t('team_action_listing');
    case 'customer_issue':
      return t('team_action_issue');
    case 'beta_grant':
      return t('team_action_beta');
    case 'spend':
      return t('team_action_spend');
    case 'new_channel':
      return t('team_action_channel');
    case 'new_account':
      return t('team_action_account');
    case 'plan_change':
      return t('team_action_plan');
    default:
      return t('team_action_tool');
  }
};

const itemRequestId = (item: Pick<TeamItem, 'id'>) => `${ITEM_PREFIX}${item.id}`;
// The batch row keeps one Inbox id; its answer carries a fingerprint of the items it showed, so a tap approves
// what the user saw and not a draft that arrived after the row was drawn
const batchRowId = (batchId: string) => `${BATCH_PREFIX}${batchId}`;
const SNAPSHOT_MARK = '|';
const batchSnapshot = (items: readonly Pick<TeamItem, 'id'>[]) => digest(items.map(item => item.id).sort());

// Work other people read: a customer's details in it are refused, not only flagged (Part 8, "Privacy")
const PUBLIC_ACTIONS: ReadonlySet<TeamAction> = new Set(['post', 'reply', 'listing', 'customer_issue']);
const EMAIL_ACTIONS: ReadonlySet<TeamAction> = new Set(['outreach_email', 'follow_up']);

function itemBody(item: TeamItem): string {
  const lines = [item.body];
  if (item.action === 'spend') {
    lines.push(
      '',
      `${t('team_spend_amount')}: $${(item.amountUsd ?? 0).toFixed(2)}`,
      `${t('team_spend_buys')}: ${item.fields?.buys ?? ''}`,
      `${t('team_spend_triedFree')}: ${item.fields?.triedFree ?? ''}`,
      `${t('team_spend_expected')}: ${item.fields?.expected ?? ''}`,
    );
  } else if (item.fields) {
    for (const [label, value] of Object.entries(item.fields)) if (value) lines.push(`${label}: ${value}`);
  }
  if (item.target) lines.push('', `${t('team_item_where')}: ${item.target}`);
  if (item.why) lines.push(`${t('team_item_why')}: ${item.why}`);
  if (item.namesCustomer) lines.push('', t('team_item_namesCustomer'));
  if (item.note) lines.push(item.note);
  return lines.join('\n').trim();
}

async function askForItem(item: TeamItem): Promise<void> {
  await addInboxItem({
    source: 'system',
    externalId: itemRequestId(item),
    kind: 'approval',
    title: t('team_item_title', [item.agentName, actionName(item.action), item.title]),
    body: itemBody(item),
    priority: item.mode === 'always_ask' ? 'high' : 'normal',
    workspaceId: item.workspaceId,
    agentId: item.agentId,
    approval: {
      requestId: itemRequestId(item),
      action: 'team_item',
      ...(offersAlways(item.action, item.namesCustomer) ? { always: true } : {}),
    },
  });
}

const closeInbox = (requestId: string) =>
  db.inbox.update(inboxItemId('system', requestId), { status: 'done', updatedAt: Date.now() }).catch(() => 0);

/**
 * The one row that approves a whole batch: there while two or more of its items wait, with their titles, and
 * closed when fewer do (one item left is answered on its own row).
 */
async function refreshBatch(batchId: string, sample: Pick<TeamItem, 'workspaceId' | 'agentId' | 'agentName'>) {
  const waiting = (await teamStore.inBatch(batchId)).filter(item => item.status === 'queued');
  const externalId = batchRowId(batchId);
  const id = inboxItemId('system', externalId);
  if (waiting.length < 2) {
    await closeInbox(externalId);
    return;
  }
  const requestId = `${externalId}${SNAPSHOT_MARK}${await batchSnapshot(waiting)}`;
  const now = Date.now();
  const existing = await db.inbox.get(id);
  const row: InboxItem = {
    id,
    source: 'system',
    externalId,
    kind: 'approval',
    title: t('team_batch_title', [String(waiting.length), sample.agentName]),
    body: [
      t('team_batch_body'),
      '',
      ...waiting
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((item, index) => `${index + 1}. ${actionName(item.action)}: ${item.title}`),
    ].join('\n'),
    links: [],
    priority: 'normal',
    // A batch the user already answered and that filled up again is new to them
    status: existing && existing.status !== 'done' ? existing.status : 'unread',
    snoozeUntil: existing?.snoozeUntil ?? null,
    workspaceId: sample.workspaceId,
    agentId: sample.agentId,
    runId: null,
    approval: { requestId, action: 'team_batch' },
    digestCount: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.inbox.put(row);
}

/** Tells the user what an item that ran by itself did: reported after, once. */
async function reportAfter(item: TeamItem): Promise<void> {
  await addInboxItem({
    source: 'system',
    externalId: `team-done:${item.id}`,
    kind: item.status === 'done' || item.status === 'held' ? 'result' : 'alert',
    title: t(
      item.status === 'done' ? 'team_auto_done' : item.status === 'held' ? 'team_auto_held' : 'team_auto_failed',
      [item.agentName, item.title],
    ),
    body: [item.note, item.link ?? ''].filter(Boolean).join('\n'),
    links: item.link ? [{ label: item.title.slice(0, 60), url: item.link }] : [],
    priority: item.status === 'done' || item.status === 'held' ? 'low' : 'normal',
    workspaceId: item.workspaceId,
    agentId: item.agentId,
  }).catch(error => logger.warning('Could not report what ran', error));
}

/**
 * Carries out an item the user agreed to (or allowed every time). The ledger is written first, inside its limit:
 * a grant past the beta rule, or a spend past the budget, stops here even after a yes.
 */
async function carryOut(item: TeamItem, deps: QueueDeps): Promise<TeamItem> {
  const now = deps.now?.() ?? Date.now();
  const finish = async (changes: Partial<TeamItem>) =>
    (await teamStore.update(item.id, { ...changes, doneAt: now })) ?? { ...item, ...changes };
  const profile = await productStore.forWorkspace(item.workspaceId);

  if (item.action === 'beta_grant') {
    const remote = profile && deps.remoteGrants ? await deps.remoteGrants(profile).catch(() => null) : null;
    // Read before the ledger is: a grant the product already counts is done here first
    // The rule typed into the profile, else the one the product enforces: never one made up here
    const recorded = await recordGrant(item, profile?.betaRule ?? remote?.rule ?? null, now, remote);
    if (!recorded.ok) return finish({ status: 'refused', note: recorded.why });
  }
  if (item.action === 'spend') {
    const recorded = await recordSpend(item, profile?.budget ?? null, now);
    if (!recorded.ok) return finish({ status: 'refused', note: recorded.why });
    // Paying is the user's own act: the ledger now counts it, and nothing else happens
    return finish({ status: 'done', note: t('team_note_spendAgreed', [`$${(item.amountUsd ?? 0).toFixed(2)}`]) });
  }
  // A request to the user (a tool to connect, an account or a channel to open, a plan change): the yes is the
  // answer, and the steps are theirs
  if (
    item.action === 'tool' ||
    item.action === 'new_account' ||
    item.action === 'new_channel' ||
    item.action === 'plan_change'
  ) {
    return finish({ status: 'done', note: t('team_note_yours') });
  }

  const executor = executors.get(item.action);
  if (!executor) {
    // Nothing can carry it out yet: it is kept as approved, and nothing goes out
    return (await teamStore.update(item.id, { status: 'held', note: t('team_note_held') })) ?? item;
  }
  try {
    const result = await executor(item);
    return result.ok
      ? finish({ status: 'done', note: result.note, ...(result.link ? { link: result.link } : {}) })
      : finish({ status: 'failed', note: result.why });
  } catch (error) {
    // A step that broke part of the way is never tried again by itself: it may have gone through
    logger.warning(`Carrying out a ${item.action} failed`, error);
    return finish({ status: 'failed', note: t('team_note_unknownOutcome') });
  }
}

/**
 * Proposes one piece of work. Returns what became of it at once: it waits for a click, it ran inside its limit,
 * it was already proposed, or code refused it.
 */
export async function propose(proposal: Proposal, deps: QueueDeps = {}): Promise<ProposeResult> {
  const now = deps.now?.() ?? Date.now();
  const profile = await productStore.forWorkspace(proposal.workspaceId);
  if (!profile)
    return { state: 'refused', why: 'This workspace has no product profile, so there is nothing to act for.' };

  const title = oneLine(proposal.title, 160);
  const body = clean(proposal.body, 6000);
  if (!title || !body) return { state: 'refused', why: 'A title and the text itself are both needed.' };

  // A personality is only inspired by a person: a draft never names them or speaks as them (Part 8)
  const asSomeoneElse = personaRefusal(proposal.action, title, body);
  if (asSomeoneElse) return { state: 'refused', why: asSomeoneElse };

  // The recipient of an email is in `target`, and it is no secret to them: only the text is looked at
  const ownAddresses = [profile.email?.from, profile.email?.replyTo].filter((value): value is string => Boolean(value));
  const findings = findCustomerDetails(`${title}\n${body}`, proposal.customerNames, proposal.allowedLinks).filter(
    finding =>
      !(
        finding.kind === 'email' && ownAddresses.some(address => address.toLowerCase() === finding.sample.toLowerCase())
      ),
  );
  if (findings.length && (PUBLIC_ACTIONS.has(proposal.action) || EMAIL_ACTIONS.has(proposal.action))) {
    return {
      state: 'refused',
      why: `The text holds ${findingsText(findings)}. A customer's details never go in a post, an issue or an email: take them out (link to the feedback in the admin console instead) and try again.`,
    };
  }
  const namesCustomer = findings.length > 0 || proposal.declaredNamesCustomer === true;

  // The same thing proposed again is the same item, whatever the limits say now
  const onceKey = proposal.onceKey?.trim() || (await digest([proposal.action, proposal.target, body]));
  const id = teamItemId(proposal.workspaceId, `${proposal.action}:${onceKey}`);
  const existing = await teamStore.get(id);
  if (existing) return { state: 'exists', item: existing };

  // The hard limits, before anything is written down
  const entries = await teamStore.ledger(proposal.workspaceId);
  if (proposal.action === 'spend') {
    const fields = proposal.fields ?? {};
    const missing = ['buys', 'triedFree', 'expected'].filter(name => !fields[name]?.trim());
    if (missing.length) {
      return {
        state: 'refused',
        why: `A spending request needs all four: the amount, what it buys, what was tried for free first, and the result expected. Missing: ${missing.join(', ')}.`,
      };
    }
    const why = spendRefusal(profile.budget, entries, proposal.amountUsd ?? 0);
    if (why) return { state: 'refused', why };
  }
  if (proposal.action === 'beta_grant') {
    const remote = deps.remoteGrants ? await deps.remoteGrants(profile).catch(() => null) : null;
    const done = new Set(
      (await teamStore.forWorkspace(proposal.workspaceId)).filter(item => item.status === 'done').map(item => item.id),
    );
    const why = grantRefusal(
      profile.betaRule ?? remote?.rule ?? null,
      entries,
      now,
      remoteLeft(remote, entries, done, now),
      grantAsk(proposal.fields),
    );
    if (why) return { state: 'refused', why };
  }
  const today = (await teamStore.since(proposal.workspaceId, startOfLocalDay(now))).filter(
    item => item.status !== 'refused',
  );
  if (proposal.action === 'customer_issue') {
    const filed = today.filter(item => item.action === 'customer_issue').length;
    if (filed >= TEAM_LIMITS.customerIssuesPerDay) {
      return {
        state: 'refused',
        why: `At most ${TEAM_LIMITS.customerIssuesPerDay} issues a day are filed from customer feedback, and that many were today. The rest wait for tomorrow.`,
      };
    }
  }

  const mine = today.filter(item => item.agentId === proposal.agentId);
  if (mine.length >= TEAM_LIMITS.queuedPerAgentPerDay) {
    return {
      state: 'refused',
      why: `At most ${TEAM_LIMITS.queuedPerAgentPerDay} items a day go to the user from one agent, and that many did today. Keep the best for tomorrow.`,
    };
  }

  const scope = teamScope(proposal.workspaceId, proposal.agentId, proposal.action);
  const rule = namesCustomer ? null : await permissionRulesStore.find('team', scope).catch(() => null);
  const mode = modeFor(proposal.action, { namesCustomer, hasRule: rule !== null });
  const draft: TeamItem = {
    id,
    workspaceId: proposal.workspaceId,
    agentId: proposal.agentId,
    agentName: oneLine(proposal.agentName, 60) || 'Ava',
    action: proposal.action,
    title,
    body,
    target: oneLine(proposal.target, 200),
    why: oneLine(proposal.why, 400),
    namesCustomer,
    mode,
    status: 'queued',
    note: namesCustomer && findings.length ? `Found in the text: ${findingsText(findings)}.` : '',
    batchId: mode === 'batch' ? `${proposal.workspaceId}:${proposal.agentId ?? 'ava'}:${localDay(now)}` : null,
    ...(proposal.amountUsd !== undefined ? { amountUsd: proposal.amountUsd } : {}),
    ...(proposal.fields ? { fields: proposal.fields } : {}),
    createdAt: now,
    decidedAt: null,
    doneAt: null,
  };
  const { item, added } = await teamStore.add(draft);
  if (!added) return { state: 'exists', item };

  if (mode === 'auto' && rule) {
    await permissionRulesStore.used(rule.id).catch(() => undefined);
    const claimed = await teamStore.decide(item.id, 'held', '', now);
    const done = await carryOut(claimed ?? item, deps);
    await reportAfter(done);
    return { state: 'ran', item: done };
  }

  await askForItem(item);
  if (item.batchId) await refreshBatch(item.batchId, item);
  return { state: 'queued', item };
}

/**
 * The user's answer to one item. A yes is carried out once: a second answer finds the item no longer waiting.
 * "Allow every time" saves a rule only for a kind that may have one, and never for an item that names a customer.
 */
export async function answerItem(
  itemId: string,
  approved: boolean,
  options: { always?: boolean } = {},
  deps: QueueDeps = {},
): Promise<TeamItem | null> {
  const now = deps.now?.() ?? Date.now();
  const claimed = await teamStore.decide(
    itemId,
    approved ? 'held' : 'declined',
    approved ? '' : t('team_note_declined'),
    now,
  );
  if (!claimed) return null;
  await closeInbox(itemRequestId(claimed));
  if (claimed.batchId) await refreshBatch(claimed.batchId, claimed);
  if (!approved) return claimed;

  if (options.always && offersAlways(claimed.action, claimed.namesCustomer)) {
    await permissionRulesStore
      .allow({
        kind: 'team',
        scope: teamScope(claimed.workspaceId, claimed.agentId, claimed.action),
        label: t('team_rule_label', [claimed.agentName, actionName(claimed.action)]),
      })
      .catch(error => logger.warning('Could not save the rule', error));
  }
  const done = await carryOut(claimed, deps);
  // A yes that a limit stopped after all (the budget or the beta places ran out meanwhile) is said, once
  if (done.status === 'refused') await reportAfter(done);
  return done;
}

/**
 * One tap for the whole batch: every item still waiting in it gets the same answer, if they are the items the row
 * showed. Null when the batch changed after it was drawn: the row has been redrawn, and nothing was answered.
 *
 * @param answer - What follows the prefix in the row's request id: the batch id and the fingerprint of its items
 */
export async function answerBatch(answer: string, approved: boolean, deps: QueueDeps = {}): Promise<TeamItem[] | null> {
  const mark = answer.lastIndexOf(SNAPSHOT_MARK);
  const batchId = mark >= 0 ? answer.slice(0, mark) : answer;
  const snapshot = mark >= 0 ? answer.slice(mark + 1) : '';
  const waiting = (await teamStore.inBatch(batchId)).filter(item => item.status === 'queued');
  if (!waiting.length) {
    await closeInbox(batchRowId(batchId));
    return [];
  }
  if (snapshot !== (await batchSnapshot(waiting))) return null;
  const answered: TeamItem[] = [];
  for (const item of waiting.sort((a, b) => a.createdAt - b.createdAt)) {
    const result = await answerItem(item.id, approved, {}, deps);
    if (result) answered.push(result);
  }
  await closeInbox(batchRowId(batchId));
  return answered;
}

/**
 * After the background stopped between a yes and the ledger line: a spend or a grant the user agreed to that is
 * held with no line is carried out again (the ledger writes one line per item, so this cannot count it twice).
 */
export async function recoverAgreed(deps: QueueDeps = {}): Promise<number> {
  const held = await db.teamItems.where('status').equals('held').toArray();
  let recovered = 0;
  for (const item of held) {
    if (item.action !== 'spend' && item.action !== 'beta_grant') continue;
    const lines = await teamStore.ledger(item.workspaceId);
    if (lines.some(line => line.itemId === item.id)) {
      // Counted already: a spend is then done; a grant waits, held, for what carries it out
      if (item.action === 'spend')
        await teamStore.update(item.id, { status: 'done', doneAt: deps.now?.() ?? Date.now() });
      continue;
    }
    const done = await carryOut(item, deps);
    if (done.status === 'refused') await reportAfter(done);
    recovered += 1;
  }
  return recovered;
}

/** What to tell the agent about an item, in words that keep it from trying another way. */
export function resultText(result: ProposeResult): string {
  if (result.state === 'refused') return `Refused by a rule in code: ${result.why} Do not try another way around it.`;
  const { item } = result;
  if (result.state === 'exists') {
    return `This was already proposed (${item.status}${item.note ? `: ${item.note}` : ''}). Nothing new was added; do not propose it again.`;
  }
  if (result.state === 'ran') {
    if (item.status === 'held') {
      return "Allowed by the user's rule and kept as approved. Nothing has gone out yet: that waits for the account check. Do not do it yourself.";
    }
    return item.status === 'done'
      ? `Done inside its limit, and the user was told: ${item.note}${item.link ? ` ${item.link}` : ''}`
      : `It did not go through (${item.status}): ${item.note}. Do not try it again; the user was told.`;
  }
  return item.mode === 'batch'
    ? 'Queued in the batch the user approves. Nothing has gone out and nothing will until they tap approve; do not send or post it yourself.'
    : 'Sent to the user as a request in the Inbox. It waits for their own click; go on with other work and do not do it yourself.';
}
