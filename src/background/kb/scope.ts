import { kbItemId, threadStore } from '@extension/storage';
import type { GraphNode, KnowledgeItem, ThreadRecord } from '@extension/storage';

/**
 * Who may read which memory. The one place that decides it: every read of the knowledge base and the
 * knowledge graph (search, ask, look-up, an item by id) goes through `canSee` with the scope of the
 * chat asking, decided from that chat alone, never from the model's arguments.
 *
 * - Ava (the user's own chats, voice, the panel, the brief) sees everything in the workspace.
 * - An agent's run sees its own private memory, the team's, and the user's own (unowned) items.
 *   Never another agent's private memory.
 * - A routine (`origin: 'workflow'`) sees the team's and the user's own items only.
 *
 * Workspaces never mix: inside one, only its items and those in none.
 */
export interface MemoryScope {
  caller: 'ava' | 'agent' | 'routine';
  workspaceId: string | null;
  // For an agent: who is asking. For Ava: an optional filter to one agent's items (the panel's agent picker).
  agentId: string | null;
}

// 'private': one agent's own (and Ava's, and the user's); 'team': every agent's; 'unowned': the user's own
export type ItemScope = 'private' | 'team' | 'unowned';

export const memoryScope = {
  ava: (workspaceId: string | null, agentId: string | null = null): MemoryScope => ({
    caller: 'ava',
    workspaceId,
    agentId,
  }),
  agent: (workspaceId: string | null, agentId: string): MemoryScope => ({ caller: 'agent', workspaceId, agentId }),
  routine: (workspaceId: string | null): MemoryScope => ({ caller: 'routine', workspaceId, agentId: null }),
};

/**
 * An item's scope. Written explicitly since memory scopes exist; before that, an item an agent's work made
 * was its own (private), and one made by no agent is the user's.
 */
export function itemScope(item: Pick<KnowledgeItem, 'scope' | 'agentId'>): ItemScope {
  if (item.scope === 'team') return 'team';
  if (item.scope === 'private' || item.agentId) return 'private';
  return 'unowned';
}

/** Whether a caller with this scope may read the item. */
export function canSee(scope: MemoryScope, item: Pick<KnowledgeItem, 'scope' | 'agentId' | 'workspaceId'>): boolean {
  const owner = item.workspaceId ?? null;
  if (scope.workspaceId && owner && owner !== scope.workspaceId) return false;
  switch (scope.caller) {
    case 'ava':
      return !scope.agentId || item.agentId === scope.agentId;
    case 'agent':
      return itemScope(item) !== 'private' || (!!item.agentId && item.agentId === scope.agentId);
    default:
      return itemScope(item) !== 'private';
  }
}

/** The scope of a chat, from its origin and the agent it runs as. */
export function memoryScopeFor(
  thread: Pick<ThreadRecord, 'workspaceId' | 'agentId' | 'origin'> | null | undefined,
): MemoryScope {
  const workspaceId = thread?.workspaceId ?? null;
  if (thread?.origin === 'workflow') return memoryScope.routine(workspaceId);
  if (thread?.agentId) return memoryScope.agent(workspaceId, thread.agentId);
  return memoryScope.ava(workspaceId);
}

/**
 * The scope of the chat a task or a conversation runs in. With no chat at all (voice before its thread
 * exists) it is the user's own; a chat id that cannot be read gets the least: a routine's, outside any workspace's
 * private items.
 */
export async function memoryScopeForThread(threadId: string | null | undefined): Promise<MemoryScope> {
  if (!threadId) return memoryScope.ava(null);
  const thread = await threadStore.get(threadId).catch(() => undefined);
  return thread ? memoryScopeFor(thread) : memoryScope.routine(null);
}

/**
 * Who owns what a caller saves: an agent's saves are its own (private) unless it shares them with the team;
 * a routine's and Ava's belong to the user, marked team when asked.
 */
export function saveFieldsFor(
  scope: MemoryScope,
  team = false,
): { agentId: string | null; scope: KnowledgeItem['scope'] } {
  if (scope.caller === 'agent') return { agentId: scope.agentId, scope: team ? 'team' : 'private' };
  return { agentId: null, scope: team ? 'team' : undefined };
}

/**
 * Whether a graph node may be shown: at least one source it came from is visible. An entity that only a hidden
 * source names stays hidden, so the graph never leaks a private item's people, projects or decisions.
 */
export function canSeeNode(node: Pick<GraphNode, 'sourceItemIds'>, visibleItemIds: ReadonlySet<string>): boolean {
  return node.sourceItemIds.some(id => visibleItemIds.has(id));
}

/**
 * A saved page's id. A page an agent saves is that agent's own item (private or shared with the team), so another agent
 * or the user saving the same address never takes it over or changes who owns it.
 */
export function itemIdFor(fields: Pick<KnowledgeItem, 'sourceType' | 'sourceId' | 'agentId'>): string {
  const ownCopy = fields.sourceType === 'page' && Boolean(fields.agentId);
  return kbItemId(fields.sourceType, ownCopy ? `${fields.sourceId}#agent:${fields.agentId}` : fields.sourceId);
}
