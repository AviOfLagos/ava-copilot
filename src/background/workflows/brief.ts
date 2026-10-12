import type { AviCopilotDb } from '@extension/storage';
import { parseSpec } from './spec';

/**
 * Workflow sections of the morning brief. An out.brief_section step stores its section in its output;
 * the brief includes today's sections when it is made, and a section that comes later is added to it.
 */

export interface WorkflowBriefSection {
  workflowId: string;
  workflowName: string;
  title: string;
  markdown: string;
  workspaceId: string | null;
  at: number;
}

const SECTION_CHARS = 6000;
// A run feeding the brief that started this recently is waited for
const WAIT_FOR_RUN_MS = 10 * 60_000;

/** The section an out.brief_section step stored, or null. */
export function briefSectionOf(output: unknown): WorkflowBriefSection | null {
  const section = (output as { briefSection?: WorkflowBriefSection } | null)?.briefSection;
  return section && typeof section.title === 'string' && typeof section.markdown === 'string' ? section : null;
}

/**
 * Model-written Markdown made safe to show: no images or embedded media (an address could carry data
 * out), no raw HTML, plain titles, and a length the brief can hold.
 */
export function sanitizeSectionMarkdown(text: string): string {
  const cleaned = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > SECTION_CHARS ? `${cleaned.slice(0, SECTION_CHARS - 1)}…` : cleaned;
}

function plainTitle(text: string): string {
  return (
    text
      .replace(/\s+/g, ' ')
      .replace(/[`<>[\]!*_#]/g, '')
      .trim()
      .slice(0, 80) || 'Workflow'
  );
}

/** A section as the brief shows it: a bold title, then the content. */
export function sectionMarkdown(section: Pick<WorkflowBriefSection, 'title' | 'markdown'>): string {
  return `**${plainTitle(section.title)}**\n${sanitizeSectionMarkdown(section.markdown)}`;
}

export function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Today's workflow sections, oldest first; a workflow that ran twice gives its latest. */
export async function todaysBriefSections(database: AviCopilotDb, now: number): Promise<WorkflowBriefSection[]> {
  const runs = await database.runs
    .where('startedAt')
    .aboveOrEqual(startOfLocalDay(now))
    .filter(run => run.kind === 'workflow')
    .toArray();
  const latest = new Map<string, WorkflowBriefSection>();
  for (const run of runs) {
    const steps = await database.runSteps.where('runId').equals(run.id).toArray();
    for (const step of steps) {
      const section = step.status === 'succeeded' ? briefSectionOf(step.output) : null;
      if (!section) continue;
      const key = `${section.workflowId}:${step.nodeId}`;
      const known = latest.get(key);
      if (!known || known.at < section.at) latest.set(key, section);
    }
  }
  return [...latest.values()].sort((a, b) => a.at - b.at);
}

/**
 * Whether a workflow that feeds the brief is running now or due now: the brief waits for it, and comes
 * as soon as it ends.
 */
export async function briefSectionsPending(database: AviCopilotDb, now: number): Promise<boolean> {
  const feeding = (await database.workflows.where('status').equals('active').toArray()).filter(workflow =>
    parseSpec(workflow.spec)?.nodes.some(node => node.type === 'out.brief_section'),
  );
  if (feeding.length === 0) return false;
  const ids = new Set(feeding.map(workflow => workflow.id));
  const running = await database.runs
    .where('status')
    .anyOf('queued', 'running')
    .filter(run => ids.has(run.workflowId ?? '') && now - run.startedAt < WAIT_FOR_RUN_MS)
    .count();
  if (running > 0) return true;
  const due = await database.jobs
    .where('key')
    .anyOf(feeding.map(workflow => `workflow:${workflow.id}`))
    .filter(
      job =>
        (job.status === 'scheduled' || job.status === 'running') &&
        job.runAt <= now &&
        now - job.runAt <= job.catchUpMs,
    )
    .count();
  return due > 0;
}
