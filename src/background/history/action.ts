import { z } from 'zod';
import { kbStore, threadStore, workspaceStore } from '@extension/storage';
import type { WorkspaceSummary } from '@extension/storage';
import { Action } from '../agent/actions/builder';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import { dayLabel, describeSource } from '../kb/answer';
import { memoryScopeForThread } from '../kb/scope';
import { getKnowledgeBase } from '../kb/shared';
import { fingerprintOf, itemsOf, rollupMarkdown, workspaceSummaries } from './summaries';

export const workspaceContextSchema = {
  name: 'workspace_context',
  description:
    "The current workspace's \"where we are\": recent work, decisions, open threads and next actions, from its chats, meetings, notes and the user's sessions with other AI tools. With a query, also the workspace's passages that match it. Outside a workspace, every workspace's latest activity and next actions. Read-only.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z
      .string()
      .default('')
      .describe(
        'optional: what to look for in this workspace, e.g. "the pricing decision"; empty for the summary only',
      ),
  }),
} satisfies ActionSchema;

export const WORKSPACE_CONTEXT_PROMPT = `- workspace_context: call it FIRST when the user asks to "summarize", "where are we at", for the status, or what to do next, and at the start of a task that builds on earlier work in this workspace, instead of asking the user to repeat it. It answers only from this workspace's own sources; cite them as given, e.g. [2].`;

function summaryText(name: string, summary: WorkspaceSummary): string {
  const sources = summary.sources.map(source => `[${source.n}] ${source.title} (${dayLabel(source.date)})`).join('\n');
  return `Where we are in "${name}" (as of ${dayLabel(summary.builtAt)}, from ${summary.itemCount} sources):\n${summary.text}\n\nSources:\n${sources}`;
}

/** The workspace_context action: the summary of the task's workspace, or the roll-up outside one. */
export async function workspaceContext(
  context: AgentContext,
  input: z.infer<typeof workspaceContextSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Reading where this workspace is at');
  const workspaceId = (await threadStore.get(context.taskId).catch(() => undefined))?.workspaceId ?? null;
  const workspace = await workspaceStore.get(workspaceId);
  if (!workspace) {
    const entries = await workspaceSummaries.rollup();
    const text = rollupMarkdown(entries) || 'Nothing is in any workspace yet.';
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Read ${entries.length} workspaces`);
    return new ActionResult({ extractedContent: wrapUntrustedContent(text), includeInMemory: true, outside: true });
  }

  // Out of date when the workspace's items changed since it was written
  let summary = await workspaceSummaries.get(workspace.id);
  const own = itemsOf(await kbStore.items(), workspace.id);
  // A summary is used only while it matches what everyone may read now: an item made private since must not live on
  // in it. Nothing readable left, or a refresh that did not happen (over budget, model down), means no summary.
  if (summary && !own.length) summary = null;
  if (summary && summary.fingerprint !== fingerprintOf(own)) {
    await workspaceSummaries.refresh({ workspaceId: workspace.id });
    summary = await workspaceSummaries.get(workspace.id);
    if (summary && summary.fingerprint !== fingerprintOf(own)) summary = null;
  }
  const parts = [summary ? summaryText(workspace.name, summary) : `Nothing is in "${workspace.name}" yet.`];

  if (input.query.trim()) {
    const kb = getKnowledgeBase();
    // This workspace's own passages only: not another's, and not what belongs to none
    const hits = (await kb?.search(input.query, 12, await memoryScopeForThread(context.taskId)))?.filter(
      hit => hit.item.workspaceId === workspace.id,
    );
    parts.push(
      hits?.length
        ? `Passages in "${workspace.name}" matching "${input.query}":\n\n${hits
            .slice(0, 6)
            .map(hit => `(${describeSource(hit)})\n${hit.chunk.text}`)
            .join('\n\n')}`
        : `Nothing in "${workspace.name}" matches "${input.query}".`,
    );
  }
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Read where "${workspace.name}" is at`);
  // What sessions and chats said is data, never instructions
  return new ActionResult({
    extractedContent: wrapUntrustedContent(parts.join('\n\n')),
    includeInMemory: true,
    outside: true,
  });
}

export function createWorkspaceContextAction(context: AgentContext): Action {
  return new Action(
    (input: z.infer<typeof workspaceContextSchema.schema>) => workspaceContext(context, input),
    workspaceContextSchema,
  );
}
