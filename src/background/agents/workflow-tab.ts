import { db as defaultDb } from '@extension/storage';
import type { AviCopilotDb, RunRecord, WorkflowRecord } from '@extension/storage';
import { createLogger } from '../log';
import { parseSpec } from '../workflows/spec';
import { startOfLocalDay } from './budget';
import { matchesUrlPattern, tabPatternIssue } from './patterns';
import { TabCooldown } from './triggers';
import type { TabEvent } from './triggers';

/**
 * Routines with a trigger.tab: a page the user opens that matches wakes them, as it wakes agents. The run is
 * unattended and tainted (a page set it off), one at a time per routine, within its runs a day, and the same
 * page wakes the same routine once in ten minutes.
 */

const logger = createLogger('Agents');

export interface WorkflowStarter {
  createRun(
    workflow: WorkflowRecord,
    options: { trigger: { type: string; detail: string }; attended: boolean; tainted: boolean },
  ): Promise<RunRecord>;
  // Starts it now, and keeps a job so a restart picks it up
  start(runId: string): Promise<void>;
}

const OPEN = new Set(['queued', 'running', 'waiting_user']);

/** The active routines watching a page with this address. */
export function workflowsWatching(workflows: readonly WorkflowRecord[], url: string): WorkflowRecord[] {
  return workflows.filter(
    workflow =>
      workflow.status === 'active' &&
      Boolean(
        parseSpec(workflow.spec)?.nodes.some(
          node =>
            node.type === 'trigger.tab' && !tabPatternIssue(node.urlPattern) && matchesUrlPattern(node.urlPattern, url),
        ),
      ),
  );
}

export class WorkflowTabTriggers {
  private readonly cooldown = new TabCooldown();

  constructor(
    private readonly starter: WorkflowStarter,
    private readonly database: AviCopilotDb = defaultDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts the routines watching this page. Returns how many started. */
  async fire(event: TabEvent): Promise<number> {
    const now = this.now();
    let started = 0;
    const active = await this.database.workflows.where('status').equals('active').toArray();
    for (const workflow of workflowsWatching(active, event.url)) {
      const runs = await this.database.runs.where('workflowId').equals(workflow.id).toArray();
      if (runs.some(run => OPEN.has(run.status))) continue;
      const limit = parseSpec(workflow.spec)?.budget.maxRunsPerDay ?? 24;
      const today = runs.filter(run => run.trigger.type === 'tab' && run.startedAt >= startOfLocalDay(now)).length;
      if (today >= limit) continue;
      if (!this.cooldown.take(`workflow:${workflow.id}`, event.url, now)) continue;
      try {
        const run = await this.starter.createRun(workflow, {
          trigger: { type: 'tab', detail: event.url },
          attended: false,
          tainted: true,
        });
        await this.starter.start(run.id);
        started += 1;
      } catch (error) {
        logger.warning(`"${workflow.name}" did not start for a page`, error);
      }
    }
    return started;
  }
}
