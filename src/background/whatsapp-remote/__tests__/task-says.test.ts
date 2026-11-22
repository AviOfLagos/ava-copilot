import { describe, expect, it, vi } from 'vitest';
import type { Person, ResolveResult, Task } from '@extension/storage';
import type { TaskDeskDeps } from '../task-desk';
import { taskCommandOf } from '../task-commands';
import { makeTask } from '../../followups/__tests__/helpers';

vi.mock('@extension/i18n', async () => ({ t: (await import('@src/background/skills/__tests__/en')).enT }));

const { TaskDesk } = await import('../task-desk');

// Part 9.3: what Avi reports back about a person, and "who's next". Fake deps, no WhatsApp, no model.

describe('taskCommandOf: "<name> says …"', () => {
  it.each([
    [
      'ada says the deck is with design, ready thursday',
      { kind: 'says', name: 'ada', words: 'the deck is with design, ready thursday' },
    ],
    ['Ada said: done with the API', { kind: 'says', name: 'Ada', words: 'done with the API' }],
    ['Ada said that the login is blocked', { kind: 'says', name: 'Ada', words: 'the login is blocked' }],
    ['ada told me the venue is booked', { kind: 'says', name: 'ada', words: 'the venue is booked' }],
    ['Ben Example reported it is ready', { kind: 'says', name: 'Ben Example', words: 'it is ready' }],
    ['hey ava, ada says hi there', { kind: 'says', name: 'ada', words: 'hi there' }],
  ])('"%s"', (text, expected) => {
    expect(taskCommandOf(text)).toEqual(expected);
  });

  it.each([
    ['it says hello'],
    ['the doc says x'],
    ['that says hello'],
    ['he said it is done'],
    ['everyone says yes'],
    ['ada says'],
  ])('"%s" is not a command', text => {
    expect(taskCommandOf(text)).toBeNull();
  });

  it.each([
    ["who's next", { kind: 'next' }],
    ['who is next?', { kind: 'next' }],
    ['done 2', { kind: 'set', status: 'done', numbers: [2] }],
    ['tasks', { kind: 'list', word: null, as: null }],
    ['tasks for ada', { kind: 'list', word: 'ada', as: 'person' }],
    ['task for ada: send the deck by friday', { kind: 'add', owner: 'ada', words: 'send the deck by friday' }],
  ])('existing command "%s" is unchanged', (text, expected) => {
    expect(taskCommandOf(text)).toEqual(expected);
  });
});

const person = (id: string, name: string) =>
  ({ id, name, aliases: [], workspaceIds: [], handles: [], emails: [], phones: [], seen: [] }) as unknown as Person;

function setup(options: { people?: Person[]; followUps?: Task[]; withReport?: boolean } = {}) {
  const everyone = options.people ?? [];
  const sent: { text: string; replyTo?: string }[] = [];
  const saved: { taskIds: string[]; numbered: boolean }[] = [];
  const report = vi.fn(async () => ({ text: 'Noted for Ada.', taskIds: ['tsk_aaaaaaaaaa'] }));
  const followUpsToday = vi.fn(async () => options.followUps ?? []);
  const seen = new Set<string>();
  const deps = {
    tasks: {
      get: async (id: string) => (options.followUps ?? []).find(task => task.id === id),
      list: async () => [],
      setStatus: async () => null,
      record: async () => null,
    },
    lists: {
      save: async (record: { taskIds: string[]; numbered: boolean }) => {
        saved.push(record);
        return record;
      },
      get: async () => undefined,
      latestNumbered: async () => undefined,
      setClosedByReaction: async () => {},
    },
    people: {
      async resolve(text: string): Promise<ResolveResult> {
        const key = text.trim().toLowerCase();
        const found = everyone.filter(p => p.name.toLowerCase().split(' ')[0] === key || p.name.toLowerCase() === key);
        if (found.length === 1) return { person: found[0], via: 'name' };
        return found.length ? { candidates: found } : null;
      },
      observe: async () => ({ kind: 'candidate', candidateId: 'c', asking: true }),
    },
    workspaces: async () => [],
    send: async (request: { text: string; replyTo?: string }) => {
      sent.push(request);
      return { messageId: `wa-${sent.length}` };
    },
    once: {
      begin: async (key: string) => !seen.has(key) && !!seen.add(key),
      finish: async () => {},
      fail: async () => {},
    },
    requestIdOf: async (key: string) => `req-${key}`,
    settings: async () => ({}),
    outbox: { get: async () => [], set: async () => {} },
    followUpsToday,
    ...(options.withReport === false ? {} : { report }),
    now: () => 1_000,
    warn: () => {},
  } as unknown as TaskDeskDeps;
  const desk = new TaskDesk(deps);
  let n = 0;
  const say = async (text: string) => {
    const handled = await desk.handle({ id: `his-${++n}`, quotedId: null, at: 5_000 }, text);
    return { handled, answer: sent.at(-1)?.text ?? '' };
  };
  return { desk, say, sent, saved, report, followUpsToday };
}

