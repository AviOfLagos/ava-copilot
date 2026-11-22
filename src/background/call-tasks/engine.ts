/**
 * "Ava, note a task for Ada: …" on a call becomes a task (docs/pm-desk.md, Part 6). Plain code, no model.
 *
 * Only Avi's own words make a command (rule 2). Each reading says whose it is before it gets here, and it is never
 * decided by a name: a guest can call themselves "You" or "Avi".
 * - Captions: a caption block counts when Meet's page marks it as the local user's own (`selfLineSelectors` in
 *   CALL_DOM, read in the page by watchCaptions). The speaker's name is not looked at.
 * - Microphone: a separate echo-cancelled stream written down on this computer (src/offscreen/call-mic.ts). A
 *   match is refused when the same words were in another speaker's caption within three seconds either side.
 * - Neither: spoken commands are off for the call (./signal.ts), and the panel says so.
 *
 * Timing: a caption reading comes once it has stood unchanged for 1.5 seconds (the page's settle time), and is
 * remembered by block, so Meet rewriting a line makes one task, not one per rewrite.
 */
import type {
  CallCommandSignal,
  CallTaskEntry,
  CallTasksState,
  ObserveInput,
  ResolveResult,
  Task,
  TaskCandidate,
  TaskChanges,
} from '@extension/storage';
import { additionOf, cleanWords, findCommands, overlap, sentencesOf, wordsKey } from './match';

// A task stays open for "also…" this long after its command
export const OPEN_MS = 120_000;
// …and closes this long after a sentence that is not an addition
export const CLOSE_AFTER_MS = 4_000;
// A command with no words waits this long for the next sentence to be its words
export const PENDING_MS = 15_000;
// Another speaker's caption this close in time to a microphone match makes it an echo of the call
export const ECHO_MS = 3_000;
// How long a caption takes to reach us after it was said (the page waits 1.5 s for it to settle)
export const CAPTION_DELAY_MS = 1_500;
// Two readings this alike, one where the other was, are the same sentence rewritten
const REVISION_OVERLAP = 0.6;
// Caption readings of other speakers kept for the echo check
const OTHERS_KEPT_MS = 30_000;
const QUOTE_MAX = 300;

export interface Heard {
  meetingId: string;
  // Where it was heard: a caption block's key on the page ('cap:3'), or 'mic'
  key: string;
  // The whole reading: the caption block's words now, or one utterance from the microphone
  text: string;
  // When it was heard (for the microphone: when the utterance ended)
  at: number;
  // For the microphone: when the utterance started
  startedAt?: number;
  // A settled reading; false for a part of long speech still going on (only its finished sentences count)
  settled: boolean;
  // The page marked this caption as the local user's own; the microphone stream is always the user's
  self: boolean;
  signal: 'captions' | 'mic';
}

export interface EngineDeps {
  now(): number;
  meeting(id: string): Promise<{ workspaceId: string | null; recording: boolean } | undefined>;
  state: {
    get(meetingId: string): Promise<CallTasksState | undefined>;
    change(meetingId: string, change: (state: CallTasksState) => CallTasksState): Promise<CallTasksState>;
  };
  tasks: {
    record(candidate: TaskCandidate): Promise<{ task: Task; added: boolean } | null>;
    // A task as given, with no matching: when the board's match would give it to someone else
    add(candidate: TaskCandidate): Promise<Task>;
    get(id: string): Promise<Task | undefined>;
    update(id: string, changes: TaskChanges): Promise<Task | null>;
  };
  people: {
    resolve(text: string, options: { workspaceId: string | null }): Promise<ResolveResult>;
    observe(input: ObserveInput): Promise<unknown>;
  };
  correct(text: string, options: { workspaceId: string | null }): Promise<string>;
  // Called after each change, so the panel's card can say something new (it reads Dexie anyway)
  changed?: (meetingId: string) => void;
  wait?: (ms: number) => Promise<void>;
}

export const emptyCallState = (signal: CallCommandSignal = 'off'): CallTasksState => ({ signal, tasks: [] });

type Kind = 'command' | 'addition' | 'other';
interface Remembered {
  text: string;
  kind: Kind;
  taskId?: string;
}

/** A sentence that is the end of a longer one heard before (Meet dropped the line's oldest words). */
function isTailOf(sentence: string, earlier: string): boolean {
  const tail = wordsKey(sentence);
  const all = wordsKey(earlier);
  if (!tail.length || tail.length > all.length) return false;
  const from = all.length - tail.length;
  return tail.every((word, index) => all[from + index] === word);
}

/** Whether a task on the board is for the person a command named (`null`: the user). */
function sameOwnerAs(task: Pick<Task, 'ownerId' | 'ownerName'>, ownerId: string | null, name: string | null): boolean {
  if (task.ownerId && ownerId) return task.ownerId === ownerId;
  const key = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
  return key(task.ownerName) === key(name);
}

