import { GENERAL_SUMMARY_ID, historyStore, kbStore, workspaceStore } from '@extension/storage';
import type { KbStore, KnowledgeChunk, KnowledgeItem, Workspace, WorkspaceSummary } from '@extension/storage';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import { actionsOf, fingerprintOf, itemsOf, plainSummary, rollup } from './rollup';
import { SUMMARY_INSTRUCTIONS, summaryInput } from './summary-prompt';
import type { RollupEntry } from './rollup';
import { resolveModels } from '../threads/factory';
import { isOverDailyBudget } from '../usage/budget';

const logger = createLogger('WorkspaceSummaries');

export const SUMMARY_SESSION = 'workspace-summaries';

export interface SummaryDeps {
  store: KbStore;
  model: () => Promise<ChatModel>;
  overCap: () => Promise<boolean>;
  workspaces: () => Promise<Workspace[]>;
}

const defaultDeps: SummaryDeps = {
  store: kbStore,
  model: async () => (await resolveModels(null, { sessionId: SUMMARY_SESSION, notify: () => {} })).planner,
  overCap: () => isOverDailyBudget(),
  workspaces: () => workspaceStore.list(),
};

/** Keeps every workspace's "where we are" current: one at a time, and only when its items changed. */
export class WorkspaceSummaries {
  private readonly deps: SummaryDeps;
  private running: Promise<WorkspaceSummary[]> | null = null;

  constructor(deps: Partial<SummaryDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Brings the summaries up to date; `force` rebuilds even unchanged ones. One refresh at a time. */
  refresh(options: { force?: boolean; workspaceId?: string | null } = {}): Promise<WorkspaceSummary[]> {
    // After the one running, so a refresh asked for meanwhile still sees the latest items
    const next = (this.running ?? Promise.resolve([])).catch(() => []).then(() => this.refreshAll(options));
    this.running = next;
    void next
      .finally(() => {
        if (this.running === next) this.running = null;
      })
      .catch(() => {});
    return next;
  }

  private async refreshAll({ force = false, workspaceId }: { force?: boolean; workspaceId?: string | null }) {
    const workspaces = await this.deps.workspaces();
    const items = await this.deps.store.items();
    const existing = await historyStore.summaries();
    const groups: { id: string | null; name: string; about?: string }[] = [
      ...workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, about: workspace.about })),
      { id: null, name: 'No workspace' },
    ].filter(group => workspaceId === undefined || group.id === workspaceId);
    const built: WorkspaceSummary[] = [];
    for (const group of groups) {
      const key = group.id ?? GENERAL_SUMMARY_ID;
      const own = itemsOf(items, group.id);
      if (own.length === 0) {
        if (existing[key]) await historyStore.removeSummary(key);
        continue;
      }
      const fingerprint = fingerprintOf(own);
      if (!force && existing[key]?.fingerprint === fingerprint && !existing[key].plain) continue;
      built.push(await this.build(group, items, fingerprint));
    }
    // Summaries of workspaces that were removed
    for (const key of Object.keys(existing)) {
      if (key !== GENERAL_SUMMARY_ID && !workspaces.some(workspace => workspace.id === key)) {
        await historyStore.removeSummary(key);
      }
    }
    return built;
  }

  private async build(
    group: { id: string | null; name: string; about?: string },
    items: KnowledgeItem[],
    fingerprint: string,
  ): Promise<WorkspaceSummary> {
    const chunks = new Map<string, KnowledgeChunk[]>();
    for (const item of itemsOf(items, group.id).slice(0, 200))
      chunks.set(item.id, await this.deps.store.chunks(item.id));
    const input = summaryInput(group, items, id => chunks.get(id) ?? []);
    let text = '';
    let plain = true;
    if (!(await this.deps.overCap())) {
      try {
        text = (
          await generatePlainText({
            chatModel: await this.deps.model(),
            messages: [systemMessage(SUMMARY_INSTRUCTIONS), userMessage(input.prompt)],
          })
        ).trim();
        plain = !text;
      } catch (error) {
        // The workspace still gets its plain summary
        logger.warning('Could not write a workspace summary', error);
      }
    }
    if (!text) text = plainSummary(input.sources);
    const summary: WorkspaceSummary = {
      workspaceId: group.id ?? GENERAL_SUMMARY_ID,
      text,
      actions: plain ? [] : actionsOf(text),
      sources: input.sources,
      latestAt: Math.max(0, ...input.items.map(item => item.sourceUpdatedAt)),
      fingerprint,
      itemCount: input.items.length,
      builtAt: Date.now(),
      plain,
    };
    await historyStore.saveSummary(summary);
    return summary;
  }

  /** The stored summary of a workspace (null: what is in none), built first when there is none yet. */
  async get(workspaceId: string | null): Promise<WorkspaceSummary | null> {
    const key = workspaceId ?? GENERAL_SUMMARY_ID;
    const stored = (await historyStore.summaries())[key];
    if (stored) return stored;
    await this.refresh({ workspaceId });
    return (await historyStore.summaries())[key] ?? null;
  }

  /** The all-workspaces roll-up, from the stored summaries. */
  async rollup(now = Date.now()): Promise<RollupEntry[]> {
    return rollup(await this.deps.workspaces(), await historyStore.summaries(), await this.deps.store.items(), now);
  }
}

export const workspaceSummaries = new WorkspaceSummaries();

export { fingerprintOf, itemsOf, rollupMarkdown } from './rollup';
export { SUMMARY_INSTRUCTIONS, summaryInput } from './summary-prompt';
