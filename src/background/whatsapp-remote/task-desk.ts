import { t } from '@extension/i18n';
import {
  byDueThenAge,
  dueFromText,
  isoDay,
  normaliseTitle,
  routeWorkspace,
  stripTaskMarkers,
} from '@extension/storage';
import type {
  ObserveInput,
  ObserveResult,
  Person,
  ResolveResult,
  Task,
  TaskCandidate,
  TaskListQuery,
  TaskListRecord,
  TaskStatus,
  Workspace,
} from '@extension/storage';
import type { WhatsAppMessage, WhatsAppNoticeKind, WhatsAppReaction } from '@src/shared/lib/protocol/companion';
import { plainOutside } from './format';
import { inQuietHours } from './notices';
import type { WhatsAppRemoteSettings } from './state';
import { taskCommandOf } from './task-commands';
import type { TaskCommand, TaskStatusWord } from './task-commands';

/**
 * Tasks on WhatsApp (docs/pm-desk.md, Part 8). Every task list Ava sends is numbered and kept by message id in
 * `taskLists`; Avi answers with the numbers ("done 2"), and the answer is worked out here, in code: no model reads
 * his words or picks a task. A bare number means the latest numbered list, a quoted reply the list he quoted, and a
 * number that list does not have is asked about, never guessed. A ✅ or 👍 on a message that carries one task
 * closes it; taking the reaction back reopens it.
 *
 * Only the owner's words and reactions reach this: Ava Brain drops everything from anyone else before it is kept
 * (companion/src/whatsapp/service.ts). Lists Ava sends first (kind 'tasks') wait out quiet hours and go once
 * after; answers go at once. Every message goes out under a do-once key. Nothing here logs a title, a name or a
 * number.
 */

// The most tasks one list shows, and the morning brief's share
export const LIST_MAX = 15;
export const BRIEF_MAX = 10;
// A message held for quiet hours that still cannot go a day later is let go
const OUTBOX_MAX_MS = 24 * 60 * 60_000;
const OUTBOX_MAX = 30;
// The reactions that close a one-task message; skin tones and the emoji presentation mark do not matter
const CHECK = '✅';
const THUMBS = '👍';
const DAY = 24 * 60 * 60 * 1000;

/** A task list waiting for quiet hours to end. Ids and the list's title only; the words are drawn when it goes. */
export interface PendingTaskMessage {
  key: string;
  title: string;
  taskIds: string[];
  // A line under the list (a recording link, from #108), already plain
  note?: string;
  // The reply hint ("Reply done 2…"); off for a list meant to be forwarded
  hint?: boolean;
  at: number;
}

export interface TaskDeskDeps {
  tasks: {
    get(id: string): Promise<Task | undefined>;
    list(query: TaskListQuery): Promise<Task[]>;
    setStatus(id: string, status: TaskStatus, by: 'avi' | 'ava'): Promise<Task | null>;
    record(candidate: TaskCandidate): Promise<{ task: Task; added: boolean } | null>;
  };
  lists: {
    save(record: Omit<TaskListRecord, 'sentAt'>): Promise<TaskListRecord>;
    get(messageId: string): Promise<TaskListRecord | undefined>;
    latestNumbered(before?: number): Promise<TaskListRecord | undefined>;
    setClosedByReaction(messageId: string, closed: boolean): Promise<void>;
  };
  people: {
    resolve(text: string, options: { workspaceId: string | null }): Promise<ResolveResult>;
    observe(input: ObserveInput): Promise<ObserveResult>;
  };
  workspaces: () => Promise<Workspace[]>;
  // To him through Ava Brain: the id of the message that went out (null when the client gave none)
  send: (request: {
    requestId: string;
    text: string;
    kind: WhatsAppNoticeKind;
    replyTo?: string;
  }) => Promise<{ messageId: string | null }>;
  // Do-once (src/background/once): begin is true when the key may act now; finish once it went, fail when it
  // certainly did not (it may then be tried again)
  once: {
    begin(key: string): Promise<boolean>;
    finish(key: string): Promise<void>;
    fail(key: string): Promise<void>;
  };
  // The same request id for the same key, so Ava Brain takes a retried send as the one before
  requestIdOf: (key: string) => Promise<string>;
  settings: () => Promise<WhatsAppRemoteSettings>;
  outbox: { get(): Promise<PendingTaskMessage[]>; set(items: PendingTaskMessage[]): Promise<void> };
  // HOOK (#111, docs/pm-desk.md Part 9): who is due a follow-up today, most overdue first. Returns none until the
  // follow-ups part exists; "who's next" and the brief's "Follow up today" read it.
  followUpsToday: () => Promise<Task[]>;
  // What Avi reports a person said (#111, Part 9.3): kept as their update, the follow-up clock restarted. Returns the
  // answer to send and, when the update's "did" matches open tasks of theirs, those tasks to number ("done 1")
  report?: (input: {
    personId: string;
    words: string;
    messageId: string;
    at: number;
  }) => Promise<{ text: string; taskIds: string[] }>;
  now: () => number;
  warn: (message: string, error?: unknown) => void;
}

