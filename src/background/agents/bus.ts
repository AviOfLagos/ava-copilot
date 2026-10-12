import { backoffMs, toAppError } from '@extension/shared';
import { db as defaultDb } from '@extension/storage';
import type { AgentProfile, AviCopilotDb, BusMessage } from '@extension/storage';
import type { ScheduleRequest } from '../jobs/runner';
import { createLogger } from '../log';
import { topicMatches } from './patterns';

/**
 * How agents feed each other: an agent posts its result to a topic, and every agent listening to that topic
 * gets a run with it. Messages are kept in the database and delivered at least once (a delivery cut off by a
 * restart is tried again; the receiving run is made once per message and agent, so a repeat is a no-op), a
 * message id is never posted twice, a message that has passed through too many agents is dropped, and a
 * message carries taint: content from outside stays marked as such from one agent to the next.
 */

const logger = createLogger('AgentBus');

// A message passes through at most this many agents; one that would go further is dropped
export const MAX_HOPS = 3;
export const BUS_JOB = 'agent-bus';
export const busJobKey = (messageId: string) => `agent-bus:${messageId}`;
// Kept this long, for the run log
export const BUS_KEPT_MS = 7 * 24 * 60 * 60_000;
// Deliveries still pending after a restart are tried again when this recent
const REDELIVER_WINDOW_MS = 24 * 60 * 60_000;
const MAX_PAYLOAD_CHARS = 20_000;
const MAX_ATTEMPTS = 6;

export interface PublishOptions {
  fromAgentId: string | null;
  runId: string | null;
  // The run that posts it read content from outside
  tainted: boolean;
  // How many agents the content has passed through, this one included
  hops?: number;
  // An idempotency key: posting the same id again returns the first message
  id?: string;
}

/** Starts the receiving agent's run. Throws an AppError: a kind that cannot pass (budget, paused) settles it. */
export type Delivery = (agentId: string, message: BusMessage) => Promise<void>;

// Refusals that will not change by trying again: the delivery is settled
const SETTLED_KINDS = new Set(['budget', 'invalid', 'not_found', 'forbidden', 'unavailable', 'cancelled']);

/** Text payloads are cut to a size a run can read; anything else is kept as given. */
export function capPayload(payload: unknown): unknown {
  if (typeof payload === 'string') return payload.slice(0, MAX_PAYLOAD_CHARS);
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    const value = payload as { text: string };
    return { ...value, text: value.text.slice(0, MAX_PAYLOAD_CHARS) };
  }
  return payload;
}

/** Whether two agents share a workspace (both in none counts): content never crosses workspaces. */
export function sameWorkspace(
  a: Pick<AgentProfile, 'workspaceId'> | null | undefined,
  b: Pick<AgentProfile, 'workspaceId'>,
): boolean {
  return (a?.workspaceId ?? null) === (b.workspaceId ?? null);
}

/** The agents a message on this topic goes to: created, switched on, listening, in the sender's workspace. */
export function recipientsOf(agents: readonly AgentProfile[], topic: string, fromAgentId: string | null): string[] {
  const from = fromAgentId ? agents.find(agent => agent.id === fromAgentId) : null;
  return agents
    .filter(
      agent =>
        agent.id !== fromAgentId &&
        agent.status !== 'draft' &&
        agent.enabled &&
        agent.subscribes.some(listened => topicMatches(listened, topic)) &&
        sameWorkspace(from, agent),
    )
    .map(agent => agent.id);
}

export class AgentBus {
  constructor(
    private readonly deliver: Delivery,
    private readonly schedule: (request: ScheduleRequest) => Promise<unknown>,
    private readonly db: AviCopilotDb = defaultDb,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Posts a message and delivers it to the agents listening. Returns the message as stored: the first one
   * when the id was posted before, or one marked dropped when it passed through too many agents.
   */
  async publish(topic: string, payload: unknown, options: PublishOptions): Promise<BusMessage> {
    const id = options.id ?? crypto.randomUUID();
    const hops = Math.max(1, options.hops ?? 1);
    const existing = await this.db.bus.get(id);
    if (existing) return existing;
    const dropped = hops > MAX_HOPS;
    const message: BusMessage = {
      id,
      topic: topic.trim().toLowerCase(),
      fromAgentId: options.fromAgentId,
      runId: options.runId,
      payload: capPayload(payload),
      hops,
      tainted: options.tainted,
      deliveredTo: [],
      createdAt: this.now(),
      recipients: dropped ? [] : recipientsOf(await this.db.agents.toArray(), topic, options.fromAgentId),
      dropped: dropped ? 'hop_limit' : null,
    };
    const added = await this.db.transaction('rw', this.db.bus, async () => {
      const again = await this.db.bus.get(id);
      if (again) return again;
      await this.db.bus.add(message);
      return message;
    });
    if (added !== message) return added;
    if (dropped) {
      logger.info(`Dropped a message on "${message.topic}": it passed through ${hops - 1} agents already`);
      return message;
    }
    await this.deliverPending(id);
    return (await this.db.bus.get(id)) ?? message;
  }

  /**
   * Delivers a message to the listeners that do not have it yet. A delivery refused for good (budget, paused)
   * is settled; one that failed otherwise is tried again later, with back-off.
   *
   * @returns The agents still waiting for it
   */
  async deliverPending(messageId: string, attempt = 0): Promise<string[]> {
    const message = await this.db.bus.get(messageId);
    if (!message || message.dropped) return [];
    const pending = (message.recipients ?? []).filter(agentId => !message.deliveredTo.includes(agentId));
    const left: string[] = [];
    for (const agentId of pending) {
      try {
        await this.deliver(agentId, message);
        await this.settle(messageId, agentId);
      } catch (error) {
        const appError = toAppError(error);
        if (SETTLED_KINDS.has(appError.kind)) {
          logger.info(`A message on "${message.topic}" was not taken (${appError.kind})`);
          await this.settle(messageId, agentId);
        } else {
          left.push(agentId);
        }
      }
    }
    if (left.length && attempt < MAX_ATTEMPTS) {
      await this.schedule({
        kind: BUS_JOB,
        key: busJobKey(messageId),
        runAt: this.now() + backoffMs(attempt + 1, { baseMs: 15_000, capMs: 10 * 60_000 }),
        payload: { messageId, attempt: attempt + 1 },
      });
    }
    return left;
  }

  private async settle(messageId: string, agentId: string): Promise<void> {
    await this.db.transaction('rw', this.db.bus, async () => {
      const message = await this.db.bus.get(messageId);
      if (!message || message.deliveredTo.includes(agentId)) return;
      await this.db.bus.update(messageId, { deliveredTo: [...message.deliveredTo, agentId] });
    });
  }

  /** After a restart: recent messages that some listeners never got are delivered again. */
  async recover(): Promise<number> {
    const since = this.now() - REDELIVER_WINDOW_MS;
    const recent = await this.db.bus.where('createdAt').above(since).toArray();
    let redelivered = 0;
    for (const message of recent) {
      if (message.dropped) continue;
      if ((message.recipients ?? []).some(agentId => !message.deliveredTo.includes(agentId))) {
        await this.deliverPending(message.id);
        redelivered += 1;
      }
    }
    return redelivered;
  }

  /** Removes messages past their keeping time. */
  async prune(): Promise<number> {
    return this.db.bus
      .where('createdAt')
      .below(this.now() - BUS_KEPT_MS)
      .delete();
  }
}
