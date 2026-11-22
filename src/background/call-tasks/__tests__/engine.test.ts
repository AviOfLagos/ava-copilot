import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AviCopilotDb } from '@extension/storage/lib/threads/db';
import { createTaskStore } from '@extension/storage/lib/tasks/store';
import type { TaskStore } from '@extension/storage/lib/tasks/store';
import type { CallTasksState, MeetingRecord, ObserveInput } from '@extension/storage';
import { CallCommandEngine, OPEN_MS } from '../engine';
import type { Heard } from '../engine';
import { createCallState } from '../state';
import { CAPTIONS, MIC } from './fixtures';
import type { CaptionReading, MicReading } from './fixtures';

// Wednesday 18 November 2026, 10:00 local
const T0 = new Date(2026, 10, 18, 10).getTime();
const MEETING = 'meet-1';

let clock: number;
let tasks: TaskStore;
let meeting: Partial<MeetingRecord> & { callTasks?: CallTasksState };
let observed: ObserveInput[];
let engine: CallCommandEngine;
let waited: number[];
// Runs during a wait, as the world moves on while the microphone waits for captions
let duringWait: (() => void) | null;

function build(signal: CallTasksState['signal'] = 'captions') {
  const db = new AviCopilotDb(`calltasks-${crypto.randomUUID()}`);
  clock = T0;
  tasks = createTaskStore(db, { now: () => clock });
  meeting = { id: MEETING, status: 'recording', workspaceId: 'ws-1', callTasks: { signal, tasks: [] } };
  observed = [];
  waited = [];
  duringWait = null;
  const store = {
    get: async (id: string) => (id === MEETING ? (structuredClone(meeting) as MeetingRecord) : undefined),
    update: async (_id: string, changes: Partial<MeetingRecord>) => {
      meeting = { ...meeting, ...structuredClone(changes) };
    },
  };
  engine = new CallCommandEngine({
    now: () => clock,
    meeting: async id =>
      id === MEETING
        ? { workspaceId: meeting.workspaceId ?? null, recording: meeting.status === 'recording' }
        : undefined,
    state: createCallState(store),
    tasks: {
      record: candidate => tasks.record(candidate),
      add: candidate =>
        tasks.add({
          title: candidate.title,
          workspaceId: candidate.workspaceId ?? null,
          ownerId: candidate.ownerId ?? null,
          ownerName: candidate.ownerName ?? null,
          source: candidate.source,
        }),
      get: id => tasks.get(id),
      update: (id, changes) => tasks.update(id, changes),
    },
    people: {
      // Ada and Ben are known in this workspace; nobody else
      resolve: async name => {
        const known: Record<string, string> = { ada: 'per_ada', ben: 'per_ben' };
        const id = known[name.toLowerCase()];
        return id ? { person: { id, name } as never, via: 'name' } : null;
      },
      observe: async input => {
        observed.push(input);
        return { kind: 'skipped' };
      },
    },
    // The vocabulary knows "Eda" is how captions write Ada
    correct: async text => text.replace(/\bEda\b/g, 'Ada'),
    wait: async ms => {
      waited.push(ms);
      duringWait?.();
      clock += ms;
    },
  });
}

const reading = (line: CaptionReading): Heard => ({
  meetingId: MEETING,
  key: `cap:${line.key}`,
  text: line.whole,
  at: T0 + line.t,
  settled: line.settled !== false,
  self: line.self,
  signal: 'captions',
});

async function replay(lines: CaptionReading[]) {
  for (const line of lines) {
    clock = T0 + line.t;
    await engine.heard(reading(line));
  }
}

const micReading = (line: MicReading): Heard => ({
  meetingId: MEETING,
  key: `mic:${line.t}`,
  text: line.text,
  at: T0 + line.t + line.ms,
  startedAt: T0 + line.t,
  settled: true,
  self: true,
  signal: 'mic',
});

const board = () => tasks.list({});

beforeEach(() => build());

