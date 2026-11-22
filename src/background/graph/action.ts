import { z } from 'zod';
import { graphStore, kbStore, normalizeName } from '@extension/storage';
import type { GraphNode } from '@extension/storage';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { canSee, canSeeNode, memoryScopeForThread } from '../kb/scope';

export const lookUpGraphActionSchema = {
  name: 'look_up_graph',
  description:
    "Look up a person, project, organization, decision or action in the user's knowledge graph: what it is linked to, e.g. a project's decisions and open actions, who owns what, which meetings a person was in. Read-only.",
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    name: z.string().describe('the name to look up, e.g. "Sponsor deck" or "Ada"'),
  }),
} satisfies ActionSchema;

const KIND_WORDS: Record<string, [string, string]> = {
  mentions: ['mentions', 'mentioned in'],
  attended: ['attended by', 'was in'],
  decided_in: ['decided in', 'decision'],
  raised_in: ['raised in', 'action'],
  assigned_to: ['assigned to', 'assigned'],
  part_of: ['part of', 'includes'],
};

/** A node and its links, as lines the agent reads. */
export function describeNode(node: GraphNode, links: { node: GraphNode; kind: string; outgoing: boolean }[]): string {
  const lines = [`${node.type} "${node.label}" (${new Date(node.date).toISOString().slice(0, 10)})`];
  for (const link of links.slice(0, 40)) {
    const [out, into] = KIND_WORDS[link.kind] ?? [link.kind, link.kind];
    lines.push(`- ${link.outgoing ? out : into}: ${link.node.type} "${link.node.label}"`);
  }
  return lines.join('\n');
}

/**
 * Handles look_up_graph: the best matching nodes in the task's workspace (and those in none), each
 * with its links. Never another workspace's, and only what the chat's memory scope may read: a node or a
 * link shows only when a source the caller may see names it, so another agent's private notes never leak
 * through the graph.
 */
export async function lookUpGraphAction(
  context: AgentContext,
  input: z.infer<typeof lookUpGraphActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || `Looking up "${input.name}"`);
  const scope = await memoryScopeForThread(context.taskId);
  const workspaceId = scope.workspaceId;
  const visible = new Set((await kbStore.items()).filter(item => canSee(scope, item)).map(item => item.id));
  const wanted = normalizeName(input.name);
  // In a workspace: its own and unassigned nodes; in none: all of them
  const nodes = await graphStore.nodes(workspaceId ?? undefined);
  const found = nodes
    .filter(node => wanted && normalizeName(node.label).includes(wanted) && canSeeNode(node, visible))
    .sort((a, b) => a.label.length - b.label.length)
    .slice(0, 3);
  if (found.length === 0) {
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'Nothing in the graph');
    return new ActionResult({
      extractedContent: `Nothing named "${input.name}" in the knowledge graph.`,
      includeInMemory: true,
    });
  }
  const parts: string[] = [];
  for (const node of found) {
    const links = (await graphStore.neighbors(node.id))
      .filter(
        link =>
          (!workspaceId || !link.node.workspaceId || link.node.workspaceId === workspaceId) &&
          visible.has(link.edge.sourceItemId) &&
          canSeeNode(link.node, visible),
      )
      .map(link => ({ node: link.node, kind: link.edge.kind, outgoing: link.outgoing }));
    parts.push(describeNode(node, links));
  }
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `Found ${found.length} in the graph`);
  // Names and decisions come from chats, meetings and pages: data, never instructions
  return new ActionResult({
    extractedContent: wrapUntrustedContent(parts.join('\n\n')),
    includeInMemory: true,
    outside: true,
  });
}
