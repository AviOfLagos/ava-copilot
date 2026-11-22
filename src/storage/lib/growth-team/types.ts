/**
 * What the growth team may do in the world, and what it has asked for (docs/growth-team.md, Part 9).
 *
 * Every kind of work an agent can do outside its own notes is a `TeamAction`. Each one has an approval mode that
 * plain code decides (see `src/background/growth-team/modes.ts`): the agent's prompt never does. An item is
 * what an agent proposes: a draft post, an outreach email, a beta grant, a spending request. It is kept here from
 * the moment it is proposed, so nothing an agent wanted to do is ever lost or done twice.
 */

export const TEAM_ACTIONS = [
  // Queued and approved as a batch
  'post',
  'reply',
  'outreach_email',
  'follow_up',
  'listing',
  // May run by themselves inside a hard limit, once the user said "Allow every time"
  'customer_issue',
  'beta_grant',
  // Always asked, one by one, whatever was allowed before
  'spend',
  'new_channel',
  'new_account',
  'plan_change',
  // A tool the agent needs that the user must connect (free): asked, never done by the agent
  'tool',
] as const;
export type TeamAction = (typeof TEAM_ACTIONS)[number];

/** How an item reaches the user's click, decided by code. */
export type TeamMode =
  // Its own request in the Inbox, every time
  | 'always_ask'
  // Joins the agent's batch for the day: one tap approves the batch, or each item on its own
  | 'batch'
  // Runs inside its hard limit and is reported after, because the user allowed this kind every time
  | 'auto';

export type TeamItemStatus =
  // Waits for the user's click
  | 'queued'
  // The user said yes, and nothing can carry it out yet (posting and sending wait for the account check, #43)
  | 'held'
  // Carried out
  | 'done'
  | 'declined'
  // Code refused it: over a limit, or it broke a rule
  | 'refused'
  // It was tried and did not go through
  | 'failed';

export interface TeamItem {
  // `${workspaceId}|${onceKey}`: the same thing proposed twice is one item
  id: string;
  workspaceId: string;
  // The agent that proposed it; null when Ava did, in the user's own chat
  agentId: string | null;
  agentName: string;
  action: TeamAction;
  // One line the user reads in the Inbox
  title: string;
  // The draft itself, or what is asked for
  body: string;
  // Where it would go: "x", "linkedin", "AviOfLagos/suture", a listing site
  target: string;
  // Why this, in the agent's words: the experiment it belongs to, why this person is relevant
  why: string;
  // Set by code when the text names a customer: such an item is always asked on its own
  namesCustomer: boolean;
  // Proposed by a chat that read content from outside: no saved rule answered it and none is offered
  tainted?: boolean;
  mode: TeamMode;
  status: TeamItemStatus;
  // What happened to it, in plain words
  note: string;
  // The batch it waits in, for mode 'batch'
  batchId: string | null;
  // For 'spend': how much, and the three answers a spending request must carry
  amountUsd?: number;
  fields?: Record<string, string>;
  // A link to what came of it (the issue, the post)
  link?: string;
  createdAt: number;
  decidedAt: number | null;
  doneAt: number | null;
}

/** One line of the ledger: money the user agreed to spend, or a beta place given. Only code writes these. */
export interface LedgerEntry {
  id: string;
  workspaceId: string;
  kind: 'spend' | 'beta_grant';
  // US dollars for a spend; 1 for a grant
  amount: number;
  // What it was for, in one line
  label: string;
  // The item it came from: one item makes one entry
  itemId: string;
  at: number;
}

export const teamItemId = (workspaceId: string, onceKey: string): string => `${workspaceId}|${onceKey}`;

/** How the Growth Lead sorted one piece of customer feedback (docs/growth-team.md, Part 8). */
export const FEEDBACK_SORTS = ['bug', 'confusion', 'feature', 'billing', 'praise'] as const;
export type FeedbackSort = (typeof FEEDBACK_SORTS)[number];

export interface FeedbackRecord {
  // `${workspaceId}|${feedbackId}`: one feedback item is sorted once
  id: string;
  workspaceId: string;
  feedbackId: string;
  sort: FeedbackSort;
  // For a feature request: what is asked for, in a few plain words, so three asks for the same thing are counted
  topic: string;
  // P0–P3 for a bug, confusion or billing problem; '' otherwise
  priority: string;
  // The team item it became, if any (an issue waiting for approval)
  itemId: string | null;
  at: number;
}

export const feedbackRecordId = (workspaceId: string, feedbackId: string) => `${workspaceId}|${feedbackId}`;

/**
 * A person the Product Marketing Manager drafted outreach for (docs/growth-team.md, Parts 8 and 12): found through
 * a public, relevant source, recorded with why. One first email and at most one follow-up, then stop.
 */
export interface TeamContact {
  // `${workspaceId}|${canonical email}`
  id: string;
  workspaceId: string;
  email: string;
  // The public page where the person was found, and why they are relevant
  source: string;
  why: string;
  firstAt: number;
  followUps: number;
  lastAt: number;
  // The first email's item: a follow-up waits until the user said yes to it, and counts from then
  itemId: string | null;
}

/** An address in the one form it is kept and compared in: lower case, without a "+tag". */
export const canonicalEmail = (email: string): string => {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  return `${address.slice(0, at).replace(/\+.*$/, '')}${address.slice(at)}`;
};

export const teamContactId = (workspaceId: string, email: string) => `${workspaceId}|${canonicalEmail(email)}`;

/** An address no agent writes to again, for any product: a reply, an unsubscribe or a bounce. */
export interface SuppressedAddress {
  // lower case
  email: string;
  why: 'replied' | 'unsubscribed' | 'bounced' | 'asked';
  at: number;
}

/** A channel on the Product Marketing Manager's list, and its one-week test. */
export const CHANNEL_STATES = ['idea', 'testing', 'kept', 'dropped'] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];

export interface TeamChannel {
  // `${workspaceId}|${key}`; key is the channel as sign-ups name it (utm source), lower case
  id: string;
  workspaceId: string;
  key: string;
  // Who is there, in a few words
  reach: string;
  // What a week's test would cost, in US dollars (0 for free)
  costUsd: number;
  state: ChannelState;
  // The test week, as UTC days, when it was started
  testFrom: string | null;
  testTo: string | null;
  // The verdict in plain words, set by code after the week
  verdict: string;
  updatedAt: number;
}

export const teamChannelId = (workspaceId: string, key: string) => `${workspaceId}|${key.trim().toLowerCase()}`;