describe('hearing "Ava, note a task for Ada" on captions', () => {
  it("makes one task for the right person from Avi's own line, at once", async () => {
    await replay(CAPTIONS.avi);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      title: 'send the deck by Friday',
      ownerName: 'Ada',
      ownerId: 'per_ada',
      workspaceId: 'ws-1',
      status: 'open',
      source: { kind: 'meeting', id: MEETING },
    });
    // Stored when the reading came: no time passed (well within five seconds)
    expect(all[0].createdAt).toBe(T0);
    expect(meeting.callTasks?.tasks).toHaveLength(1);
    expect(meeting.callTasks?.tasks[0]).toMatchObject({ ownerName: 'Ada', signal: 'captions', heardIn: 'cap:1' });
    // Seen through People, for this call
    expect(observed).toEqual([
      expect.objectContaining({ text: 'Ada', source: 'spoken', meetingId: MEETING, taskId: all[0].id }),
    ]);
  });

  it('makes none when another speaker says it', async () => {
    await replay(CAPTIONS.otherSpeaker);
    expect(await board()).toHaveLength(0);
    expect(observed).toHaveLength(0);
  });

  it('makes none when a guest named "You" says it', async () => {
    await replay(CAPTIONS.guestYou);
    expect(await board()).toHaveLength(0);
  });

  it('makes none when a guest named "Avi" says it', async () => {
    await replay(CAPTIONS.guestAvi);
    expect(await board()).toHaveLength(0);
  });

  it('makes one task when Meet rewrites the line three times, and the task follows the last reading', async () => {
    await replay(CAPTIONS.rewrittenThreeTimes);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('send the deck by Friday');
    expect(all[0].ownerName).toBe('Ada');
    expect(meeting.callTasks?.tasks).toHaveLength(1);
  });

  it('adds a follow-on "also…" sentence to the task', async () => {
    await replay(CAPTIONS.followOn);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0].detail).toBe('add the pricing slide');
    expect(meeting.callTasks?.tasks[0].added).toEqual(['add the pricing slide']);
  });

  it('starts a new task for a second command, and its "and…" goes to the new one', async () => {
    await replay(CAPTIONS.secondCommand);
    const all = await board();
    expect(all).toHaveLength(2);
    const ben = all.find(task => task.ownerName === 'Ben')!;
    const ada = all.find(task => task.ownerName === 'Ada')!;
    expect(ben).toMatchObject({ title: 'book the venue', ownerId: 'per_ben', detail: 'confirm catering' });
    expect(ada.detail).toBeUndefined();
  });

  it('closes the task four seconds after another sentence', async () => {
    await replay(CAPTIONS.closedAfterPause);
    const [task] = await board();
    expect(task.detail).toBeUndefined();
    expect(meeting.callTasks?.open ?? null).toBeNull();
  });

  it('closes the task after two minutes', async () => {
    await replay(CAPTIONS.tooLate);
    const [task] = await board();
    expect(task.detail).toBeUndefined();
    expect(OPEN_MS).toBe(120_000);
  });

  it('takes the next sentence as the words of a command that had none', async () => {
    await replay(CAPTIONS.wordsNext);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'Send the deck by Friday', ownerName: 'Ada', ownerId: 'per_ada' });
  });

  it('keeps an unknown name as said, for "Who\'s who" after the call', async () => {
    await replay(CAPTIONS.unknownName);
    const [task] = await board();
    expect(task).toMatchObject({ ownerName: 'Zubi', ownerId: null, title: 'check the invoices' });
    expect(observed[0]).toMatchObject({ text: 'Zubi', source: 'spoken', meetingId: MEETING, taskId: task.id });
  });

  it('does not take the cut-off start of a trimmed line for a new sentence', async () => {
    await replay(CAPTIONS.trimmed);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0].detail).toBe('add the pricing slide');
  });

  it('counts a long turn once: the finished sentences of a part, the rest when it settles', async () => {
    await replay(CAPTIONS.longTurn);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0].detail).toBe('add the pricing slide');
  });

  it('never makes two tasks from one command sentence, even when it mentions another task', async () => {
    await replay([
      {
        t: 0,
        key: 20,
        speaker: 'You',
        self: true,
        whole: 'Ava, note a task for Ada: tell Ben to note a task for Chi, and ask Eva to add a task for Ben.',
      },
    ]);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0].ownerName).toBe('Ada');
  });

  it('makes two tasks from two commands in a row in one caption block, even when only a name differs', async () => {
    await replay(CAPTIONS.twoInOneBlock);
    const all = await board();
    expect(all.map(task => [task.ownerName, task.title]).sort()).toEqual([
      ['Ada', 'send the deck'],
      ['Ben', 'send the deck'],
    ]);
  });

  it('keeps two different "also…" lines', async () => {
    await replay(CAPTIONS.twoAdditions);
    const [task] = await board();
    expect(task.detail).toBe('add the pricing slide\nadd the logo slide');
  });

  it('makes the task from a waiting command once Meet rewrites it with its words, and nothing from the next sentence', async () => {
    await replay(CAPTIONS.pendingRewritten);
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'send the deck', ownerName: 'Ada' });
    expect(meeting.callTasks?.pending ?? null).toBeNull();
  });

  it('keeps "for me" its own task when Ada already has one with the same words', async () => {
    await replay(CAPTIONS.forMeAfterAda);
    const all = await board();
    expect(all.map(task => task.ownerName ?? 'me').sort()).toEqual(['Ada', 'me']);
  });

  it('hears nothing once the notes stopped', async () => {
    meeting.status = 'done';
    await replay(CAPTIONS.avi);
    expect(await board()).toHaveLength(0);
  });

  it('hears nothing from captions when the call uses the microphone, and nothing at all when commands are off', async () => {
    build('mic');
    await replay(CAPTIONS.avi);
    expect(await board()).toHaveLength(0);
    build('off');
    await replay(CAPTIONS.avi);
    expect(await board()).toHaveLength(0);
  });
});