/** A task's words as a WhatsApp line: its marker out, plain (no links, no formatting marks), one line. */
export function taskTitleText(title: string, max = 120): string {
  return plainOutside(stripTaskMarkers(title), max).replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || '…';
}

const nameText = (name: string) => plainOutside(name, 40).replace(/_/g, ' ').trim();

/** A due date as he reads it: "overdue", "today", "tomorrow", "Fri" within the week, else "28 Nov". */
export function dueLabel(due: string, now: number): string {
  const today = isoDay(now);
  if (due < today) return t('wava_tasks_overdue');
  if (due === today) return t('wava_tasks_dueToday');
  if (due === isoDay(now + DAY)) return t('wava_tasks_dueTomorrow');
  const [year, month, day] = due.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  if (date.getTime() - now < 6 * DAY) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "3. Send the login to Ada (Ada, Fri)": its number, words, owner when the list is not one person's, due. */
export function taskListLine(task: Task, number: number, options: { now: number; owner: boolean }): string {
  const details = [
    options.owner && task.ownerName ? nameText(task.ownerName) : '',
    task.due ? dueLabel(task.due, options.now) : '',
  ].filter(Boolean);
  return `${number}. ${taskTitleText(task.title)}${details.length ? ` (${details.join(', ')})` : ''}`;
}

/** A numbered list: its title, at most LIST_MAX lines, how many more, and how to answer. */
export function taskListText(
  title: string,
  tasks: Task[],
  options: { now: number; owner: boolean; hint?: boolean; total?: number; start?: number; max?: number },
): { text: string; taskIds: string[] } {
  const shown = tasks.slice(0, options.max ?? LIST_MAX);
  const total = options.total ?? tasks.length;
  const start = options.start ?? 1;
  const lines = [
    `*${title}*`,
    ...shown.map((task, index) => taskListLine(task, start + index, options)),
    ...(total > shown.length ? [t('wava_tasks_more', [String(total - shown.length)])] : []),
    ...(options.hint === false ? [] : [`_${t('wava_tasks_hint')}_`]),
  ];
  return { text: lines.join('\n'), taskIds: shown.map(task => task.id) };
}

/** The emoji without skin tone or presentation marks, so 👍🏽 counts as 👍. */
const bareEmoji = (emoji: string) => emoji.replace(/[\u{1F3FB}-\u{1F3FF}]|\u{FE0E}|\u{FE0F}/gu, '').trim();

const localId = () => `local:${crypto.randomUUID()}`;

const errorText = (error: unknown) => plainOutside(error instanceof Error ? error.message : String(error), 200);

// A short day name ("sun", "wed", "sat") counts only after "by", "on", "next" and the like: alone it is a word
const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const SHORT_DAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_WORDS =
  `(?:(?:by|on|before|due|until|till)\\s+(?:next\\s+|this\\s+)?${SHORT_DAY}\\b` +
  `|(?:(?:by|on|before|due|until|till|for)\\s+(?:the\\s+)?)?(?:today|tonight|tomorrow|tmrw|eod|eow|end of (?:the )?(?:day|week|month)` +
  `|(?:next|this)\\s+(?:${WEEKDAY}|${SHORT_DAY}\\b)|${WEEKDAY}|in (?:\\d{1,3}|a|one|two|three) (?:days?|weeks?)` +
  `|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}|\\d{4}-\\d{2}-\\d{2}))`;
// The task's words, then a date and nothing after it; a date anywhere in them
const ENDS_WITH_DATE = new RegExp(`^(.*?)[\\s,;:–—-]+(${DATE_WORDS})[\\s.!]*$`, 'iu');
const DATE_INSIDE = new RegExp(`(?:^|[\\s,;:–—-])(${DATE_WORDS})(?=$|[\\s.,;:!?])`, 'iu');

/**
 * Splits "send the deck by friday" into the task and its due date, when the words end with one; otherwise the words
 * stay whole and a date inside them ("friday morning") is still read.
 */
export function splitDue(words: string, now: number): { title: string; due?: string; dueText?: string } {
  const text = words.trim().replace(/\s+/g, ' ');
  const match = ENDS_WITH_DATE.exec(text);
  const due = match ? dueFromText(match[2], now) : undefined;
  if (match && due && match[1].trim().length >= 2) return { title: match[1].trim(), due, dueText: match[2] };
  // A date inside the words ("friday morning") is still read, the words left whole
  const found = DATE_INSIDE.exec(text);
  const inside = found ? dueFromText(found[1], now) : undefined;
  return inside ? { title: text, due: inside } : { title: text };
}

type Answer = { text: string; list?: { taskIds: string[]; numbered: boolean } };

export class TaskDesk {
  private flushing: Promise<void> | null = null;

  constructor(private readonly deps: TaskDeskDeps) {}

  /**
   * His whole message as a task command, answered on WhatsApp right away: true when it was one (even when the
   * answer could not go), false when it is anything else and goes to the chat. The same message is never acted on
   * twice: its id is the do-once key.
   */
  async handle(message: Pick<WhatsAppMessage, 'id' | 'quotedId' | 'at'>, words: string): Promise<boolean> {
    const command = taskCommandOf(words);
    if (!command) return false;
    // "tasks are piling up" names no one: it is chat, not a command (only reading, so before the do-once key)
    if (command.kind === 'list' && command.word && !command.as && !(await this.names(command.word).catch(() => true)))
      return false;
    // "the client says hi" names no one he knows: chat too. Only a person's name makes it a report
    if (
      command.kind === 'says' &&
      (!this.deps.report || !(await this.peopleCalled(command.name).catch(() => [])).length)
    )
      return false;
    const key = `whatsapp.tasks.reply:${message.id}`;
    if (!(await this.deps.once.begin(key))) return true;
    let answer: Answer;
    try {
      answer = await this.run(command, message, words);
    } catch (error) {
      this.deps.warn('A WhatsApp task command failed', error);
      answer = { text: t('wava_command_failed', [errorText(error)]) };
    }
    try {
      const { messageId } = await this.deps.send({
        requestId: await this.deps.requestIdOf(key),
        text: answer.text,
        kind: 'reply',
        replyTo: message.id,
      });
      if (answer.list?.taskIds.length)
        await this.deps.lists.save({ messageId: messageId ?? localId(), ...answer.list, kind: 'answer' });
    } catch (error) {
      // Not linked, the hourly cap, Ava Brain closed: what he asked for is done, its answer is lost
      this.deps.warn('A WhatsApp task answer was not sent', error);
    }
    // The change is made either way: the message is never acted on again
    await this.deps.once.finish(key);
    return true;
  }

  /**
   * His ✅ on a message that carries one task closes it, and so does a 👍 on one Ava sent first; taking it back (or
   * changing it) reopens it. A 👍 on her answer ("Added: …") or on the brief is him saying "ok", and changes nothing.
   */
  async reaction(reaction: Pick<WhatsAppReaction, 'targetId' | 'emoji'>): Promise<void> {
    const record = await this.deps.lists.get(reaction.targetId);
    if (!record || record.taskIds.length !== 1) return;
    const task = await this.deps.tasks.get(record.taskIds[0]);
    if (!task) return;
    const emoji = bareEmoji(reaction.emoji);
    if (emoji === CHECK || (emoji === THUMBS && record.kind === 'list')) {
      if (task.status !== 'open') return;
      await this.deps.tasks.setStatus(task.id, 'done', 'avi');
      await this.deps.lists.setClosedByReaction(record.messageId, true);
      return;
    }
    // Only a close this reaction made is undone by taking it back
    if (!record.closedByReaction) return;
    if (task.status === 'done') await this.deps.tasks.setStatus(task.id, 'open', 'avi');
    await this.deps.lists.setClosedByReaction(record.messageId, false);
  }

  private async run(command: TaskCommand, message: Pick<WhatsAppMessage, 'id' | 'quotedId' | 'at'>, words: string) {
    if (command.kind === 'set') {
      return this.setByNumbers(command.status, command.numbers, message.quotedId ?? null, message.at);
    }
    if (command.kind === 'list') return this.listFor(command.word, command.as);
    if (command.kind === 'add') return this.add(command.owner, command.words, message.id, words);
    if (command.kind === 'says') return this.says(command.name, command.words, message);
    return this.next();
  }

  // ── done 2 · undo 2 · drop 2 ──

  private async setByNumbers(
    status: TaskStatusWord,
    numbers: number[],
    quotedId: string | null,
    // When his message came: a bare number means the latest list he could have seen then
    at: number,
  ): Promise<Answer> {
    const list = quotedId
      ? await this.deps.lists.get(quotedId)
      : await this.deps.lists.latestNumbered(at > 0 ? at : undefined);
    if (!list) return { text: t(quotedId ? 'wava_tasks_notAList' : 'wava_tasks_noList') };
    const count = list.taskIds.length;
    // One number the list does not have, and nothing is changed: he says which he meant
    if (numbers.some(number => number > count)) {
      return { text: count === 1 ? t('wava_tasks_outOfRangeOne') : t('wava_tasks_outOfRange', [String(count)]) };
    }
    const changed: string[] = [];
    const already: string[] = [];
    const gone: string[] = [];
    for (const number of numbers) {
      const task = await this.deps.tasks.get(list.taskIds[number - 1]);
      if (!task) {
        gone.push(String(number));
        continue;
      }
      const title = taskTitleText(task.title, 100);
      if (task.status === status) {
        already.push(title);
        continue;
      }
      await this.deps.tasks.setStatus(task.id, status, 'avi');
      changed.push(status === 'open' ? title : `~${title}~`);
    }
    const label =
      status === 'done' ? 'wava_tasks_done' : status === 'open' ? 'wava_tasks_reopened' : 'wava_tasks_dropped';
    const lines = [
      ...(changed.length ? [t(label, [changed.length === 1 ? changed[0] : `\n${changed.join('\n')}`])] : []),
      ...(already.length ? [t('wava_tasks_unchanged', [already.join(', ')])] : []),
      ...(gone.length ? [t('wava_tasks_gone', [gone.join(', ')])] : []),
    ];
    return { text: lines.join('\n') };
  }

  // ── tasks · tasks ada · tasks for ada · tasks in ember ──

  private async openTasks(query: TaskListQuery = {}): Promise<Task[]> {
    return (await this.deps.tasks.list({ ...query, status: 'open' })).sort(byDueThenAge);
  }

  private list(title: string, tasks: Task[], owner: boolean, empty: string): Answer {
    if (!tasks.length) return { text: empty };
    const { text, taskIds } = taskListText(title, tasks, { now: this.deps.now(), owner });
    return { text, list: { taskIds, numbered: true } };
  }

  private async listFor(word: string | null, as: 'person' | 'workspace' | null): Promise<Answer> {
    if (!word) return this.list(t('wava_tasks_listTitle'), await this.openTasks(), true, t('wava_tasks_none'));
    const said = nameText(word);
    const people = as === 'workspace' ? [] : await this.peopleCalled(word);
    const workspaces = as === 'person' ? [] : this.workspacesCalled(word, await this.deps.workspaces());
    if (people.length && workspaces.length) {
      const name = people.length === 1 ? nameText(people[0].name) : said;
      return { text: t('wava_tasks_which', [name, nameText(workspaces[0].name), said]) };
    }
    if (people.length > 1) {
      return {
        text: t('wava_tasks_people', [String(people.length), said, people.map(p => nameText(p.name)).join(', ')]),
      };
    }
    if (workspaces.length > 1) {
      return { text: t('wava_tasks_workspaces', [said, workspaces.map(w => nameText(w.name)).join(', ')]) };
    }
    if (people.length === 1) {
      const person = people[0];
      const name = nameText(person.name);
      return this.list(
        t('wava_tasks_listTitleFor', [name]),
        await this.tasksOf(person),
        false,
        t('wava_tasks_noneFor', [name]),
      );
    }
    if (workspaces.length === 1) {
      const name = nameText(workspaces[0].name);
      return this.list(
        t('wava_tasks_listTitleIn', [name]),
        await this.openTasks({ workspaceId: workspaces[0].id }),
        true,
        t('wava_tasks_noneIn', [name]),
      );
    }
    return {
      text: t(
        as === 'workspace' ? 'wava_tasks_noWorkspace' : as === 'person' ? 'wava_tasks_nobody' : 'wava_tasks_noOne',
        [said],
      ),
    };
  }

  /**
   * Everyone a word names, across workspaces: on WhatsApp he is in none. An exact name or an alias for everywhere
   * first; else an alias or a unique first name in any workspace. Several: he is asked, never one picked.
   */
  private async peopleCalled(word: string): Promise<Person[]> {
    const found = new Map<string, Person>();
    const add = (result: ResolveResult) => {
      if (!result) return;
      for (const person of 'person' in result ? [result.person] : result.candidates) found.set(person.id, person);
    };
    add(await this.deps.people.resolve(word, { workspaceId: null }));
    if (found.size) return [...found.values()];
    for (const workspace of await this.deps.workspaces()) {
      add(await this.deps.people.resolve(word, { workspaceId: workspace.id }));
    }
    return [...found.values()];
  }

  /** Whether a word names any person or workspace at all. */
  private async names(word: string): Promise<boolean> {
    if (this.workspacesCalled(word, await this.deps.workspaces()).length) return true;
    return (await this.peopleCalled(word)).length > 0;
  }

  /** The workspaces a word names: by name or a keyword exactly, else the one whose name or keyword it mentions. */
  private workspacesCalled(word: string, workspaces: Workspace[]): Workspace[] {
    const wanted = normaliseTitle(word);
    if (!wanted) return [];
    const exact = workspaces.filter(
      workspace =>
        normaliseTitle(workspace.name) === wanted ||
        workspace.keywords.some(keyword => normaliseTitle(keyword) === wanted),
    );
    if (exact.length) return exact;
    const routed = routeWorkspace(word, workspaces);
    return routed ? [routed] : [];
  }

  /** A person's open tasks: linked to them, or not linked yet and given to a name they go by there. */
  private async tasksOf(person: Person): Promise<Task[]> {
    const names = (workspaceId: string | null) =>
      new Set(
        [
          person.name,
          ...person.aliases
            .filter(alias => alias.workspaceId === null || alias.workspaceId === workspaceId)
            .map(alias => alias.text),
        ].map(normaliseTitle),
      );
    return (await this.openTasks()).filter(
      task =>
        task.ownerId === person.id ||
        (!task.ownerId && Boolean(task.ownerName) && names(task.workspaceId).has(normaliseTitle(task.ownerName!))),
    );
  }

  // ── task for ada: send the deck by friday ──

  private async add(owner: string, words: string, messageId: string, said: string): Promise<Answer> {
    const now = this.deps.now();
    const split = splitDue(words, now);
    const { due, dueText } = split;
    // "send the deck" is kept as "Send the deck", like the tasks he adds in the panel
    const title = split.title.charAt(0).toUpperCase() + split.title.slice(1);
    if (title.length < 2) return { text: t('wava_tasks_addEmpty') };
    const people = await this.peopleCalled(owner);
    const person = people.length === 1 ? people[0] : null;
    const workspaces = await this.deps.workspaces();
    const routed = routeWorkspace(title, workspaces);
    // The words name a workspace: the rules placed it. Else the one workspace its owner works in, Ava's doing
    const workspaceId = routed?.id ?? (person?.workspaceIds.length === 1 ? person.workspaceIds[0] : null);
    const recorded = await this.deps.tasks.record({
      title,
      ownerName: person ? person.name : owner,
      ownerId: person?.id ?? null,
      ...(due ? { due } : {}),
      ...(dueText ? { dueText } : {}),
      workspaceId,
      workspaceSetBy: routed || !workspaceId ? 'rule' : 'ava',
      source: { kind: 'whatsapp', id: messageId, quote: said.slice(0, 300) },
      at: now,
    });
    if (!recorded) return { text: t('wava_tasks_addEmpty') };
    const { task, added } = recorded;
    // A name not known yet is kept as he wrote it, and People asks who it is (Part 5)
    if (!person) {
      await this.deps.people
        .observe({
          text: owner,
          source: 'whatsapp',
          workspaceId: task.workspaceId,
          taskId: task.id,
          ref: `whatsapp|${messageId}`,
          context: `owns the task ${JSON.stringify(task.title.slice(0, 80))}`,
        })
        .catch(error => this.deps.warn('Could not note a task owner', error));
    }
    const line = taskListLine(task, 1, { now, owner: true }).replace(/^1\. /, '');
    return {
      text: t(added ? 'wava_tasks_added' : 'wava_tasks_exists', [line]),
      // A ✅ on this answer closes the task; it is not a numbered list
      list: { taskIds: [task.id], numbered: false },
    };
  }

  // ── ada says the deck is with design, ready thursday ──

  private async says(name: string, said: string, message: Pick<WhatsAppMessage, 'id' | 'at'>): Promise<Answer> {
    const found = await this.peopleCalled(name);
    if (found.length > 1) {
      return { text: t('followups_wa_which', [nameText(name), found.map(person => nameText(person.name)).join(', ')]) };
    }
    const at = message.at > 0 ? message.at : this.deps.now();
    const { text, taskIds } = await this.deps.report!({
      personId: found[0].id,
      words: said,
      messageId: message.id,
      at,
    });
    // Her "did" lines that match open tasks of theirs: numbered, so "done 1" closes one (only his answer does)
    return taskIds.length ? { text, list: { taskIds, numbered: true } } : { text };
  }

  // ── who's next ──

  private async next(): Promise<Answer> {
    const due = await this.deps.followUpsToday();
    return this.list(t('wava_tasks_followUpTitle'), due, true, t('wava_tasks_followUpsNone'));
  }

  // ── Lists Ava sends first ──

  /**
   * The morning brief with its "Open tasks" (top BRIEF_MAX) and, once follow-ups exist (#111), "Follow up today",
   * numbered on from the open tasks so one list covers both. Sent once per key, as the 'brief' notice it is.
   */
  async sendBrief(text: string, key: string): Promise<boolean> {
    const now = this.deps.now();
    const open = await this.openTasks().catch(() => [] as Task[]);
    const follow = (await this.deps.followUpsToday().catch(() => [] as Task[])).filter(
      task => !open.slice(0, BRIEF_MAX).some(other => other.id === task.id),
    );
    const sections: string[] = [];
    const taskIds: string[] = [];
    if (open.length) {
      const part = taskListText(t('wava_tasks_listTitle'), open, { now, owner: true, hint: false, max: BRIEF_MAX });
      sections.push(part.text);
      taskIds.push(...part.taskIds);
    }
    if (follow.length) {
      const part = taskListText(t('wava_tasks_followUpTitle'), follow, {
        now,
        owner: true,
        hint: false,
        max: 5,
        start: taskIds.length + 1,
      });
      sections.push(part.text);
      taskIds.push(...part.taskIds);
    }
    if (taskIds.length) sections.push(`_${t('wava_tasks_hint')}_`);
    const body = [text, ...sections].join('\n\n');
    return this.deliver(`whatsapp.brief:${key}`, body, 'brief', { taskIds, numbered: true });
  }

  /**
   * A numbered list of tasks Ava sends first, such as one person's after a call. HOOK for #108: the after-call
   * messages call this once per person (or once for all, past five people), each with its own key. Returns what
   * happened: sent now, queued until quiet hours end (it then goes once), off (he switched task messages off), or
   * empty (none of the tasks is open any more).
   */
  async sendTaskList(input: Omit<PendingTaskMessage, 'at'>): Promise<'sent' | 'queued' | 'off' | 'empty' | 'done'> {
    const settings = await this.deps.settings();
    if (!settings.notify.tasks) return 'off';
    if (inQuietHours(new Date(this.deps.now()), settings.quietStart, settings.quietEnd)) return this.queue(input);
    try {
      return await this.sendPending(input);
    } catch (error) {
      // Not linked, the hourly cap: it waits in the outbox and is tried again on each poll, for a day
      this.deps.warn('A WhatsApp task list was not sent', error);
      return this.queue(input);
    }
  }

  private async queue(input: Omit<PendingTaskMessage, 'at'>): Promise<'queued'> {
    const items = (await this.deps.outbox.get()).filter(item => item.key !== input.key);
    await this.deps.outbox.set([...items, { ...input, at: this.deps.now() }].slice(-OUTBOX_MAX));
    return 'queued';
  }

  /** Sends what waited for quiet hours to end, once each. Run on every poll; nothing happens in quiet hours. */
  flush(): Promise<void> {
    this.flushing ??= this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    const items = await this.deps.outbox.get();
    if (!items.length) return;
    const settings = await this.deps.settings();
    if (!settings.notify.tasks) {
      await this.deps.outbox.set([]);
      return;
    }
    if (inQuietHours(new Date(this.deps.now()), settings.quietStart, settings.quietEnd)) return;
    const kept: PendingTaskMessage[] = [];
    for (const item of items) {
      try {
        await this.sendPending(item);
      } catch (error) {
        // Not linked, the hourly cap: tried again on the next poll, for a day
        if (this.deps.now() - item.at < OUTBOX_MAX_MS) kept.push(item);
        this.deps.warn('A WhatsApp task list was not sent', error);
      }
    }
    // Lists queued while this ran stay too, a key queued again among them (it is a new item, not one this sent)
    const now = await this.deps.outbox.get();
    const itemKey = (item: PendingTaskMessage) => `${item.key}|${item.at}`;
    const handled = new Set(items.map(itemKey));
    const added = now.filter(item => !handled.has(itemKey(item)));
    const replaced = new Set(added.map(item => item.key));
    await this.deps.outbox.set([...kept.filter(item => !replaced.has(item.key)), ...added]);
  }

  private async sendPending(item: Omit<PendingTaskMessage, 'at'>): Promise<'sent' | 'empty' | 'done'> {
    // Drawn now, from the store: a task closed since is left out
    const tasks = (await Promise.all(item.taskIds.map(id => this.deps.tasks.get(id)))).filter(
      (task): task is Task => task?.status === 'open',
    );
    if (!tasks.length) return 'empty';
    const { text, taskIds } = taskListText(item.title, tasks, {
      now: this.deps.now(),
      owner: false,
      hint: item.hint ?? false,
    });
    const body = item.note ? `${text}\n\n${plainOutside(item.note, 300)}` : text;
    // A list with no "done 2" hint is meant to be forwarded (one person's after a call): a bare number never reads
    // it, so three of them going out after the brief cannot take his "done 2" away from the brief
    const numbered = item.hint === true;
    return (await this.deliver(`whatsapp.tasks:${item.key}`, body, 'tasks', { taskIds, numbered })) ? 'sent' : 'done';
  }

  /**
   * One message under a do-once key, its tasks kept by the id it went out with. False when the key was used
   * already. Throws when it did not go (the key may then be tried again, with the same request id).
   */
  private async deliver(
    key: string,
    text: string,
    kind: WhatsAppNoticeKind,
    list: { taskIds: string[]; numbered: boolean },
  ): Promise<boolean> {
    if (!(await this.deps.once.begin(key))) return false;
    let messageId: string | null;
    try {
      ({ messageId } = await this.deps.send({ requestId: await this.deps.requestIdOf(key), text, kind }));
    } catch (error) {
      await this.deps.once.fail(key);
      throw error;
    }
    // Kept before the key is closed, so a message that went out always has its numbers (a cut-off between the two
    // leaves the key open, and it is never sent again: the record blocks only itself)
    if (list.taskIds.length) {
      await this.deps.lists
        .save({ messageId: messageId ?? localId(), ...list, kind: kind === 'brief' ? 'brief' : 'list' })
        .catch(error => this.deps.warn('A WhatsApp task list could not be kept', error));
    }
    await this.deps.once.finish(key);
    return true;
  }
}
