import { z } from 'zod';
import { historyStore, kbItemId, kbStore, workspaceStore } from '@extension/storage';
import type { KbStore, KnowledgeItem, Workspace } from '@extension/storage';
import type { KnowledgeBase } from '../kb/manager';
import { chunkSession } from './chunk';
import { capTurns, cleanText, MAX_TURN_CHARS } from './parse/common';
import { redactSecrets } from './redact';
import { projectKey, routeConversation } from './route';
import { AI_TOOLS } from './tools';
import type { ImportedConversation } from './tools';

// At most this many conversations a message, and this many turns a conversation
export const BATCH_SIZE = 40;
const MAX_TURNS = 400;

/** One conversation as the panel sends it. Everything is checked again here: the page is not trusted. */
export const conversationSchema = z.object({
  id: z.string().min(1).max(300),
  tool: z.enum(AI_TOOLS),
  title: z.string().max(400),
  project: z.string().max(1000).nullable(),
  branch: z.string().max(200).nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(MAX_TURN_CHARS * 2),
        at: z.number().nullable(),
      }),
    )
    .max(MAX_TURNS),
});

export interface BatchCounts {
  added: number;
  updated: number;
  unchanged: number;
  redacted: number;
}

/** The source id of an imported conversation: by tool and its own id, so bringing it in twice replaces it. */
export function sessionSourceId(conversation: Pick<ImportedConversation, 'tool' | 'id'>): string {
  return `${conversation.tool}:${conversation.id}`;
}

/** A conversation with every secret taken out of its title and turns, and its turns cut to size again. */
export function redactConversation(conversation: ImportedConversation): {
  conversation: ImportedConversation;
  count: number;
} {
  let count = 0;
  const scrub = (text: string) => {
    const result = redactSecrets(text);
    count += result.count;
    return result.text;
  };
  const turns = capTurns(
    conversation.turns.map(turn => ({ ...turn, text: scrub(cleanText(turn.text)) })).filter(turn => turn.text),
  );
  return {
    conversation: {
      ...conversation,
      title: scrub(conversation.title).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled',
      project: conversation.project ? scrub(conversation.project) : null,
      branch: conversation.branch ? scrub(conversation.branch) : null,
      turns,
    },
    count,
  };
}

export interface ImportDeps {
  kb: Pick<KnowledgeBase, 'saveSessions'>;
  store: Pick<KbStore, 'item'>;
  workspaces: () => Promise<Workspace[]>;
  mappings: () => Promise<Record<string, string | null>>;
}

const defaultDeps = (kb: Pick<KnowledgeBase, 'saveSessions'>): ImportDeps => ({
  kb,
  store: kbStore,
  workspaces: () => workspaceStore.list(),
  mappings: () => historyStore.projects(),
});

/**
 * Stores one batch of conversations from an import: redacted again, routed to a workspace, chunked and
 * written as `ai-session` knowledge items. One that did not change since it was last brought in is
 * skipped, so a re-read of a folder only pays for what is new.
 */
export async function importBatch(
  importId: string,
  incoming: ImportedConversation[],
  deps: ImportDeps | Pick<KnowledgeBase, 'saveSessions'>,
  force = false,
): Promise<BatchCounts> {
  const { kb, store, workspaces: loadWorkspaces, mappings: loadMappings } = 'store' in deps ? deps : defaultDeps(deps);
  const workspaces = await loadWorkspaces();
  const mappings = await loadMappings();
  const counts: BatchCounts = { added: 0, updated: 0, unchanged: 0, redacted: 0 };
  const sessions: Parameters<KnowledgeBase['saveSessions']>[0] = [];
  for (const raw of incoming) {
    const { conversation, count } = redactConversation(raw);
    if (!conversation.turns.some(turn => turn.role === 'user')) continue;
    const sourceId = sessionSourceId(conversation);
    const previous: KnowledgeItem | undefined = await store.item(kbItemId('ai-session', sourceId));
    if (!force && previous && previous.sourceUpdatedAt >= conversation.updatedAt && previous.chunkCount > 0) {
      counts.unchanged++;
      continue;
    }
    counts.redacted += count;
    const { workspaceId } = routeConversation(conversation, workspaces, mappings);
    sessions.push({
      sourceId,
      title: conversation.title,
      sourceDate: conversation.startedAt,
      sourceUpdatedAt: conversation.updatedAt,
      workspaceId,
      origin: { tool: conversation.tool, project: projectKey(conversation.project), importId },
      chunks: chunkSession(kbItemId('ai-session', sourceId), conversation),
    });
    if (previous) counts.updated++;
    else counts.added++;
  }
  if (sessions.length) await kb.saveSessions(sessions);
  return counts;
}