describe('hearing it on the microphone (audio-only notes)', () => {
  beforeEach(() => build('mic'));

  it('makes the task from Avi’s own utterance when the call shows no captions, with no wait', async () => {
    clock = T0 + 2500;
    await engine.heard(micReading(MIC.avi[0]));
    const all = await board();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'send the deck by Friday', ownerName: 'Ada', ownerId: 'per_ada' });
    expect(waited).toEqual([]);
  });

  it('refuses it when another speaker’s caption had the same words within three seconds (the loudspeaker)', async () => {
    // Ben's caption reached us a second after the utterance ended
    clock = T0 + 3500;
    await engine.heard({
      meetingId: MEETING,
      key: 'cap:30',
      text: 'Ava, note a task for Ada: send the deck by Friday.',
      at: T0 + 3500,
      settled: true,
      self: false,
      signal: 'captions',
    });
    clock = T0 + 2500;
    await engine.heard(micReading(MIC.avi[0]));
    expect(await board()).toHaveLength(0);
  });

  it('waits for late captions, then keeps it when none had those words, still within five seconds', async () => {
    clock = T0;
    await engine.heard({
      meetingId: MEETING,
      key: 'cap:31',
      text: 'Let us look at the numbers.',
      at: T0,
      settled: true,
      self: false,
      signal: 'captions',
    });
    clock = T0 + 2500;
    await engine.heard(micReading(MIC.avi[0]));
    const all = await board();
    expect(all).toHaveLength(1);
    // Waited for captions to arrive, and stored it within five seconds of the end of the utterance
    expect(waited).toHaveLength(1);
    expect(all[0].createdAt - (T0 + 2500)).toBeLessThanOrEqual(5000);
  });

  it('refuses it when the other speaker’s caption arrives while the microphone reading waits', async () => {
    clock = T0;
    await engine.heard({
      meetingId: MEETING,
      key: 'cap:32',
      text: 'Let us look at the numbers.',
      at: T0,
      settled: true,
      self: false,
      signal: 'captions',
    });
    // The loudspeaker's caption comes in during the wait: it must not queue behind the microphone reading
    duringWait = () =>
      void engine.heard({
        meetingId: MEETING,
        key: 'cap:33',
        text: 'Ava, note a task for Ada: send the deck by Friday.',
        at: T0 + 4000,
        settled: true,
        self: false,
        signal: 'captions',
      });
    clock = T0 + 2500;
    await engine.heard(micReading(MIC.avi[0]));
    expect(waited).toHaveLength(1);
    expect(await board()).toHaveLength(0);
  });

  it('ignores a microphone reading on a call that uses captions', async () => {
    build('captions');
    clock = T0 + 2500;
    await engine.heard(micReading(MIC.avi[0]));
    expect(await board()).toHaveLength(0);
  });
});