describe('TaskDesk: reports', () => {
  it('a name that is no known person goes to the chat', async () => {
    const s = setup({ people: [person('p-ada', 'Ada Example')] });
    const result = await s.say('the client says the deck is late');
    expect(result.handled).toBe(false);
    expect((await s.say('zed says the deck is late')).handled).toBe(false);
    expect(s.report).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
  });

  it('without a report hook, even a known person goes to the chat', async () => {
    const s = setup({ people: [person('p-ada', 'Ada Example')], withReport: false });
    expect((await s.say('ada says the deck is ready')).handled).toBe(false);
  });

  it('a known person calls report once, with their id and words, and sends its text', async () => {
    const s = setup({ people: [person('p-ada', 'Ada Example')] });
    const result = await s.say('ada says the deck is with design, ready thursday');
    expect(result.handled).toBe(true);
    expect(s.report).toHaveBeenCalledTimes(1);
    expect(s.report).toHaveBeenCalledWith({
      personId: 'p-ada',
      words: 'the deck is with design, ready thursday',
      messageId: 'his-1',
      at: 5_000,
    });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ text: 'Noted for Ada.', replyTo: 'his-1' });
    // Her "did" matches are numbered so "done 1" closes one
    expect(s.saved).toEqual([expect.objectContaining({ taskIds: ['tsk_aaaaaaaaaa'], numbered: true })]);
  });

  it('two people of that name: asks which, and reports nothing', async () => {
    const s = setup({ people: [person('p1', 'Ada One'), person('p2', 'Ada Two')] });
    const result = await s.say('ada says it is ready');
    expect(result.handled).toBe(true);
    expect(s.report).not.toHaveBeenCalled();
    expect(result.answer).toContain('Ada One');
    expect(result.answer).toContain('Ada Two');
  });

  it('the same message is never reported twice', async () => {
    const s = setup({ people: [person('p-ada', 'Ada Example')] });
    const message = { id: 'same-id', quotedId: null, at: 5_000 };
    expect(await s.desk.handle(message, 'ada says it is ready')).toBe(true);
    expect(await s.desk.handle(message, 'ada says it is ready')).toBe(true);
    expect(s.report).toHaveBeenCalledTimes(1);
    expect(s.sent).toHaveLength(1);
  });
});

describe("TaskDesk: who's next", () => {
  it('lists deps.followUpsToday()', async () => {
    const tasks = [
      makeTask({ id: 'tsk_bbbbbbbbbb', title: 'Chase the login', ownerName: 'Ada' }),
      makeTask({ id: 'tsk_cccccccccc', title: 'Chase the venue', ownerName: 'Ben' }),
    ];
    const s = setup({ followUps: tasks });
    const { handled, answer } = await s.say("who's next");
    expect(handled).toBe(true);
    expect(s.followUpsToday).toHaveBeenCalledTimes(1);
    expect(answer).toContain('*Follow up today*');
    expect(answer).toContain('1. Chase the login (Ada)');
    expect(answer).toContain('2. Chase the venue (Ben)');
  });

  it('says so when nothing is due', async () => {
    const s = setup();
    expect((await s.say("who's next")).answer).toBe('Nobody to follow up with today.');
  });
});
