import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObserveInput, Person, ResolveResult, Task, Workspace } from '@extension/storage';
import type { PendingTaskMessage } from '../task-desk';

vi.mock('@extension/i18n', async () => ({ t: (await import('@src/background/skills/__tests__/en')).enT }));

const { AviCopilotDb } = await import('@extension/storage/lib/threads/db');
const { createTaskStore, createTaskListStore, taskMarker } = await import('@extension/storage');
const { TaskDesk, LIST_MAX, splitDue } = await import('../task-desk');
const { DEFAULT_WHATSAPP_REMOTE_SETTINGS } = await import('../state');

// Tasks on WhatsApp (docs/pm-desk.md, Part 8), the extension half: numbered lists, numbers read in code against the
// right list, reactions, the brief, quiet hours and do-once keys. A real task store on a fake IndexedDB, a fake
// Ava Brain that keeps what it was sent, and a clock. No model anywhere. Made-up names throughout.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// Wednesday 18 November 2026, 10:00 local
const WED = new Date(2026, 10, 18, 10).getTime();

const workspace = (id: string, name: string, keywords: string[] = []): Workspace => ({
  id,
  name,
  about: '',
  keywords,
  accounts: {},
  createdAt: 0,
});

const person = (id: string, name: string, workspaceIds: string[] = [], aliases: Person['aliases'] = []): Person =>
  ({ id, name, aliases, workspaceIds, handles: [], emails: [], phones: [], seen: [] }) as unknown as Person;

