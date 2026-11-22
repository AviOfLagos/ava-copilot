import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Person } from '@extension/storage';
import { AviCopilotDb } from '@extension/storage/lib/threads/db';
import { createPersonUpdateStore, createTaskStore } from '@extension/storage';
import { nov } from './helpers';
import type { ReportDeps, ReportReading } from '../report';
import { startOfDay } from '../rules';

// The model half of report.ts is never reached (the reader is injected); keep it from loading the extension runtime
vi.mock('../../agent/messages/utils', () => ({ wrapUntrustedContent: (text: string) => text }));
vi.mock('../../llm/generate', () => ({ generateStructured: vi.fn() }));
vi.mock('../../llm/messages', () => ({ systemMessage: vi.fn(), userMessage: vi.fn() }));
vi.mock('../../models/light', () => ({ lightModel: vi.fn() }));
vi.mock('../../threads/factory', () => ({ resolveModels: vi.fn() }));

const { findPerson, recordReport } = await import('../report');

const MON = nov(23, 10);

const person = (id: string, name: string, aliases: string[] = [], workspaceIds: string[] = []) =>
  ({
    id,
    name,
    aliases: aliases.map(text => ({ text })),
    workspaceIds,
    handles: [],
    emails: [],
    phones: [],
    seen: [],
  }) as unknown as Person;

const reading = (fields: Partial<ReportReading> = {}): ReportReading => ({
  did: [],
  doing: [],
  next: [],
  by: null,
  blockers: [],
  ...fields,
});

let db: AviCopilotDb;
let tasks: ReturnType<typeof createTaskStore>;
let updates: ReturnType<typeof createPersonUpdateStore>;

beforeEach(() => {
  db = new AviCopilotDb(`report-${crypto.randomUUID()}`);
  tasks = createTaskStore(db, { now: () => nov(20) });
  updates = createPersonUpdateStore(db);
});

function deps(everyone: Person[], read: ReportDeps['read']): ReportDeps {
  return {
    people: {
      async resolve(text) {
        const key = text.trim().toLowerCase();
        const found = everyone.filter(p => p.name.toLowerCase() === key);
        if (found.length === 1) return { person: found[0], via: 'name' };
        return found.length ? { candidates: found } : null;
      },
      list: async () => everyone,
    },
    tasks,
    updates,
    read,
  };
}

const say = (name: string, words: string) => ({
  name,
  words,
  source: { kind: 'whatsapp' as const, id: 'wa1' },
  at: MON,
});

