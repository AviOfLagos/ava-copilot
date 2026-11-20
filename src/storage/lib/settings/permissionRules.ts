import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type { CommitKind } from './gateSettings';

/**
 * "Allow every time": the user approved a kind of action in a place once and said not to ask again. A rule
 * names the kind (send, publish, submit, or a connector tool) and the place (a site and its first path segment,
 * or a connector tool), never the exact content, so the same kind of step tomorrow runs without a card.
 * Rules are kept until the user removes them in Settings › Permissions.
 */

// Kinds that are always asked, whatever the user allowed before: money, deleting, and handing out access
export const ALWAYS_ASK_KINDS: readonly CommitKind[] = ['purchase', 'delete', 'permission'];

export type RuleKind = CommitKind | 'tool';

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

/** Whether a kind may get an "Allow every time" rule at all. */
export const canAllowAlways = (kind: string): kind is RuleKind =>
  kind === 'tool' || (['send', 'publish', 'submit'] as string[]).includes(kind);

/**
 * The place a page action belongs to: its host and first path segment ("docs.google.com/spreadsheets"),
 * so a rule for Google Sheets does not cover Gmail on the same host. Empty when the address cannot be read.
 */
export function pageScope(url: string): string {
  try {
    const { protocol, host, pathname } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') return '';
    const first = pathname.split('/').filter(Boolean)[0] ?? '';
    return first ? `${host.toLowerCase()}/${first}` : host.toLowerCase();
  } catch {
    return '';
  }
}

// A tool whose name, description or inputs change (a new hash) is a different tool, and is asked about again
export const toolScope = (connectorId: string, tool: string, hash: string): string =>
  `tool:${connectorId}/${tool}@${hash.slice(0, 16)}`;

const storage = createStorage<PermissionRulesState>(
  'permission-rules',
  { rules: [] },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const permissionRulesStore: PermissionRulesStorage = {
  ...storage,
  async list() {
    return (await storage.get())?.rules ?? [];
  },
  async find(kind, scope) {
    if (!scope || !canAllowAlways(kind)) return null;
    return (await permissionRulesStore.list()).find(rule => rule.kind === kind && rule.scope === scope) ?? null;
  },
  async allow(candidate, now = Date.now()) {
    // A kind that is always asked never gets a rule, whatever a caller sends
    if (!candidate.scope || !canAllowAlways(candidate.kind)) return null;
    const rules = await permissionRulesStore.list();
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
    const rules = await permissionRulesStore.list();
    await storage.set({
      rules: rules.map(rule => (rule.id === id ? { ...rule, uses: rule.uses + 1, lastUsedAt: now } : rule)),
    });
  },
  async remove(id) {
    const rules = await permissionRulesStore.list();
    await storage.set({ rules: rules.filter(rule => rule.id !== id) });
  },
};
