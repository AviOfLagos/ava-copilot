import type { Workspace } from '../workspaces';

/**
 * The facts about the product a workspace sells (docs/growth-team.md, Part 6). One product per workspace. This is
 * the only place an agent takes product facts from: what is not here, it does not know.
 *
 * A field the user has not filled in is empty ('' / [] / null) and is shown as "not set", in the panel and to the
 * agent alike. Nothing here is ever guessed.
 */

export type ProductStage = 'beta' | 'live';
export type ProductNotify = 'whatsapp' | 'slack' | 'both';
export type SocialPlatform = 'x' | 'linkedin' | 'youtube' | 'instagram' | 'reddit';
export const SOCIAL_PLATFORMS: SocialPlatform[] = ['x', 'linkedin', 'youtube', 'instagram', 'reddit'];

// A Slack channel where the product's notifications land: its name as people say it, and its id when known (the
// Slack connector reads a channel by id; in the browser it is found by name)
export interface SlackChannelRef {
  name: string;
  id: string;
}

// 'suture-agent-v1': the read calls of the Suture agent API (`<admin console>/api/agent/v1`, a bearer token)
export interface ProductAgentApi {
  kind: 'suture-agent-v1';
  baseUrl: string;
}

/** Where a product's API token is kept in the vault. */
export const productApiTokenRef = (workspaceId: string) => `product-api:${workspaceId}`;

export interface ProductProfile {
  workspaceId: string;
  name: string;
  url: string;
  oneLiner: string;
  // Who it is for, most valuable first
  audience: string[];
  // What hurts without it
  problem: string;
  // What people use instead
  alternatives: string[];
  // Why this one, each one provable
  differentiators: string[];
  // Exactly as on the site, or "free during beta"
  pricing: string;
  // null until the user says which
  stage: ProductStage | null;
  // owner/name, where issues go
  repo: string;
  // The admin console, and the login that may use it
  superAdmin: { url: string; account: string } | null;
  slackChannels: SlackChannelRef[];
  // The product's own API that reports its numbers (sign-ups, waitlist, feedback…), read by plain code on a
  // schedule. Its token is never here: it is in the vault, under `productApiTokenRef(workspaceId)`.
  agentApi: ProductAgentApi | null;
  // account = the login the account check (#43) looks for
  social: Partial<Record<SocialPlatform, { handle: string; account: string }>>;
  // The address outreach comes from
  email: { from: string; replyTo: string; via: 'nexmail' } | null;
  // The postal address in the footer of outreach email
  postalAddress: string;
  // Where the user hears about it; null until they choose
  notify: ProductNotify | null;
  northStar: { metric: string; weeklyTarget: number } | null;
  // The marketing budget; model spend is tracked apart from it
  budget: { totalUsd: number; spentUsd: number } | null;
  betaRule: { testersPerWeek: number; days: number; plan: string } | null;
  // Claims and places that are off limits
  never: string[];
  updatedAt: number;
}

/** A profile with nothing in it yet, for a workspace. */
export function emptyProductProfile(workspace: Pick<Workspace, 'id' | 'name'>): ProductProfile {
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    url: '',
    oneLiner: '',
    audience: [],
    problem: '',
    alternatives: [],
    differentiators: [],
    pricing: '',
    stage: null,
    repo: '',
    superAdmin: null,
    slackChannels: [],
    agentApi: null,
    social: {},
    email: null,
    postalAddress: '',
    notify: null,
    northStar: null,
    budget: null,
    betaRule: null,
    never: [],
    updatedAt: 0,
  };
}

const TEXT = 600;
const LINE = 200;
const LIST = 12;

// One line each: a value with line breaks could pass itself off as more lines of the profile ("Pricing: free")
// in what agents are told
const text = (value: unknown, max = TEXT): string =>
  typeof value === 'string'
    ? value
        .replace(/\s*[\r\n]+\s*/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const list = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map(item => text(item, LINE)).filter(Boolean))].slice(0, LIST) : [];
const amount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * A profile as it is stored: every text trimmed and cut to size, every list without blanks or repeats, and every
 * half-filled part (a north star with no number, a beta rule with no plan) set back to "not set" rather than kept
 * with a made-up value. Whatever wrote it (the panel, Ava's confirmed change), this is the one shape that is kept.
 */
export function cleanProductProfile(profile: ProductProfile): ProductProfile {
  const superAdminUrl = text(profile.superAdmin?.url, LINE);
  const from = text(profile.email?.from, LINE);
  const apiBase = text(profile.agentApi?.baseUrl, 300);
  const metric = text(profile.northStar?.metric, LINE);
  const weeklyTarget = amount(profile.northStar?.weeklyTarget);
  const total = amount(profile.budget?.totalUsd);
  const testers = amount(profile.betaRule?.testersPerWeek);
  const days = amount(profile.betaRule?.days);
  const plan = text(profile.betaRule?.plan, 40);
  const social: ProductProfile['social'] = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const handle = text(profile.social?.[platform]?.handle, LINE);
    if (handle) social[platform] = { handle, account: text(profile.social?.[platform]?.account, LINE) };
  }
  return {
    workspaceId: profile.workspaceId,
    name: text(profile.name, 80),
    url: text(profile.url, LINE),
    oneLiner: text(profile.oneLiner, 300),
    audience: list(profile.audience),
    problem: text(profile.problem),
    alternatives: list(profile.alternatives),
    differentiators: list(profile.differentiators),
    pricing: text(profile.pricing),
    stage: profile.stage === 'live' || profile.stage === 'beta' ? profile.stage : null,
    repo: text(profile.repo, 120),
    superAdmin: superAdminUrl ? { url: superAdminUrl, account: text(profile.superAdmin?.account, LINE) } : null,
    slackChannels: (Array.isArray(profile.slackChannels) ? profile.slackChannels : [])
      .map(channel => ({ name: text(channel?.name, 80), id: text(channel?.id, 40) }))
      .filter(channel => channel.name || channel.id)
      .slice(0, LIST),
    agentApi: apiBase ? { kind: 'suture-agent-v1', baseUrl: apiBase } : null,
    social,
    email: from ? { from, replyTo: text(profile.email?.replyTo, LINE), via: 'nexmail' } : null,
    postalAddress: text(profile.postalAddress, 300),
    notify:
      profile.notify === 'whatsapp' || profile.notify === 'slack' || profile.notify === 'both' ? profile.notify : null,
    northStar: metric && weeklyTarget ? { metric, weeklyTarget } : null,
    budget: total !== null ? { totalUsd: total, spentUsd: amount(profile.budget?.spentUsd) ?? 0 } : null,
    // A rule needs all three: a count of 0 or a missing plan is no rule, not a rule of nothing
    betaRule: testers && days && plan ? { testersPerWeek: testers, days, plan } : null,
    never: list(profile.never),
    updatedAt: profile.updatedAt,
  };
}

/** Whether a profile says anything at all beyond the workspace's own name. */
export function isEmptyProfile(profile: ProductProfile): boolean {
  const blank = emptyProductProfile({ id: profile.workspaceId, name: profile.name });
  return JSON.stringify({ ...cleanProductProfile(profile), updatedAt: 0 }) === JSON.stringify(blank);
}