describe('recordReport', () => {
  const ada = person('p-ada', 'Ada Example', [], ['w1']);

  it('saves the update with by and restarts the matching task at the working day after it', async () => {
    const deck = await tasks.add({
      title: 'Deck with design review',
      workspaceId: 'w1',
      ownerId: 'p-ada',
      ownerName: 'Ada Example',
    });
    const other = await tasks.add({
      title: 'Pay the catering invoice',
      workspaceId: 'w1',
      ownerId: 'p-ada',
      ownerName: 'Ada Example',
    });
    const result = await recordReport(
      say('Ada Example', 'the deck is with design, ready thursday'),
      deps([ada], async () => reading({ doing: ['deck with design'], by: 'thursday' })),
    );
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.person).toEqual({ id: 'p-ada', name: 'Ada Example' });
    expect(result.update).toMatchObject({
      personId: 'p-ada',
      doing: ['deck with design'],
      by: '2026-11-26',
      byText: 'thursday',
      workspaceId: 'w1',
      source: { kind: 'whatsapp', id: 'wa1' },
      at: MON,
    });
    // Thursday 26 Nov + 1 working day = start of Friday 27 Nov
    const nextAt = startOfDay('2026-11-27');
    expect(result.moved).toEqual([{ taskId: deck.id, nextAt }]);
    expect((await tasks.get(deck.id))!.followUp).toMatchObject({ nextAt, nextBy: 'update', count: 0 });
    expect((await tasks.get(other.id))!.followUp).toBeUndefined();
    expect(await updates.forPerson('p-ada')).toHaveLength(1);
  });

  it('with one open task and no line naming it, that task is the one', async () => {
    const only = await tasks.add({
      title: 'Quarterly planning',
      workspaceId: null,
      ownerId: 'p-ada',
      ownerName: 'Ada Example',
    });
    const result = await recordReport(
      say('Ada Example', 'on it, ready friday'),
      deps([ada], async () => null),
    );
    expect(result.kind === 'saved' && result.moved.map(m => m.taskId)).toEqual([only.id]);
  });

  it('with two open tasks and no line naming either, none is moved', async () => {
    await tasks.add({ title: 'Quarterly planning', workspaceId: null, ownerId: 'p-ada', ownerName: 'Ada Example' });
    await tasks.add({ title: 'Pay the invoice', workspaceId: null, ownerId: 'p-ada', ownerName: 'Ada Example' });
    const result = await recordReport(
      say('Ada Example', 'going fine'),
      deps([ada], async () => null),
    );
    expect(result.kind === 'saved' && result.moved).toEqual([]);
  });

  it('without a date, the clock restarts: three working days of quiet from the update', async () => {
    const task = await tasks.add({
      title: 'Quarterly planning',
      workspaceId: null,
      ownerId: 'p-ada',
      ownerName: 'Ada Example',
    });
    await recordReport(
      say('Ada Example', 'working on it'),
      deps([ada], async () => null),
    );
    // Mon 23 + 3 working days = Thu 26
    expect((await tasks.get(task.id))!.followUp!.nextAt).toBe(startOfDay('2026-11-26'));
  });

  it('keeps the words as "doing" when no model could read them', async () => {
    const result = await recordReport(
      say('Ada Example', 'the deck is with design, ready thursday'),
      deps([ada], async () => null),
    );
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.update.doing).toEqual(['the deck is with design, ready thursday']);
    // The date is still worked out in code from the whole message
    expect(result.update.by).toBe('2026-11-26');
  });

  it('keeps the words as "doing" when the reader throws', async () => {
    const result = await recordReport(
      say('Ada Example', 'almost there'),
      deps([ada], async () => {
        throw new Error('no model');
      }),
    );
    expect(result.kind === 'saved' && result.update.doing).toEqual(['almost there']);
  });

  it('a date in the past is not kept as by', async () => {
    const result = await recordReport(
      say('Ada Example', 'done by 2026-11-20'),
      deps([ada], async () => null),
    );
    expect(result.kind === 'saved' && result.update).not.toHaveProperty('by');
  });

  it('two people of that name: which', async () => {
    const result = await recordReport(
      say('Ada', 'ready thursday'),
      deps([person('p1', 'Ada'), person('p2', 'Ada')], async () => reading({ doing: ['x'] })),
    );
    expect(result).toEqual({
      kind: 'which',
      candidates: [
        { id: 'p1', name: 'Ada' },
        { id: 'p2', name: 'Ada' },
      ],
    });
    expect(await db.personUpdates.count()).toBe(0);
  });

  it('unknown person', async () => {
    const result = await recordReport(
      say('Zed', 'ready thursday'),
      deps([ada], async () => reading({ doing: ['x'] })),
    );
    expect(result).toEqual({ kind: 'unknown' });
    expect(await db.personUpdates.count()).toBe(0);
  });

  it('empty words', async () => {
    expect(
      await recordReport(
        say('Ada Example', '  '),
        deps([ada], async () => null),
      ),
    ).toEqual({ kind: 'empty' });
  });

  it('works from a person id', async () => {
    const result = await recordReport(
      { personId: 'p-ada', words: 'on it', source: { kind: 'manual' }, at: MON },
      deps([ada], async () => reading({ doing: ['on it'] })),
    );
    expect(result.kind).toBe('saved');
    expect(
      await recordReport(
        { personId: 'p-gone', words: 'on it', source: { kind: 'manual' }, at: MON },
        deps([ada], async () => null),
      ),
    ).toEqual({
      kind: 'unknown',
    });
  });

  it('a "did" that matches an open task is an offer, and the task is neither closed nor moved', async () => {
    const task = await tasks.add({
      title: 'Send the deck to the venue',
      workspaceId: null,
      ownerId: 'p-ada',
      ownerName: 'Ada Example',
    });
    const result = await recordReport(
      say('Ada Example', 'sent the deck to the venue'),
      deps([ada], async () => reading({ did: ['sent the deck to the venue'] })),
    );
    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') return;
    expect(result.update.offers).toEqual([{ taskId: task.id, said: 'sent the deck to the venue' }]);
    expect(result.moved).toEqual([]);
    const after = (await tasks.get(task.id))!;
    expect(after.status).toBe('open');
    expect(after.followUp).toBeUndefined();
  });
});

describe('findPerson', () => {
  const people = [person('p1', 'Ada Example', ['Dee']), person('p2', 'Ben Example')];
  const d = { people: deps(people, async () => null).people };
  it.each([
    ['Ben Example', 'p2'],
    ['dee', 'p1'],
    ['ADA', 'p1'],
  ])('%s is %s', async (name, id) => {
    const found = await findPerson(d, name);
    expect(found && 'person' in found && found.person.id).toBe(id);
  });
  it('blank or unknown is null', async () => {
    expect(await findPerson(d, '  ')).toBeNull();
    expect(await findPerson(d, 'Zed')).toBeNull();
  });
  it('a first name shared by two is candidates', async () => {
    const both = { people: deps([person('p1', 'Ada One'), person('p2', 'Ada Two')], async () => null).people };
    const found = await findPerson(both, 'ada');
    expect(found && 'candidates' in found && found.candidates.map(p => p.id)).toEqual(['p1', 'p2']);
  });
});