function setup(options: { quiet?: boolean; people?: Person[]; workspaces?: Workspace[]; followUps?: Task[] } = {}) {
  const db = new AviCopilotDb(`wa-tasks-${crypto.randomUUID()}`);
  let now = WED;
  const tasks = createTaskStore(db, { now: () => now });
  const lists = createTaskListStore(db, { now: () => now });
  const sent: { text: string; kind: string; replyTo?: string; requestId: string; id: string }[] = [];
  let failSends = 0;
  // Runs inside the next send, as something else would while a message is going out
  let duringSend: (() => Promise<void>) | null = null;
  const once = new Map<string, 'started' | 'done' | 'failed'>();
  let outbox: PendingTaskMessage[] = [];
  const observed: ObserveInput[] = [];
  const everyone = options.people ?? [];
  const settings = {
    ...DEFAULT_WHATSAPP_REMOTE_SETTINGS,
    notify: { ...DEFAULT_WHATSAPP_REMOTE_SETTINGS.notify },
    ...(options.quiet === false ? { quietStart: '00:00', quietEnd: '00:00' } : {}),
  };
  const desk = new TaskDesk({
    tasks,
    lists,
    people: {
      // The store's rule in short: an exact name anywhere, else nothing; several are candidates
      async resolve(text): Promise<ResolveResult> {
        const key = text.trim().toLowerCase();
        const found = everyone.filter(
          p =>
            p.name.toLowerCase() === key ||
            p.name.toLowerCase().split(' ')[0] === key ||
            p.aliases.some(alias => alias.text.toLowerCase() === key),
        );
        if (found.length === 1) return { person: found[0], via: 'name' };
        return found.length ? { candidates: found } : null;
      },
      async observe(input) {
        observed.push(input);
        return { kind: 'candidate', candidateId: 'cand-1', asking: true };
      },
    },
    workspaces: async () => options.workspaces ?? [],
    send: async request => {
      const during = duringSend;
      duringSend = null;
      await during?.();
      if (failSends > 0) {
        failSends--;
        throw Object.assign(new Error('Ava has sent 20 WhatsApp messages in the last hour.'), { kind: 'rate_limit' });
      }
      const id = `wa-${sent.length + 1}`;
      sent.push({ ...request, id });
      return { messageId: id };
    },
    once: {
      async begin(key) {
        const state = once.get(key);
        if (state === 'started' || state === 'done') return false;
        once.set(key, 'started');
        return true;
      },
      async finish(key) {
        once.set(key, 'done');
      },
      async fail(key) {
        once.set(key, 'failed');
      },
    },
    requestIdOf: async key => `req-${key}`,
    settings: async () => settings,
    outbox: {
      get: async () => outbox,
      set: async items => {
        outbox = items;
      },
    },
    followUpsToday: async () => options.followUps ?? [],
    now: () => now,
    warn: () => {},
  });
  let n = 0;
  /** He sends words, received now (optionally quoting a message of hers). */
  const say = async (text: string, quotedId: string | null = null) => {
    now += 1000;
    const handled = await desk.handle({ id: `his-${++n}`, quotedId, at: now }, text);
    return { handled, answer: sent.at(-1)?.text ?? '' };
  };
  // Each a moment after the last, so "oldest first" has one answer
  const add = (title: string, fields: Partial<Task> = {}) => {
    now += 1;
    return tasks.add({ title, workspaceId: null, ...fields } as Parameters<typeof tasks.add>[0]);
  };
  return {
    db,
    desk,
    tasks,
    lists,
    sent,
    once,
    observed,
    settings,
    say,
    add,
    outbox: () => outbox,
    failNextSends: (count: number) => (failSends = count),
    duringNextSend: (run: () => Promise<void>) => (duringSend = run),
    setOutbox: (items: PendingTaskMessage[]) => (outbox = items),
    at: (time: number) => (now = time),
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe('numbered lists and the numbers he answers with', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('"tasks": open tasks, numbered, most urgent first, one line each, the marker stripped', async () => {
    await s.add('Book the room');
    s.advance(1000);
    await s.add('Send the login to Ada', { ownerName: 'Ada', due: '2026-11-20' } as Partial<Task>);
    s.advance(1000);
    await s.add(`Pay the venue${taskMarker('tsk_aaaaaaaaaa')}`, { due: '2026-11-17' } as Partial<Task>);
    const closed = await s.add('Old thing');
    await s.tasks.setStatus(closed.id, 'done', 'avi');
    const { handled, answer } = await s.say('tasks');
    expect(handled).toBe(true);
    expect(answer.split('\n')).toEqual([
      '*Open tasks*',
      '1. Pay the venue (overdue)',
      '2. Send the login to Ada (Ada, Fri)',
      '3. Book the room',
      '_Reply "done 2" to close one, "undo 2" to reopen it._',
    ]);
    expect(answer).not.toContain('tsk_');
    expect(s.sent.at(-1)).toMatchObject({ kind: 'reply', replyTo: 'his-1' });
    const list = await s.lists.get(s.sent.at(-1)!.id);
    expect(list?.numbered).toBe(true);
    expect(list?.taskIds).toHaveLength(3);
  });

  it('shows at most 15, and says how many more', async () => {
    for (let i = 1; i <= 20; i++) await s.add(`Task number ${String(i).padStart(2, '0')} for the launch`);
    const { answer } = await s.say('tasks');
    const lines = answer.split('\n').filter(line => /^\d+\. /.test(line));
    expect(lines).toHaveLength(LIST_MAX);
    expect(answer).toContain('…and 5 more on the Tasks page.');
  });

  it('a title from outside is one plain line: no link, no formatting, no marker', async () => {
    await s.add('Read *this* https://evil.example/x now _please_');
    const { answer } = await s.say('tasks');
    expect(answer).toContain('1. Read this now please');
    expect(answer).not.toMatch(/https?:|evil\.example/);
  });

  it('"done 2" closes the second task of the list and says so, struck through', async () => {
    const one = await s.add('Book the room');
    s.advance(1000);
    const two = await s.add('Send the deck');
    await s.say('tasks');
    const { answer } = await s.say('done 2');
    expect(answer).toBe('Done: ~Send the deck~');
    expect((await s.tasks.get(two.id))?.status).toBe('done');
    expect((await s.tasks.get(two.id))?.doneBy).toBe('avi');
    expect((await s.tasks.get(one.id))?.status).toBe('open');
  });

  it('"2 done" and "done 2 4 5"', async () => {
    const made = [];
    for (const title of ['One task', 'Two task', 'Three task', 'Four task', 'Five task']) {
      made.push(await s.add(title));
      s.advance(1000);
    }
    await s.say('tasks');
    await s.say('2 done');
    expect((await s.tasks.get(made[1].id))?.status).toBe('done');
    const { answer } = await s.say('done 3 4 5');
    expect(answer).toBe('Done: \n~Three task~\n~Four task~\n~Five task~');
    expect((await s.tasks.get(made[0].id))?.status).toBe('open');
  });

  it('"undo 2" and "reopen 2" reopen; "drop 2" drops', async () => {
    await s.add('Book the room');
    s.advance(1000);
    const two = await s.add('Send the deck');
    await s.say('tasks');
    await s.say('done 2');
    expect((await s.say('undo 2')).answer).toBe('Reopened: Send the deck');
    expect((await s.tasks.get(two.id))?.status).toBe('open');
    await s.say('done 2');
    await s.say('reopen 2');
    expect((await s.tasks.get(two.id))?.status).toBe('open');
    expect((await s.say('drop 2')).answer).toBe('Dropped: ~Send the deck~');
    expect((await s.tasks.get(two.id))?.status).toBe('dropped');
    expect((await s.say('drop 2')).answer).toBe('Already like that: Send the deck');
  });

  it('a number the list does not have is asked about, and nothing changes', async () => {
    const made = [];
    for (let i = 1; i <= 6; i++) made.push(await s.add(`Task ${i} of the week`));
    await s.say('tasks');
    expect((await s.say('done 7')).answer).toBe('That list has 6 tasks. Which one?');
    expect((await s.say('done 2 9')).answer).toBe('That list has 6 tasks. Which one?');
    for (const task of made) expect((await s.tasks.get(task.id))?.status).toBe('open');
  });

  it('with no list yet, or quoting a message that is not one, he is asked rather than guessed for', async () => {
    await s.add('Book the room');
    expect((await s.say('done 1')).answer).toBe(
      'I haven\'t sent you a numbered list yet. Send "tasks" and I\'ll send one.',
    );
    await s.say('tasks');
    expect((await s.say('done 1', 'some-other-message')).answer).toBe(
      'That message has no numbered tasks. Send "tasks" for a list.',
    );
    expect((await s.tasks.list({ status: 'open' })).length).toBe(1);
  });

  it('a quoted reply uses the quoted list, however old; a bare number the latest', async () => {
    const lastWeek = [await s.add('Last week first'), await s.add('Last week second')];
    await s.say('tasks');
    const oldList = s.sent.at(-1)!.id;
    await s.tasks.setStatus(lastWeek[0].id, 'done', 'avi');
    await s.tasks.setStatus(lastWeek[1].id, 'done', 'avi');
    s.advance(7 * DAY);
    const thisWeek = await s.add('This week first');
    await s.say('tasks');
    // "undo 1" quoting last week's list reopens that week's first task
    expect((await s.say('undo 1', oldList)).answer).toBe('Reopened: Last week first');
    expect((await s.tasks.get(lastWeek[0].id))?.status).toBe('open');
    // A bare number reads the latest list
    await s.say('done 1');
    expect((await s.tasks.get(thisWeek.id))?.status).toBe('done');
    expect((await s.tasks.get(lastWeek[0].id))?.status).toBe('open');
  });

  it('a bare number never reads a list sent after he wrote, nor a one-task confirmation', async () => {
    const first = await s.add('First of the old list');
    await s.say('tasks');
    const wroteAt = s.now() + 500;
    // A new list goes out after his message came in, but is kept before it is read
    s.advance(1000);
    await s.add('Brand new task');
    await s.desk.sendTaskList({
      key: 'k-1',
      title: 'Tasks for Ada',
      taskIds: [(await s.add('Ada thing')).id],
      hint: true,
    });
    await s.desk.handle({ id: 'late', quotedId: null, at: wroteAt }, 'done 1');
    expect((await s.tasks.get(first.id))?.status).toBe('done');
    // "Added: …" carries one task but is no numbered list
    await s.say('task for Kunle: call the venue');
    await s.say('tasks');
    const list = await s.lists.get(s.sent.at(-1)!.id);
    await s.say('done 1');
    expect((await s.tasks.get(list!.taskIds[0]))?.status).toBe('done');
  });

  it('a task closed elsewhere, or no longer on the board, is said so', async () => {
    const task = await s.add('Book the room');
    await s.say('tasks');
    await s.tasks.setStatus(task.id, 'done', 'avi');
    expect((await s.say('done 1')).answer).toBe('Already like that: Book the room');
    await s.db.tasks.delete(task.id);
    expect((await s.say('done 1')).answer).toBe('No longer on the board: 1');
  });

  it('acts on a message once, whatever pulls it again', async () => {
    const task = await s.add('Book the room');
    await s.say('tasks');
    const message = { id: 'his-once', quotedId: null, at: s.now() + 1 };
    await s.desk.handle(message, 'done 1');
    await s.tasks.setStatus(task.id, 'open', 'avi');
    const sends = s.sent.length;
    expect(await s.desk.handle(message, 'done 1')).toBe(true);
    expect(s.sent.length).toBe(sends);
    expect((await s.tasks.get(task.id))?.status).toBe('open');
  });

  it('leaves anything else to the chat', async () => {
    expect((await s.say('what is on today?')).handled).toBe(false);
    expect(s.sent).toEqual([]);
  });
});

describe('tasks for a person or a workspace', () => {
  const ada = person('per_ada', 'Ada Obi', ['ws-ember'], [{ text: 'Adaeze', workspaceId: null, from: 'avi' }]);
  const ember = workspace('ws-ember', 'Tech Ember', ['ember']);
  const nexa = workspace('ws-nexa', 'Nexa', ['nexa']);

  it('"tasks ada": a person first, with tasks linked to them or given to a name they go by', async () => {
    const s = setup({ people: [ada], workspaces: [ember, nexa] });
    await s.add('Linked one', { ownerId: 'per_ada', ownerName: 'Ada Obi' } as Partial<Task>);
    s.advance(1000);
    await s.add('Said by alias', { ownerName: 'Adaeze' } as Partial<Task>);
    await s.add('Someone else', { ownerName: 'Kunle' } as Partial<Task>);
    const { answer } = await s.say('tasks ada');
    expect(answer.split('\n').slice(0, 3)).toEqual(['*Tasks for Ada Obi*', '1. Linked one', '2. Said by alias']);
    expect(answer).not.toContain('Someone else');
  });

  it('"tasks ember": a workspace by keyword or name', async () => {
    const s = setup({ people: [ada], workspaces: [ember, nexa] });
    await s.add('Ember task', { workspaceId: 'ws-ember' });
    await s.add('Nexa task', { workspaceId: 'ws-nexa' });
    const { answer } = await s.say('tasks ember');
    expect(answer).toContain('*Open tasks in Tech Ember*');
    expect(answer).toContain('1. Ember task');
    expect(answer).not.toContain('Nexa task');
    expect((await s.say('tasks tech ember')).answer).toContain('Ember task');
  });

  it('a word that fits both a person and a workspace is asked about', async () => {
    const nova = person('per_nova', 'Nova Lin');
    const s = setup({ people: [nova], workspaces: [workspace('ws-nova', 'Nova')] });
    await s.add('Something', { workspaceId: 'ws-nova' });
    const { answer } = await s.say('tasks nova');
    expect(answer).toBe(
      'Do you mean Nova Lin or the Nova workspace? Send "tasks for nova" for the person or "tasks in nova" for the workspace.',
    );
    expect((await s.say('tasks for nova')).answer).toContain('No open tasks for Nova Lin.');
    expect((await s.say('tasks in nova')).answer).toContain('Open tasks in Nova');
  });

  it('two people of one name are asked about, never one picked; an unknown name after "for" is said so', async () => {
    const s = setup({ people: [person('per_1', 'Ada Obi'), person('per_2', 'Ada Lin')] });
    expect((await s.say('tasks ada')).answer).toBe(
      '2 people go by "ada": Ada Obi, Ada Lin. Send "tasks for" and their full name.',
    );
    expect((await s.say('tasks for zed')).answer).toBe('I don\'t know anyone called "zed".');
  });

  it('"tasks are piling up" names no one: it goes to the chat, unanswered here and with no do-once key', async () => {
    const s = setup({ people: [ada], workspaces: [ember] });
    expect((await s.say('tasks are piling up')).handled).toBe(false);
    expect((await s.say('tasks zed')).handled).toBe(false);
    expect(s.sent).toEqual([]);
    expect(s.once.size).toBe(0);
  });
});

describe('"task for ada: …"', () => {
  it('adds a task with its owner and due date worked out in code', async () => {
    const ada = person('per_ada', 'Ada Obi', ['ws-ember']);
    const s = setup({ people: [ada], workspaces: [workspace('ws-ember', 'Tech Ember')] });
    const { answer } = await s.say('task for ada: send the deck by friday');
    expect(answer).toBe('Added: Send the deck (Ada Obi, Fri)');
    const [task] = await s.tasks.list({ status: 'open' });
    expect(task).toMatchObject({
      title: 'Send the deck',
      ownerId: 'per_ada',
      ownerName: 'Ada Obi',
      due: '2026-11-20',
      dueText: 'by friday',
      workspaceId: 'ws-ember',
      workspaceSetBy: 'ava',
      source: { kind: 'whatsapp', id: 'his-1' },
    });
    expect(s.observed).toEqual([]);
    // A ✅ on the answer closes it
    await s.desk.reaction({ targetId: s.sent.at(-1)!.id, emoji: '✅' });
    expect((await s.tasks.get(task.id))?.status).toBe('done');
  });

  it('keeps an unknown owner as he wrote it and asks People who it is', async () => {
    const s = setup();
    await s.say('task for Kunle: call the venue tomorrow');
    const [task] = await s.tasks.list({ status: 'open' });
    expect(task).toMatchObject({ title: 'Call the venue', ownerName: 'Kunle', ownerId: null, due: '2026-11-19' });
    expect(s.observed).toEqual([
      expect.objectContaining({ text: 'Kunle', source: 'whatsapp', taskId: task.id, ref: 'whatsapp|his-1' }),
    ]);
  });

  it('the same task twice is one task', async () => {
    const s = setup();
    await s.say('task for Kunle: call the venue');
    expect((await s.say('task for Kunle: call the venue')).answer).toBe('Already on the board: Call the venue (Kunle)');
    expect(await s.tasks.list({ status: 'open' })).toHaveLength(1);
  });

  it.each([
    ['send the deck by friday', 'send the deck', '2026-11-20'],
    ['call the venue tomorrow', 'call the venue', '2026-11-19'],
    ['review the plan in 3 days', 'review the plan', '2026-11-21'],
    ['book flights by Nov 28', 'book flights', '2026-11-28'],
    ['add slides in the deck', 'add slides in the deck', undefined],
    ['send deck 2', 'send deck 2', undefined],
    ['call friday morning about it', 'call friday morning about it', '2026-11-20'],
    // A short day name alone is a word; after "by" or "on" it is a day
    ['buy cream for the sun', 'buy cream for the sun', undefined],
    ['wed the deck and the notes', 'wed the deck and the notes', undefined],
    ['call ada by fri', 'call ada', '2026-11-20'],
    ['pay the venue on the 3rd of december', 'pay the venue', '2026-12-03'],
  ])('"%s" is "%s", due %s', (words, title, due) => {
    expect(splitDue(words, WED)).toEqual(due ? expect.objectContaining({ title, due }) : { title });
  });
});

describe('who is next', () => {
  it('says when nobody is due for a follow-up', async () => {
    const s = setup();
    expect((await s.say("who's next")).answer).toBe('Nobody to follow up with today.');
  });

  it('lists what the follow-ups hook gives, numbered like any list', async () => {
    const s = setup();
    const task = await s.add('Chase the login', { ownerName: 'Ada' } as Partial<Task>);
    const desk = setup({ followUps: [task] });
    expect((await desk.say("who's next")).answer).toContain('*Follow up today*\n1. Chase the login (Ada)');
  });
});

describe('reactions', () => {
  it('a ✅ or 👍 on a one-task message closes it; taking it back reopens it', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    await s.desk.sendTaskList({ key: 'after-call:ada', title: 'Tasks for Ada', taskIds: [task.id] });
    const message = s.sent.at(-1)!.id;
    await s.desk.reaction({ targetId: message, emoji: '✅' });
    expect((await s.tasks.get(task.id))?.status).toBe('done');
    await s.desk.reaction({ targetId: message, emoji: '' });
    expect((await s.tasks.get(task.id))?.status).toBe('open');
    await s.desk.reaction({ targetId: message, emoji: '👍🏽' });
    expect((await s.tasks.get(task.id))?.status).toBe('done');
    // Changed to another emoji: no longer a ✅
    await s.desk.reaction({ targetId: message, emoji: '❤️' });
    expect((await s.tasks.get(task.id))?.status).toBe('open');
  });

  it('changes nothing on a list of several, on a message that is not a list, or with another emoji', async () => {
    const s = setup({ quiet: false });
    const one = await s.add('One task');
    const two = await s.add('Two task');
    await s.say('tasks');
    await s.desk.reaction({ targetId: s.sent.at(-1)!.id, emoji: '✅' });
    await s.desk.reaction({ targetId: 'not-a-list', emoji: '✅' });
    await s.desk.sendTaskList({ key: 'k', title: 'Tasks for Ada', taskIds: [one.id] });
    await s.desk.reaction({ targetId: s.sent.at(-1)!.id, emoji: '🔥' });
    for (const task of [one, two]) expect((await s.tasks.get(task.id))?.status).toBe('open');
  });

  it('a 👍 on her answer or on the brief is "ok" and closes nothing; a ✅ there does', async () => {
    const s = setup({ quiet: false });
    await s.say('task for Kunle: send the deck by friday');
    const added = s.sent.at(-1)!.id;
    const [task] = await s.tasks.list({ status: 'open' });
    await s.desk.reaction({ targetId: added, emoji: '👍' });
    expect((await s.tasks.get(task.id))?.status).toBe('open');
    await s.desk.sendBrief('*Brief*', 'brief:t-ok');
    await s.desk.reaction({ targetId: s.sent.at(-1)!.id, emoji: '👍🏾' });
    expect((await s.tasks.get(task.id))?.status).toBe('open');
    await s.desk.reaction({ targetId: added, emoji: '✅' });
    expect((await s.tasks.get(task.id))?.status).toBe('done');
  });

  it('taking back a reaction never reopens a task it did not close', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    await s.desk.sendTaskList({ key: 'k', title: 'Tasks for Ada', taskIds: [task.id] });
    await s.tasks.setStatus(task.id, 'done', 'avi');
    await s.desk.reaction({ targetId: s.sent.at(-1)!.id, emoji: '' });
    expect((await s.tasks.get(task.id))?.status).toBe('done');
  });
});

