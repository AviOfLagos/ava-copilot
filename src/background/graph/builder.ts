import { graphStore, kbSettingsStore, kbStore, meetingStore, threadStore } from '@extension/storage';
import type { GraphStore, KbStore, KnowledgeItem, MeetingStore, ThreadStore } from '@extension/storage';
import { wrapUntrustedContent } from '../agent/messages/utils';
import type { KbChange } from '../kb/manager';
import { KB_SESSION } from '../kb/manager';
import { hashText } from '../kb/chunker';
import { generateStructured } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import { resolveModels } from '../threads/factory';
import { isOverDailyBudget } from '../usage/budget';
import { mergeReadings, READING_INSTRUCTIONS, readingFromNote, readingSchema, sliceFrom } from './extract';
import type { Reading } from './extract';

const logger = createLogger('Graph');

// The most of a source that is read for the graph
const MAX_READ_CHARS = 8000;
const SOURCE_TYPES = new Set(['thread', 'meeting', 'page', 'note']);
const EMPTY: Reading = { people: [], organizations: [], projects: [], decisions: [], actions: [] };

export interface GraphDeps {
  graph: GraphStore;
  kb: KbStore;
  threads: ThreadStore;
  meetings: MeetingStore;
  model: () => Promise<ChatModel>;
  overCap: () => Promise<boolean>;
  enabled: () => Promise<boolean>;
}

const defaultDeps: GraphDeps = {
  graph: graphStore,
  kb: kbStore,
  threads: threadStore,
  meetings: meetingStore,
  // The navigator's model: usually the faster, cheaper one
  model: async () => (await resolveModels(null, { sessionId: KB_SESSION, notify: () => {} })).navigator,
  // The cost cap, and the token cap when models with no known price are in use
  overCap: () => isOverDailyBudget(),
  enabled: async () => (await kbSettingsStore.getSettings()).buildGraph,
};

/**
 * Keeps the knowledge graph in step with the knowledge base: every item added or changed is read for
 * the people, organizations, projects, decisions and actions it names, in its workspace; every item
 * removed takes what only it named with it. One item at a time, and an unchanged item is never read
 * again.
 */
export class GraphBuilder {
  private readonly deps: GraphDeps;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: Partial<GraphDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(error => logger.error('Graph update failed', error));
    return next;
  }

  /** Follows one change of the knowledge base. */
  handle(change: KbChange): Promise<void> {
    switch (change.type) {
      case 'put':
        return this.serial(() => this.build(change.itemId));
      case 'remove':
        return this.serial(() => this.deps.graph.removeSource(change.itemId));
      case 'wipe':
        return this.serial(() => this.deps.graph.wipe());
      default:
        return this.sync();
    }
  }

  /** Brings the whole graph in step: sources gone from the knowledge base leave, new or changed ones are read. */
  sync(): Promise<void> {
    return this.serial(async () => {
      const items = await this.deps.kb.items();
      const ids = new Set(items.map(item => item.id));
      for (const node of await this.deps.graph.nodes()) {
        if (SOURCE_TYPES.has(node.type) && !ids.has(node.id)) await this.deps.graph.removeSource(node.id);
      }
      for (const item of items) await this.build(item.id);
    });
  }

  private async build(itemId: string): Promise<void> {
    const item = await this.deps.kb.item(itemId);
    if (!item) {
      await this.deps.graph.removeSource(itemId);
      return;
    }
    if (!(await this.deps.enabled())) return;
    const text = (await this.textOf(item)).slice(0, MAX_READ_CHARS);
    const hash = hashText(`${item.workspaceId ?? '-'}|${item.title}|${text}`);
    const existing = await this.deps.graph.node(item.id);
    if (existing?.hash === hash) return;

    let reading = EMPTY;
    if (item.sourceType === 'meeting') {
      const note = (await this.deps.meetings.get(item.sourceId))?.note;
      if (note) reading = readingFromNote(note);
    }
    // The user's own Obsidian notes join as they are, without a model call each: a vault can be large
    const fromVault = item.sourceId.startsWith('vault:');
    if (text.trim() && !fromVault && !(await this.deps.overCap())) {
      try {
        const { output } = await generateStructured({
          chatModel: await this.deps.model(),
          schema: readingSchema,
          name: 'graph_reading',
          messages: [
            systemMessage(READING_INSTRUCTIONS),
            // Pages, chats and meetings hold words from other people: data, never instructions
            userMessage(wrapUntrustedContent(`Title: ${item.title}\n\n${text}`)),
          ],
        });
        reading = mergeReadings(reading, output);
      } catch (error) {
        // The source still joins the graph, with what is known without the model
        logger.warning('Could not read an item for the graph', error);
      }
    } else if (!existing && reading === EMPTY && !text.trim()) {
      return;
    }
    await this.deps.graph.replace(sliceFrom(item, reading, hash));
  }

  /** The words of a source, as the graph reads them. */
  private async textOf(item: KnowledgeItem): Promise<string> {
    if (item.sourceType === 'thread') {
      const messages = await this.deps.threads.messages(item.sourceId);
      return messages
        .filter(message => message.actor === 'user' || message.actor === 'planner')
        .map(message => `${message.actor === 'user' ? 'User' : 'Copilot'}: ${message.content}`)
        .join('\n');
    }
    if (item.sourceType === 'meeting') {
      const meeting = await this.deps.meetings.get(item.sourceId);
      if (meeting?.markdown) return meeting.markdown;
    }
    return (await this.deps.kb.chunks(item.id)).map(chunk => chunk.text).join('\n');
  }
}
