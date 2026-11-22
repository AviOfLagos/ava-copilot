import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type { CommitKind } from './gateSettings';
import type { TeamAction } from '../growth-team/types';

/**
 * "Allow every time": the user approved a kind of action in a place once and said not to ask again. A rule
 * names the kind (send, publish, submit, or a connector tool) and the place (a site and its first path segment,
 * or a connector tool), never the exact content, so the same kind of step tomorrow runs without a card.
 * Rules are kept until the user removes them in Settings › Permissions.
 */

// Kinds that are always asked, whatever the user allowed before: money, deleting, and handing out access
export const ALWAYS_ASK_KINDS: readonly CommitKind[] = ['purchase', 'delete', 'permission'];

// 'team': a kind of work a growth agent does for a product (../growth-team), e.g. filing an issue from feedback
// 'workflow': a step of a saved routine that starts an agent, asked in the Inbox (see workflowScope)
export type RuleKind = CommitKind | 'tool' | 'team' | 'workflow';

/**
 * The growth team's kinds of work that may get a rule: only these two, and each still runs inside a hard limit
 * that code keeps (docs/growth-team.md, Part 9). Everything else a growth agent does is asked: spending, a new
 * channel, a new account and a plan change outside the beta rule one by one, always; posts, replies, outreach
 * and listings as a batch. Nothing here is the agent's to change.
 */
export const TEAM_RULE_ACTIONS: readonly TeamAction[] = ['customer_issue', 'beta_grant'];

/** The place a growth agent's rule covers: one product's workspace, one agent, one kind of work. */
export const teamScope = (workspaceId: string, agentId: string | null, action: TeamAction): string =>
  `team:${workspaceId}/${agentId ?? 'ava'}/${action}`;

/** The kind of work a team rule's scope names, or null when it is not a team scope. */
export function teamActionOf(scope: string): string | null {
  const match = /^team:[^/]+\/[^/]+\/([a-z_]+)$/.exec(scope);
  return match ? match[1]! : null;
}

/**
 * A routine step the user may allow every time: only one that starts an agent. The agent's own chat still asks
 * before it commits anything (a chat a routine started always asks), so the rule lets the run begin and nothing
 * else. Steps that call a connector tool, run code or join a meeting are asked each time: what they do is not
 * known here, and a tool may delete or pay.
 */
export const WORKFLOW_RULE_NODE_TYPES: readonly string[] = ['step.agent'];

/** The place a routine rule covers: that routine, that step, and the step as it is now (a hash of its settings). */
export const workflowScope = (workflowId: string, nodeId: string, hash: string): string =>
  `workflow:${workflowId}/${nodeId}@${hash.slice(0, 16)}`;

export interface PermissionRule {
  id: string;
  kind: RuleKind;
  // "docs.google.com/spreadsheets", "mail.google.com/mail", or "tool:<connectorId>/<tool>@<hash>"
  scope: string;
  // What the user saw when they allowed it, e.g. "Send on mail.google.com"
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  uses: number;
}

// What the gate proposes on a card: the rule that "Allow every time" would save
export interface RuleCandidate {
  kind: RuleKind;
  scope: string;
  label: string;
}

interface PermissionRulesState {
  rules: PermissionRule[];
}

const MAX_RULES = 200;

export type PermissionRulesStorage = BaseStorage<PermissionRulesState> & {
  list: () => Promise<PermissionRule[]>;
  find: (kind: RuleKind, scope: string) => Promise<PermissionRule | null>;
  allow: (candidate: RuleCandidate, now?: number) => Promise<PermissionRule | null>;
  used: (id: string, now?: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

/**
 * Whether a kind may get an "Allow every time" rule at all. A team rule also depends on what it is for: only the
 * kinds of work in TEAM_RULE_ACTIONS, so spending, a new channel, a new account and a plan change can never be
 * remembered, whoever asks.
 */
export const canAllowAlways = (kind: string, scope = ''): kind is RuleKind =>
  kind === 'team'
    ? (TEAM_RULE_ACTIONS as readonly string[]).includes(teamActionOf(scope) ?? '')
    : kind === 'workflow'
      ? scope.startsWith('workflow:')
      : kind === 'tool' || (['send', 'publish', 'submit'] as string[]).includes(kind);

// Hosts that serve other people's documents under one name: a rule there covers one document or account
// ("docs.google.com/forms/d/<id>", "mail.google.com/mail/u/0"), never every form anyone made
const DEEP_SCOPE_HOSTS: Record<string, number> = {
  'docs.google.com': 3,
  'mail.google.com': 3,
  'drive.google.com': 3,
  'forms.office.com': 3,
};

/**
 * The place a page action belongs to: its host and first path segment ("example.com/app"), or deeper on hosts
 * of shared documents. Only https pages get rules: the address must say where it really is. Empty when the
 * address cannot be read.
 */
export function pageScope(url: string): string {
  try {
    const { protocol, host, pathname } = new URL(url);
    if (protocol !== 'https:') return '';
    const name = host.toLowerCase();
    const segments = pathname
      .split('/')
      .filter(Boolean)
      .slice(0, DEEP_SCOPE_HOSTS[name] ?? 1);
    return [name, ...segments].join('/');
  } catch {
    return '';
  }
}

export const toolScope = (connectorId: string, tool: string, hash: string): string =>
  `tool:${connectorId}/${tool}@${hash.slice(0, 16)}`;

const storage = createStorage<PermissionRulesState>(
  'permission-rules',
  { rules: [] },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

// Use counts live apart from the rules: the background counts while Settings may remove a rule, and a count
// written back with the whole list could bring a removed rule back
type UseCounts = Record<string, { uses: number; lastUsedAt: number }>;
const useStorage = createStorage<UseCounts>(
  'permission-rule-uses',
  {},
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const permissionRulesStore: PermissionRulesStorage = {
  ...storage,
  async list() {
    const rules = (await storage.get())?.rules ?? [];
    const counts = (await useStorage.get()) ?? {};
    return rules.map(rule => (counts[rule.id] ? { ...rule, ...counts[rule.id] } : rule));
  },
  async find(kind, scope) {
    if (!scope || !canAllowAlways(kind, scope)) return null;
    return (await permissionRulesStore.list()).find(rule => rule.kind === kind && rule.scope === scope) ?? null;
  },
  async allow(candidate, now = Date.now()) {
    // A kind that is always asked never gets a rule, whatever a caller sends
    if (!candidate.scope || !canAllowAlways(candidate.kind, candidate.scope)) return null;
    const rules = (await storage.get())?.rules ?? [];
    const existing = rules.find(rule => rule.kind === candidate.kind && rule.scope === candidate.scope);
    if (existing) return existing;
    const rule: PermissionRule = {
      id: crypto.randomUUID(),
      kind: candidate.kind,
      scope: candidate.scope,
      label: candidate.label.slice(0, 120),
      createdAt: now,
      lastUsedAt: null,
      uses: 0,
    };
    await storage.set({ rules: [...rules, rule].slice(-MAX_RULES) });
    return rule;
  },
  async used(id, now = Date.now()) {
    const counts = (await useStorage.get()) ?? {};
    await useStorage.set({ ...counts, [id]: { uses: (counts[id]?.uses ?? 0) + 1, lastUsedAt: now } });
  },
  async remove(id) {
    const rules = (await storage.get())?.rules ?? [];
    await storage.set({ rules: rules.filter(rule => rule.id !== id) });
    const counts = { ...((await useStorage.get()) ?? {}) };
    delete counts[id];
    await useStorage.set(counts);
  },
};