describe('lists Ava sends first: quiet hours, the toggle, do-once keys', () => {
  it('a call ending at 23:00 sends its task list at 07:00, once', async () => {
    const s = setup();
    const task = await s.add('Send the deck', { ownerName: 'Ada' } as Partial<Task>);
    s.at(new Date(2026, 10, 18, 23, 0).getTime());
    expect(await s.desk.sendTaskList({ key: 'after-call:m-1:ada', title: 'Tasks for Ada', taskIds: [task.id] })).toBe(
      'queued',
    );
    await s.desk.flush();
    s.at(new Date(2026, 10, 19, 3, 0).getTime());
    await s.desk.flush();
    expect(s.sent).toEqual([]);
    s.at(new Date(2026, 10, 19, 7, 0).getTime());
    await s.desk.flush();
    s.advance(60_000);
    await s.desk.flush();
    await s.desk.sendTaskList({ key: 'after-call:m-1:ada', title: 'Tasks for Ada', taskIds: [task.id] });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ kind: 'tasks', text: '*Tasks for Ada*\n1. Send the deck' });
    expect(s.outbox()).toEqual([]);
    // Kept, so a quoted "done 1" and a ✅ work on it
    expect((await s.lists.get(s.sent[0].id))?.taskIds).toEqual([task.id]);
  });

  it('an answer to what he just sent goes at once, in quiet hours too', async () => {
    const s = setup();
    await s.add('Send the deck');
    s.at(new Date(2026, 10, 18, 23, 30).getTime());
    await s.say('tasks');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].kind).toBe('reply');
  });

  it('a list that could not go is tried again with the same request id, and still goes once', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    s.failNextSends(1);
    s.at(new Date(2026, 10, 18, 23, 0).getTime());
    s.settings.quietStart = '22:00';
    s.settings.quietEnd = '07:00';
    await s.desk.sendTaskList({ key: 'k-retry', title: 'Tasks for Ada', taskIds: [task.id] });
    s.at(new Date(2026, 10, 19, 7, 0).getTime());
    await s.desk.flush();
    expect(s.sent).toEqual([]);
    expect(s.outbox()).toHaveLength(1);
    s.advance(60_000);
    await s.desk.flush();
    s.advance(60_000);
    await s.desk.flush();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].requestId).toBe('req-whatsapp.tasks:k-retry');
  });

  it('a list that fails outside quiet hours waits in the outbox and goes on the next poll', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    s.failNextSends(1);
    expect(await s.desk.sendTaskList({ key: 'k-fail', title: 'Tasks for Ada', taskIds: [task.id] })).toBe('queued');
    expect(s.outbox()).toHaveLength(1);
    s.advance(60_000);
    await s.desk.flush();
    expect(s.sent).toHaveLength(1);
    expect(s.outbox()).toEqual([]);
  });

  it('a list queued again while the outbox is being sent is kept for the next poll', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    const item = { key: 'k-again', title: 'Tasks for Ada', taskIds: [task.id] };
    s.setOutbox([{ ...item, at: s.now() }]);
    s.advance(1000);
    // While the first goes out, the same key is queued again (a newer list for the same call)
    s.duringNextSend(async () => {
      s.setOutbox([...s.outbox(), { ...item, title: 'Tasks for Ada (updated)', at: s.now() }]);
    });
    await s.desk.flush();
    expect(s.outbox()).toEqual([expect.objectContaining({ key: 'k-again', title: 'Tasks for Ada (updated)' })]);
  });

  it('a sent list is kept before its do-once key is closed', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    const states: (string | undefined)[] = [];
    const save = s.lists.save.bind(s.lists);
    vi.spyOn(s.lists, 'save').mockImplementation(async record => {
      states.push(s.once.get('whatsapp.tasks:k-order'));
      return save(record);
    });
    await s.desk.sendTaskList({ key: 'k-order', title: 'Tasks for Ada', taskIds: [task.id] });
    expect(states).toEqual(['started']);
    expect(s.once.get('whatsapp.tasks:k-order')).toBe('done');
  });

  it('lists for forwarding after the brief never take his bare "done 2" from the brief', async () => {
    const s = setup({ quiet: false });
    const first = await s.add('Brief one');
    const second = await s.add('Brief two');
    await s.desk.sendBrief('*Brief*', 'brief:t-burst');
    s.advance(1000);
    for (const name of ['Ada', 'Kunle', 'Bisi']) {
      const own = await s.add(`${name} thing one`);
      const other = await s.add(`${name} thing two`);
      await s.desk.sendTaskList({ key: `after-call:${name}`, title: `Tasks for ${name}`, taskIds: [own.id, other.id] });
    }
    await s.say('done 2');
    expect((await s.tasks.get(second.id))?.status).toBe('done');
    expect((await s.tasks.get(first.id))?.status).toBe('open');
    // Quoting one of them still works
    const kunle = s.sent.find(message => message.text.startsWith('*Tasks for Kunle*'))!;
    await s.say('done 1', kunle.id);
    expect(s.sent.at(-1)!.text).toBe('Done: ~Kunle thing one~');
  });

  it('a list he switched off is not sent or kept; one whose tasks are all closed is not sent', async () => {
    const s = setup({ quiet: false });
    const task = await s.add('Send the deck');
    s.settings.notify.tasks = false;
    expect(await s.desk.sendTaskList({ key: 'a', title: 'Tasks for Ada', taskIds: [task.id] })).toBe('off');
    s.settings.notify.tasks = true;
    await s.tasks.setStatus(task.id, 'done', 'avi');
    expect(await s.desk.sendTaskList({ key: 'b', title: 'Tasks for Ada', taskIds: [task.id] })).toBe('empty');
    expect(s.sent).toEqual([]);
  });
});

