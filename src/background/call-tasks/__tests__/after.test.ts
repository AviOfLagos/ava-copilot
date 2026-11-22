import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallTasksState, MeetingRecord, Task } from '@extension/storage';
import { addCallListRows, confirmCallTasks, onCallTasksConfirmed, personMessage } from '../after';
import type { ConfirmDeps, ConfirmedEvent } from '../after';
import { createCallState } from '../state';

const MEETING = 'meet-1';

const task = (id: string, fields: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  workspaceId: 'ws-1',
  workspaceSetBy: 'rule',
  ownerId: null,
  ownerName: null,
  status: 'open',
  source: { kind: 'meeting', id: MEETING },
  seenIn: [],
  links: [],
  externalRefs: [],
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

let meeting: { id: string; callTasks?: CallTasksState };
let board: Map<string, Task>;
let deps: ConfirmDeps;
let send: ReturnType<typeof vi.fn<ConfirmDeps['send']>>;
let share: ReturnType<typeof vi.fn<ConfirmDeps['share']>>;

function setup(list: Task[]) {
  board = new Map(list.map(item => [item.id, item]));
  meeting = {
    id: MEETING,
    callTasks: {
      signal: 'captions',
      tasks: list.map(item => ({
        taskId: item.id,
        ownerName: item.ownerName,
        said: 'Ava, note a task…',
        added: [],
        signal: 'captions',
        heardIn: 'cap:1',
        at: 1,
      })),
    },
  };
  const store = {
    get: async () => structuredClone(meeting) as unknown as MeetingRecord,
    update: async (_id: string, changes: Partial<MeetingRecord>) => {
      meeting = { ...meeting, ...structuredClone(changes) } as typeof meeting;
    },
  };
  send = vi.fn<ConfirmDeps['send']>(async () => 'sent');
  share = vi.fn<ConfirmDeps['share']>(async (ids: string[]) => {
    // The recording of the first task is in Drive: sharing puts its link on the task
    const first = board.get(ids[0])!;
    board.set(first.id, { ...first, links: [{ label: 'Screen recording', url: 'https://drive.example/rec-1' }] });
    return [{ taskId: first.id, recordingId: 'rec-1', link: 'https://drive.example/rec-1' }];
  });
  deps = {
    state: createCallState(store),
    tasks: { get: async id => board.get(id) },
    people: async () => new Map([['per_ada', { id: 'per_ada', name: 'Ada Obi' }]]),
    share,
    send,
    text: {
      selfName: 'You',
      allTitle: 'Tasks from the call',
      recordingsNote: 'Recordings:',
    },
    now: () => 1000,
    warn: () => {},
  };
}

beforeEach(() =>
  setup([
    task('tsk_aaaaaaaaaa', { ownerId: 'per_ada', ownerName: 'Ada' }),
    task('tsk_bbbbbbbbbb', { ownerId: 'per_ada', ownerName: 'Ada' }),
    task('tsk_cccccccccc', { ownerName: 'Zubi' }),
    task('tsk_dddddddddd', { ownerName: 'Ben', status: 'dropped' }),
  ]),
);

describe('Looks right', () => {
  it('sends nothing and shares nothing until it is pressed', async () => {
    // Everything before the click: the list is drawn, rows are added, nothing goes anywhere
    await addCallListRows(deps.state, MEETING, [
      { id: 'r1', kind: 'mark_done', personKey: 'per_ada', personName: 'Ada Obi', text: 'Mark done?' },
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(meeting.callTasks?.confirmedAt).toBeUndefined();
  });

  it('shares the recordings, then sends one message per person with their tasks and links', async () => {
    const heard: ConfirmedEvent[] = [];
    const off = onCallTasksConfirmed(event => void heard.push(event));
    const state = await confirmCallTasks(MEETING, deps);
    off();

    // The discarded task is left out everywhere
    expect(share).toHaveBeenCalledWith(['tsk_aaaaaaaaaa', 'tsk_bbbbbbbbbb', 'tsk_cccccccccc']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, {
      key: `after-call:${MEETING}:per_ada`,
      title: 'Ada Obi',
      name: 'Ada Obi',
      taskIds: ['tsk_aaaaaaaaaa', 'tsk_bbbbbbbbbb'],
      note: 'Recordings:',
      links: ['https://drive.example/rec-1'],
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      key: `after-call:${MEETING}:name:zubi`,
      title: 'Zubi',
      name: 'Zubi',
      taskIds: ['tsk_cccccccccc'],
    });
    expect(state.confirmedAt).toBe(1000);
    expect(state.sent?.map(item => [item.name, item.whatsapp])).toEqual([
      ['Ada Obi', 'sent'],
      ['Zubi', 'sent'],
    ]);
    // The follow-ups part hears about it
    expect(heard).toEqual([
      {
        meetingId: MEETING,
        taskIds: ['tsk_aaaaaaaaaa', 'tsk_bbbbbbbbbb', 'tsk_cccccccccc'],
        people: [
          { key: 'per_ada', name: 'Ada Obi', personId: 'per_ada', taskIds: ['tsk_aaaaaaaaaa', 'tsk_bbbbbbbbbb'] },
          { key: 'name:zubi', name: 'Zubi', personId: null, taskIds: ['tsk_cccccccccc'] },
        ],
      },
    ]);
  });

  it('does it once: a second press, or two at once, sends nothing more', async () => {
    await Promise.all([confirmCallTasks(MEETING, deps), confirmCallTasks(MEETING, deps)]);
    await confirmCallTasks(MEETING, deps);
    expect(send).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('passes quiet hours on: the message waits, and the list says so', async () => {
    send.mockResolvedValue('queued');
    const state = await confirmCallTasks(MEETING, deps);
    expect(state.sent?.every(item => item.whatsapp === 'queued')).toBe(true);
  });

  it('sends one message for everyone, with each owner, past five people', async () => {
    setup(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((letter, index) =>
        task(`tsk_${letter.repeat(10)}`, { ownerName: `P${index}` }),
      ),
    );
    await confirmCallTasks(MEETING, deps);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      key: `after-call:${MEETING}:all`,
      owner: true,
      title: 'Tasks from the call',
    });
    expect(send.mock.calls[0][0].taskIds).toHaveLength(6);
  });

  it('still sends when sharing fails, and a failed send is said, not retried', async () => {
    share.mockRejectedValue(new Error('Drive is down'));
    send.mockRejectedValueOnce(new Error('not linked'));
    const state = await confirmCallTasks(MEETING, deps);
    expect(state.sent?.map(item => item.whatsapp)).toEqual(['failed', 'sent']);
  });
});

describe('personMessage', () => {
  it('lists the tasks with their extra words and links, ready to forward', () => {
    const text = personMessage(
      {
        key: 'per_ada',
        name: 'Ada',
        personId: 'per_ada',
        tasks: [
          task('tsk_aaaaaaaaaa', {
            title: 'Send the deck',
            detail: 'add the pricing slide',
            links: [{ label: 'r', url: 'https://x/1' }],
          }),
          task('tsk_bbbbbbbbbb', { title: 'Book the venue' }),
        ],
      },
      'Hi Ada, from our call:',
    );
    expect(text).toBe(
      'Hi Ada, from our call:\n1. Send the deck\n   add the pricing slide\n   https://x/1\n2. Book the venue',
    );
  });
});

describe('addCallListRows', () => {
  it('replaces rows with the same id, and can clear one kind', async () => {
    const row = { id: 'r1', kind: 'mark_done', personKey: 'per_ada', personName: 'Ada', text: 'Mark done?' };
    await addCallListRows(deps.state, MEETING, [row]);
    await addCallListRows(deps.state, MEETING, [{ ...row, text: 'Mark done? (2)' }]);
    expect(meeting.callTasks?.rows).toEqual([{ ...row, text: 'Mark done? (2)' }]);
    await addCallListRows(deps.state, MEETING, [], { replaceKind: 'mark_done' });
    expect(meeting.callTasks?.rows).toEqual([]);
  });
});
