import { TEAM_RULE_ACTIONS } from '@extension/storage';
import type { TeamAction, TeamMode } from '@extension/storage';

/**
 * Which approval mode each kind of growth work gets (docs/growth-team.md, Part 9). Plain code: the agent's
 * prompt names these rules so it does not try, but it cannot change them.
 *
 * | Mode | For |
 * |---|---|
 * | always asked, one by one | spending, a new channel, a new account, a plan change outside the beta rule, a tool to connect, and anything that names a customer |
 * | approve the batch | posts, replies, outreach email, follow-ups, listings |
 * | auto inside a hard limit | issues labelled `from-customer`, beta access inside the beta rule: only after the user picked "Allow every time" for that kind |
 */

export const BATCH_ACTIONS: readonly TeamAction[] = ['post', 'reply', 'outreach_email', 'follow_up', 'listing'];
export const ALWAYS_ASK_ACTIONS: readonly TeamAction[] = ['spend', 'new_channel', 'new_account', 'plan_change', 'tool'];

// Hard limits that hold whatever was allowed. A request past one is refused by code and says so.
export const TEAM_LIMITS = {
  // Items one agent may leave waiting for the user in a day: past this the Inbox is no longer readable
  queuedPerAgentPerDay: 20,
  // Issues filed from customer feedback in a day, for one product
  customerIssuesPerDay: 10,
} as const;

export interface ModeFacts {
  // The text names a customer (found by code, see ./privacy)
  namesCustomer: boolean;
  // The user allowed this kind of work every time, for this agent and product (a rule in permissionRules)
  hasRule: boolean;
}

/** The mode an item gets. Naming a customer beats everything: such an item is asked on its own. */
export function modeFor(action: TeamAction, facts: ModeFacts): TeamMode {
  if (facts.namesCustomer) return 'always_ask';
  if (ALWAYS_ASK_ACTIONS.includes(action)) return 'always_ask';
  if (BATCH_ACTIONS.includes(action)) return 'batch';
  // What is left may run by itself, but only once the user said so
  return facts.hasRule && TEAM_RULE_ACTIONS.includes(action) ? 'auto' : 'always_ask';
}

/**
 * Whether the request for an item may offer "Allow every time". Never for one that names a customer, nor for one
 * proposed by a chat that read content from outside.
 */
export function offersAlways(action: TeamAction, namesCustomer: boolean, tainted = false): boolean {
  return !namesCustomer && !tainted && TEAM_RULE_ACTIONS.includes(action);
}