describe('the morning brief', () => {
  it('gains "Open tasks" (top 10), numbered so "done 2" works on it, sent once', async () => {
    const s = setup({ quiet: false });
    const made = [];
    for (let i = 1; i <= 12; i++) {
      made.push(await s.add(`Brief task ${String(i).padStart(2, '0')} to do`));
      s.advance(1000);
    }
    expect(await s.desk.sendBrief('*Your brief is ready*\n\n3 meetings today.', 'brief:t-1')).toBe(true);
    expect(await s.desk.sendBrief('*Your brief is ready*\n\n3 meetings today.', 'brief:t-1')).toBe(false);
    expect(s.sent).toHaveLength(1);
    const text = s.sent[0].text;
    expect(text.startsWith('*Your brief is ready*\n\n3 meetings today.\n\n*Open tasks*\n1. Brief task 01 to do')).toBe(
      true,
    );
    expect(text).toContain('10. Brief task 10 to do');
    expect(text).not.toContain('11. ');
    expect(s.sent[0].kind).toBe('brief');
    await s.say('done 2');
    expect((await s.tasks.get(made[1].id))?.status).toBe('done');
  });

  it('carries "Follow up today" from the follow-ups hook, numbered on from the open tasks', async () => {
    const other = setup();
    const chase = await other.add('Chase the login', { ownerName: 'Ada' } as Partial<Task>);
    const s = setup({ quiet: false, followUps: [chase] });
    await s.add('Book the room');
    await s.desk.sendBrief('*Brief*', 'brief:t-2');
    expect(s.sent[0].text).toContain('*Open tasks*\n1. Book the room');
    expect(s.sent[0].text).toContain('*Follow up today*\n2. Chase the login (Ada)');
  });

  it('with no open tasks, is the brief as it was', async () => {
    const s = setup({ quiet: false });
    await s.desk.sendBrief('*Brief*', 'brief:t-3');
    expect(s.sent[0].text).toBe('*Brief*');
  });
});

describe('no model', () => {
  it('nothing on this path imports a model or the agent', () => {
    for (const file of ['task-desk.ts', 'task-commands.ts']) {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(source).not.toMatch(/from '\.\.\/(llm|agent)|generateText|generatePlainText|streamText/);
    }
  });
});