interface Block {
  // Every sentence the block said: a repeat of any of them is skipped
  all: Remembered[];
  // The sentences of its last reading, in order: the new reading's sentence in the same place is its rewrite
  last: Remembered[];
}

export class CallCommandEngine {
  // What each caption block (or the microphone) already said, per meeting: rewrites are matched against it
  private readonly blocks = new Map<string, Map<string, Block>>();
  private readonly others = new Map<string, { text: string; at: number }[]>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: EngineDeps) {}

  /** One reading of speech. Readings of one meeting are handled one at a time, in order. */
  async heard(reading: Heard): Promise<void> {
    if (reading.signal === 'captions' && !reading.self) {
      // Someone else's words: data, never a command. Kept at once (not behind the queue) for the microphone's echo
      // check, which may be waiting for exactly this caption
      const others = (this.others.get(reading.meetingId) ?? []).filter(other => reading.at - other.at < OTHERS_KEPT_MS);
      others.push({ text: reading.text, at: reading.at - CAPTION_DELAY_MS });
      this.others.set(reading.meetingId, others);
      return;
    }
    // The microphone waits for the captions of the same moment before it joins the queue, so it holds nothing up
    if (reading.signal === 'mic') await this.waitForCaptions(reading);
    const previous = this.chains.get(reading.meetingId) ?? Promise.resolve();
    const next = previous.then(() => this.handle(reading)).catch(() => {});
    this.chains.set(reading.meetingId, next);
    return next;
  }

  /** Forgets a meeting that ended. */
  forget(meetingId: string): void {
    this.blocks.delete(meetingId);
    this.others.delete(meetingId);
    this.chains.delete(meetingId);
  }

  private async handle(reading: Heard): Promise<void> {
    const meeting = await this.deps.meeting(reading.meetingId);
    if (!meeting?.recording) return;
    const state = await this.deps.state.get(reading.meetingId);
    const signal = state?.signal ?? 'off';

    // Only the signal this call uses counts: never two ways of hearing the same words
    if (reading.signal !== signal) return;
    if (!reading.self) return;

    if (reading.signal === 'mic' && this.isEcho(reading)) return;
    await this.sentences(reading, meeting.workspaceId);
  }

  /**
   * Captions reach us late (they settle 1.5 s after the words): when the call shows any, a microphone reading waits
   * until the captions of its whole echo window can have arrived.
   */
  private async waitForCaptions(reading: Heard): Promise<void> {
    const recent = this.others.get(reading.meetingId) ?? [];
    if (!recent.some(other => reading.at - other.at < OTHERS_KEPT_MS)) return;
    const wait = reading.at + ECHO_MS + CAPTION_DELAY_MS - this.deps.now();
    if (wait > 0) await (this.deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait);
  }

  /**
   * Whether a microphone reading is the call coming out of the loudspeakers: the same words in another speaker's
   * caption within three seconds either side. With no captions on the call, the stream's echo cancellation is
   * what keeps the other side out.
   */
  private isEcho(reading: Heard): boolean {
    const started = reading.startedAt ?? reading.at;
    const recent = () => this.others.get(reading.meetingId) ?? [];
    return recent().some(
      other =>
        other.at >= started - ECHO_MS && other.at <= reading.at + ECHO_MS && overlap(other.text, reading.text) >= 0.6,
    );
  }

  private block(meetingId: string, key: string): Block {
    let blocks = this.blocks.get(meetingId);
    if (!blocks) {
      blocks = new Map();
      this.blocks.set(meetingId, blocks);
    }
    let block = blocks.get(key);
    if (!block) {
      block = { all: [], last: [] };
      blocks.set(key, block);
    }
    return block;
  }

  private async sentences(reading: Heard, workspaceId: string | null): Promise<void> {
    let parts = sentencesOf(reading.text);
    // Long speech still going on: its last sentence may yet change
    if (!reading.settled) parts = parts.slice(0, -1).filter(part => part.ended);
    const block = this.block(reading.meetingId, reading.key);
    const same = (old: Remembered, sentence: string) =>
      wordsKey(old.text).join(' ') === wordsKey(sentence).join(' ') || isTailOf(sentence, old.text);
    // Meet adds words at the end and drops the oldest ones: the new reading's first sentence is where it now starts
    const offset = parts.length
      ? Math.max(
          0,
          block.last.findIndex(old => same(old, parts[0].text)),
        )
      : 0;
    const last: Remembered[] = [];

    for (const [index, part] of parts.entries()) {
      const sentence = part.text;
      // The sentence in the same place last time: a different sentence there is Meet rewriting it. A sentence in a
      // new place is new, however alike (two commands in a row that differ in one name are two tasks)
      const there = block.last[offset + index];
      if (there && same(there, sentence)) {
        last.push(there);
        continue;
      }
      if (there && overlap(there.text, sentence) >= REVISION_OVERLAP) {
        await this.rewrite(reading, there, sentence, workspaceId);
        last.push(there);
        continue;
      }
      const repeat = block.all.find(old => same(old, sentence));
      if (repeat) {
        last.push(repeat);
        continue;
      }
      const remembered: Remembered = { text: sentence, ...(await this.fresh(reading, sentence, workspaceId)) };
      block.all.push(remembered);
      last.push(remembered);
    }
    if (parts.length) block.last = last;
    if (block.all.length > 40) block.all.splice(0, block.all.length - 40);
  }

  /** A sentence heard for the first time. */
  private async fresh(
    reading: Heard,
    sentence: string,
    workspaceId: string | null,
  ): Promise<{ kind: Kind; taskId?: string }> {
    const now = reading.at;
    await this.expire(reading.meetingId, now);
    const commands = findCommands(sentence);
    if (commands.length) {
      let last: string | undefined;
      // Words before the command ("Okay, so. Ava, note…") are another sentence: they close the open task
      if (cleanWords(sentence.slice(0, commands[0].start))) await this.otherSentence(reading.meetingId, now);
      for (const command of commands) {
        if (!command.words) {
          const ownerName = command.name ? await this.deps.correct(command.name, { workspaceId }) : null;
          await this.deps.state.change(reading.meetingId, state => ({
            ...state,
            open: null,
            pending: {
              ownerName,
              said: sentence.slice(0, QUOTE_MAX),
              heardIn: reading.key,
              signal: reading.signal,
              until: now + PENDING_MS,
            },
          }));
          continue;
        }
        last =
          (await this.create(reading, command.name, command.words, sentence, workspaceId, { corrected: false })) ??
          last;
      }
      this.deps.changed?.(reading.meetingId);
      return { kind: 'command', taskId: last };
    }

    const state = await this.deps.state.get(reading.meetingId);
    if (state?.pending) {
      const pending = state.pending;
      await this.deps.state.change(reading.meetingId, current => ({ ...current, pending: null }));
      const taskId = await this.create(
        reading,
        pending.ownerName,
        cleanWords(sentence),
        `${pending.said} ${sentence}`,
        workspaceId,
        { corrected: true },
      );
      this.deps.changed?.(reading.meetingId);
      return { kind: 'command', taskId };
    }

    const added = state?.open ? additionOf(sentence) : null;
    if (state?.open && added) {
      const taskId = state.open.taskId;
      await this.addTo(reading.meetingId, taskId, added, workspaceId);
      await this.deps.state.change(reading.meetingId, current => ({
        ...current,
        open: current.open ? { ...current.open, closeAt: null } : null,
        tasks: current.tasks.map(entry =>
          entry.taskId === taskId ? { ...entry, added: [...entry.added, added].slice(-20) } : entry,
        ),
      }));
      this.deps.changed?.(reading.meetingId);
      return { kind: 'addition', taskId };
    }
    await this.otherSentence(reading.meetingId, now);
    return { kind: 'other' };
  }

  /** A sentence that adds nothing: the open task closes four seconds after it, unless an addition comes first. */
  private async otherSentence(meetingId: string, now: number): Promise<void> {
    const state = await this.deps.state.get(meetingId);
    if (!state?.open || state.open.closeAt !== null) return;
    await this.deps.state.change(meetingId, current => ({
      ...current,
      open: current.open ? { ...current.open, closeAt: current.open.closeAt ?? now + CLOSE_AFTER_MS } : null,
    }));
  }

  /** Closes the open task when its two minutes or its four seconds are up, and drops a command still waiting. */
  private async expire(meetingId: string, now: number): Promise<void> {
    const state = await this.deps.state.get(meetingId);
    if (!state) return;
    const open = state.open;
    const closed = !!open && (now > open.until || (open.closeAt !== null && now > open.closeAt));
    const lapsed = !!state.pending && now > state.pending.until;
    if (!closed && !lapsed) return;
    await this.deps.state.change(meetingId, current => ({
      ...current,
      ...(closed ? { open: null } : {}),
      ...(lapsed ? { pending: null } : {}),
    }));
  }

  /** Stores the task now, with its owner resolved, and opens it for "also…". Returns its id. */
  private async create(
    reading: Heard,
    spokenName: string | null,
    spokenWords: string,
    sentence: string,
    workspaceId: string | null,
    options: { corrected: boolean },
  ): Promise<string | undefined> {
    const name = spokenName && !options.corrected ? await this.deps.correct(spokenName, { workspaceId }) : spokenName;
    const words = cleanWords(await this.deps.correct(spokenWords, { workspaceId }));
    const resolved = name ? await this.deps.people.resolve(name, { workspaceId }).catch(() => null) : null;
    const ownerId = resolved && 'person' in resolved ? resolved.person.id : null;
    const recorded = await this.deps.tasks.record({
      title: words,
      workspaceId,
      ownerName: name,
      ownerId,
      source: { kind: 'meeting', id: reading.meetingId, quote: sentence.slice(0, QUOTE_MAX) },
      at: reading.at,
    });
    if (!recorded) return undefined;
    let task = recorded.task;
    // The board took it as a task it already has, but that one is someone else's ("for me" said after "for Ada"
    // with the same words): it is a task of its own
    if (!recorded.added && !sameOwnerAs(task, ownerId, name)) {
      task = await this.deps.tasks.add({
        title: words,
        workspaceId,
        ownerName: name,
        ownerId,
        source: { kind: 'meeting', id: reading.meetingId, quote: sentence.slice(0, QUOTE_MAX) },
        at: reading.at,
      });
    }
    const at = reading.at;
    await this.deps.state.change(reading.meetingId, state => {
      const known = state.tasks.some(entry => entry.taskId === task.id);
      const entry: CallTaskEntry = {
        taskId: task.id,
        ownerName: name,
        said: sentence.slice(0, QUOTE_MAX),
        added: [],
        signal: reading.signal,
        heardIn: reading.key,
        at,
      };
      return {
        ...state,
        pending: null,
        tasks: known ? state.tasks : [...state.tasks, entry],
        open: { taskId: task.id, until: at + OPEN_MS, closeAt: null },
      };
    });
    // Seen through People: a known name links the task to its person, an unknown one is asked about after the call
    if (name) {
      await this.deps.people
        .observe({
          text: name,
          source: 'spoken',
          workspaceId,
          meetingId: reading.meetingId,
          taskId: task.id,
          ref: `call:${reading.meetingId}:${task.id}`,
          context: 'was given a task on the call',
        })
        .catch(() => {});
    }
    return task.id;
  }

  private async addTo(meetingId: string, taskId: string, words: string, workspaceId: string | null): Promise<void> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) return;
    const added = await this.deps.correct(words, { workspaceId });
    const detail = task.detail ? `${task.detail}\n${added}` : added;
    await this.deps.tasks.update(taskId, { detail: detail.slice(0, 2000) });
  }

  /** Meet rewrote a sentence it showed before: the task it made, or the words it added, follow the new reading. */
  private async rewrite(reading: Heard, old: Remembered, sentence: string, workspaceId: string | null): Promise<void> {
    const previous = old.text;
    old.text = sentence;
    if (old.kind === 'command' && old.taskId) {
      const command = findCommands(sentence)[0];
      if (!command?.words) return;
      const words = cleanWords(await this.deps.correct(command.words, { workspaceId }));
      const task = await this.deps.tasks.get(old.taskId);
      if (task && words.length >= 2 && words !== task.title) await this.deps.tasks.update(task.id, { title: words });
      await this.deps.state.change(reading.meetingId, state => ({
        ...state,
        tasks: state.tasks.map(entry =>
          entry.taskId === old.taskId ? { ...entry, said: sentence.slice(0, QUOTE_MAX) } : entry,
        ),
      }));
      this.deps.changed?.(reading.meetingId);
      return;
    }
    // A command still waiting for its words, rewritten with them: the task is made now, and nothing waits any more
    if (old.kind === 'command' && !old.taskId) {
      if (!findCommands(sentence)[0]?.words) return;
      const kind = await this.fresh(reading, sentence, workspaceId);
      old.kind = kind.kind;
      old.taskId = kind.taskId;
      return;
    }
    if (old.kind === 'addition' && old.taskId) {
      const saidBefore = additionOf(previous);
      const saidAfter = additionOf(sentence);
      const task = await this.deps.tasks.get(old.taskId);
      if (!task || !saidBefore || !saidAfter || saidBefore === saidAfter) return;
      // The task's detail holds the words as corrected
      const before = await this.deps.correct(saidBefore, { workspaceId });
      const after = await this.deps.correct(saidAfter, { workspaceId });
      const lines = (task.detail ?? '').split('\n');
      const at = lines.lastIndexOf(before);
      if (at >= 0) lines[at] = after;
      else lines.push(after);
      await this.deps.tasks.update(task.id, { detail: lines.join('\n').slice(0, 2000) });
      this.deps.changed?.(reading.meetingId);
      return;
    }
    // A sentence that was nothing until Meet rewrote it into a command ("Ava, note a…" grew into a whole one)
    if (old.kind === 'other' && findCommands(sentence).length) {
      const kind = await this.fresh(reading, sentence, workspaceId);
      old.kind = kind.kind;
      old.taskId = kind.taskId;
    }
  }
}
