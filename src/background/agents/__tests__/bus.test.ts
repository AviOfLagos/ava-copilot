import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@extension/shared';
import { AviCopilotDb } from '@extension/storage';
import type { BusMessage } from '@extension/storage';
import type { ScheduleRequest } from '../../jobs/runner';
import { AgentBus, BUS_JOB, MAX_HOPS, recipientsOf } from '../bus';
import { agentRecord } from './fixtures';

let db: AviCopilotDb;
let delivered: { agentId: string; message: BusMessage }[];
let failFor: Map<string, AppError>;
let scheduled: ScheduleRequest[];
let bus: AgentBus;
let clock: number;

const sender = agentRecord({ name: 'Sender', publishes: ['news.daily'] });
const reader = agentRecord({ name: 'Reader', subscribes: ['news.*'], triggers: [{ type: 'topic', topic: 'news.*' }] });
const second = agentRecord({ name: 'Second', subscribes: ['news.daily'] });

beforeEach(async () => {
  db = new AviCopilotDb(`agent-bus-${crypto.randomUUID()}`);
  delivered = [];
  failFor = new Map();
  scheduled = [];
  clock = Date.UTC(2026, 9, 12, 9);
  bus = new AgentBus(
    async (agentId, message) => {
      const failure = failFor.get(agentId);
      if (failure) throw failure;
      delivered.push({ agentId, message });
    },
    async request => void scheduled.push(request),
    db,
    () => clock,
  );
  await db.agents.bulkAdd([sender, reader, second]);
});

describe('AgentBus', () => {
  it('delivers a message to every listener once, and never back to the sender', async () => {
    const message = await bus.publish(
      'news.daily',
      { text: 'Today: nothing' },
      {
        fromAgentId: sender.id,
        runId: 'run-1',
        tainted: false,
      },
    );
    expect(delivered.map(item => item.agentId).sort()).toEqual([reader.id, second.id].sort());
    expect(message.deliveredTo.sort()).toEqual([reader.id, second.id].sort());
    expect(message.hops).toBe(1);
  });

  it('posts an id once: the same id again returns the first message and delivers nothing more', async () => {
    const first = await bus.publish('news.daily', 'a', {
      fromAgentId: sender.id,
      runId: 'r',
      tainted: false,
      id: 'r:news.daily',
    });
    const again = await bus.publish('news.daily', 'b', {
      fromAgentId: sender.id,
      runId: 'r',
      tainted: false,
      id: 'r:news.daily',
    });
    expect(again.id).toBe(first.id);
    expect(again.payload).toBe('a');
    expect(delivered).toHaveLength(2);
    expect(await db.bus.count()).toBe(1);
  });

  it('drops a message past the hop limit, keeping it for the log', async () => {
    const kept = await bus.publish('news.daily', 'deep', {
      fromAgentId: sender.id,
      runId: 'r',
      tainted: true,
      hops: MAX_HOPS,
    });
    expect(kept.dropped).toBeNull();
    delivered = [];
    const dropped = await bus.publish('news.daily', 'deeper', {
      fromAgentId: sender.id,
      runId: 'r2',
      tainted: true,
      hops: MAX_HOPS + 1,
    });
    expect(dropped.dropped).toBe('hop_limit');
    expect(dropped.recipients).toEqual([]);
    expect(delivered).toEqual([]);
    expect((await db.bus.get(dropped.id))?.dropped).toBe('hop_limit');
  });

  it('carries taint from the run that posted it', async () => {
    const message = await bus.publish('news.daily', 'from a page', {
      fromAgentId: sender.id,
      runId: 'r',
      tainted: true,
    });
    expect(message.tainted).toBe(true);
    expect(delivered.every(item => item.message.tainted)).toBe(true);
  });

  it('keeps a delivery that failed for later, and settles a refusal that will not change', async () => {
    failFor.set(reader.id, new AppError('network', 'down'));
    failFor.set(second.id, new AppError('budget', 'spent'));
    const message = await bus.publish('news.daily', 'x', { fromAgentId: sender.id, runId: 'r', tainted: false });
    expect(message.deliveredTo).toEqual([second.id]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ kind: BUS_JOB, payload: { messageId: message.id, attempt: 1 } });

    // At least once: the next try (or a restart) delivers it
    failFor.clear();
    expect(await bus.deliverPending(message.id, 1)).toEqual([]);
    expect(delivered.map(item => item.agentId)).toEqual([reader.id]);
    expect((await db.bus.get(message.id))?.deliveredTo.sort()).toEqual([reader.id, second.id].sort());
  });

  it('redelivers after a restart what some listeners never got', async () => {
    failFor.set(reader.id, new AppError('unknown', 'cut off'));
    const message = await bus.publish('news.daily', 'x', { fromAgentId: sender.id, runId: 'r', tainted: false });
    failFor.clear();
    delivered = [];
    expect(await bus.recover()).toBe(1);
    expect(delivered.map(item => item.agentId)).toEqual([reader.id]);
    expect(await bus.recover()).toBe(0);
    expect((await db.bus.get(message.id))?.deliveredTo).toHaveLength(2);
  });

  it('prunes messages past their keeping time', async () => {
    await bus.publish('news.daily', 'old', { fromAgentId: sender.id, runId: 'r', tainted: false });
    clock += 8 * 24 * 60 * 60_000;
    expect(await bus.prune()).toBe(1);
  });
});

describe('recipientsOf', () => {
  it('only reaches created, switched-on listeners in the same workspace', () => {
    const paused = agentRecord({ enabled: false, subscribes: ['t'] });
    const draft = agentRecord({ status: 'draft', subscribes: ['t'] });
    const elsewhere = agentRecord({ workspaceId: 'w2', subscribes: ['t'] });
    const here = agentRecord({ workspaceId: 'w1', subscribes: ['t'] });
    const from = agentRecord({ workspaceId: 'w1' });
    expect(recipientsOf([paused, draft, elsewhere, here, from], 't', from.id)).toEqual([here.id]);
  });
});
