import { teamStore } from '@extension/storage';
import type { LedgerEntry, ProductProfile, TeamItem, TeamStore } from '@extension/storage';

/**
 * The ledger: the marketing budget and the beta places given (docs/growth-team.md, Part 9). Code holds both.
 * An agent cannot pay and cannot give a place past the rule: it asks, and what the user agrees to is written
 * here, each line checked against the limit in the same transaction that writes it.
 *
 * The rules are plain functions of the lines so far, so every one of them is tested without a database.
 */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type BetaRule = NonNullable<ProductProfile['betaRule']>;

/** What the product itself says about grants, when it could be asked (Suture's `GET /`): it is the truth. */
export interface RemoteGrants {
  remaining: number;
}

/** Beta places given in the 7 days before `now`: a rolling week, the way the product counts it. */
export function grantsInWeek(entries: readonly LedgerEntry[], now: number): number {
  return entries.filter(entry => entry.kind === 'beta_grant' && entry.at > now - WEEK_MS && entry.at <= now).length;
}

/**
 * Why a beta place may not be given now, or null when it may.
 *
 * @param ask - What the grant would give, when it says: a plan or a length other than the rule's is outside it
 */
export function grantRefusal(
  rule: BetaRule | null,
  entries: readonly LedgerEntry[],
  now: number,
  remote: RemoteGrants | null = null,
  ask: { plan?: string; days?: number } = {},
): string | null {
  if (!rule) return 'No beta rule is set for this product, so no place can be given without the user deciding it.';
  if (ask.plan && ask.plan.trim().toLowerCase() !== rule.plan.trim().toLowerCase()) {
    return `The beta rule gives the ${rule.plan} plan only: ${ask.plan} is outside it and needs the user's own decision.`;
  }
  if (ask.days !== undefined && ask.days > rule.days) {
    return `The beta rule gives ${rule.days} days: ${ask.days} days is outside it and needs the user's own decision.`;
  }
  const used = grantsInWeek(entries, now);
  if (used >= rule.testersPerWeek) {
    return `The beta rule allows ${rule.testersPerWeek} testers a week and ${used} were given in the last 7 days. The next place opens when the oldest of them is a week old.`;
  }
  if (remote && remote.remaining <= 0) {
    return 'The product itself says no beta places are left this week.';
  }
  return null;
}

export interface BudgetState {
  totalUsd: number;
  spentUsd: number;
  leftUsd: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** The marketing budget as it stands: what the profile says was spent before, plus every line agreed since. */
export function budgetState(budget: ProductProfile['budget'], entries: readonly LedgerEntry[]): BudgetState | null {
  if (!budget) return null;
  const agreed = entries.filter(entry => entry.kind === 'spend').reduce((sum, entry) => sum + entry.amount, 0);
  const spentUsd = cents(budget.spentUsd + agreed);
  return { totalUsd: budget.totalUsd, spentUsd, leftUsd: cents(Math.max(0, budget.totalUsd - spentUsd)) };
}

/** Why an amount may not be asked for or agreed, or null when it fits what is left. */
export function spendRefusal(
  budget: ProductProfile['budget'],
  entries: readonly LedgerEntry[],
  amountUsd: number,
): string | null {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 'A spending request needs an amount above zero.';
  const state = budgetState(budget, entries);
  if (!state) return 'No marketing budget is set for this product, so there is nothing to spend from.';
  if (amountUsd > state.leftUsd) {
    return `Only $${state.leftUsd.toFixed(2)} of the $${state.totalUsd.toFixed(2)} budget is left: $${cents(amountUsd).toFixed(2)} does not fit.`;
  }
  return null;
}

type Recorded = { ok: true; entry: LedgerEntry } | { ok: false; why: string };

/**
 * Writes down a beta place the user agreed to (or allowed every time), unless the rule says no. The check and
 * the write are one transaction: two grants landing together cannot both take the last place.
 */
export function recordGrant(
  item: Pick<TeamItem, 'id' | 'workspaceId' | 'title'>,
  rule: BetaRule | null,
  now: number,
  remote: RemoteGrants | null = null,
  store: TeamStore = teamStore,
): Promise<Recorded> {
  return store.record(
    {
      id: crypto.randomUUID(),
      workspaceId: item.workspaceId,
      kind: 'beta_grant',
      amount: 1,
      label: item.title,
      itemId: item.id,
      at: now,
    },
    entries => grantRefusal(rule, entries, now, remote),
  );
}

/** Writes down money the user agreed to spend, unless it no longer fits the budget. */
export function recordSpend(
  item: Pick<TeamItem, 'id' | 'workspaceId' | 'title' | 'amountUsd'>,
  budget: ProductProfile['budget'],
  now: number,
  store: TeamStore = teamStore,
): Promise<Recorded> {
  const amount = cents(item.amountUsd ?? 0);
  return store.record(
    {
      id: crypto.randomUUID(),
      workspaceId: item.workspaceId,
      kind: 'spend',
      amount,
      label: item.title,
      itemId: item.id,
      at: now,
    },
    entries => spendRefusal(budget, entries, amount),
  );
}

/** One line on the budget and the beta places, for an agent and for the workspace screen. */
export function ledgerLines(
  profile: Pick<ProductProfile, 'budget' | 'betaRule'>,
  entries: readonly LedgerEntry[],
  now: number,
): { budget: string; beta: string } {
  const state = budgetState(profile.budget, entries);
  const used = grantsInWeek(entries, now);
  return {
    budget: state
      ? `$${state.spentUsd.toFixed(2)} of $${state.totalUsd.toFixed(2)} spent, $${state.leftUsd.toFixed(2)} left`
      : 'not set',
    beta: profile.betaRule
      ? `${used} of ${profile.betaRule.testersPerWeek} places given in the last 7 days (${profile.betaRule.plan}, ${profile.betaRule.days} days each)`
      : 'not set',
  };
}
