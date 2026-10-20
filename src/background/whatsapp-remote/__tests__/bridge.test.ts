import { describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest, MeetingRecord, ThreadMessage, ThreadRecord } from '@extension/storage';
import type { WhatsAppMessage, WhatsAppStatus } from '@src/shared/lib/protocol/companion';
import type { WhatsAppRemoteState } from '../state';

vi.mock('@extension/i18n', () => ({
  t: (key: string, subs?: string | string[]) => [key, ...(Array.isArray(subs) ? subs : subs ? [subs] : [])].join('|'),
}));

const { WhatsAppBridge, answerOf } = await import('../bridge');
const { DEFAULT_WHATSAPP_REMOTE_SETTINGS, DEFAULT_WHATSAPP_REMOTE_STATE } = await import('../state');
const { alwaysAsks } = await import('../../gate/origins');
const { isAttendedThread } = await import('../../agents/handoff');

const LINKED: WhatsAppStatus = {
  state: 'linked',
  qr: null,
  number: '2348011111111',
  ownerNumber: null,
  message: null,
  queued: 0,
  sentLastHour: 0,
  sendLimitPerHour: 20,
};

const thread = (fields: Partial<ThreadRecord> = {}): ThreadRecord =>
  ({
    id: 'wa-thread',
    title: 'WhatsApp · Tue',
    status: 'idle',
    origin: 'whatsapp',
    pendingRequest: null,
    error: null,
    archived: false,
    boundTabIds: [],
    ...fields,
  }) as ThreadRecord;

const request = (fields: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  id: 'req-1',
  taskId: 'wa-thread',
  mode: 'commit',
  kind: 'send',
  intent: 'Send the reply',
  target: 'Send to Tomi',
  pageTitle: '',
  pageUrl: '',
  fields: [],
  context: '',
  ...fields,
});

function harness(
  options: { messages?: WhatsAppMessage[]; status?: WhatsAppStatus; thread?: ThreadRecord; hour?: number } = {},
) {
  let state: WhatsAppRemoteState = { ...DEFAULT_WHATSAPP_REMOTE_STATE, status: options.status ?? LINKED };
  let settings = { ...DEFAULT_WHATSAPP_REMOTE_SETTINGS };
  const inbox = [...(options.messages ?? [])];
  const sent: { text: string; kind: string; replyTo?: string }[] = [];
  const acked: string[] = [];
  const turns: { threadId: string; text: string }[] = [];
  const created: Partial<ThreadRecord>[] = [];
  const chats = new Map<string, ThreadRecord>();
  const messages = new Map<string, ThreadMessage[]>();
  if (options.thread) chats.set(options.thread.id, options.thread);
  const now = new Date(2026, 9, 20, options.hour ?? 12, 0).getTime();
  const startTurn = vi.fn(async (threadId: string, text: string) => {
    turns.push({ threadId, text });
  });
  const bridge = new WhatsAppBridge({
    inbox: async () => ({ messages: inbox.splice(0), status: state.status ?? LINKED }),
    ack: async ids => void acked.push(...ids),
    send: async message => void sent.push(message),
    getThread: async id => chats.get(id),
    createThread: async fields => {
      created.push(fields);
      const made = thread({ id: `made-${created.length}`, ...fields });
      chats.set(made.id, made);
      return made;
    },
    messages: async id => messages.get(id) ?? [],
    ensureTab: async () => {},
    startTurn,
    getState: async () => state,
    updateState: async changes => {
      state = { ...state, ...changes };
    },
    settings: async () => settings,
    now: () => now,
    warn: () => {},
  });
  return {
    bridge,
    sent,
    acked,
    turns,
    created,
    chats,
    messages,
    startTurn,
    state: () => state,
    setState: (changes: Partial<typeof state>) => {
      state = { ...state, ...changes };
    },
    setSettings: (changes: Partial<typeof settings>) => {
      settings = { ...settings, ...changes };
    },
  };
}

const msg = (id: string, text: string): WhatsAppMessage => ({ id, text, at: 1 });

describe('WhatsApp messages into a chat', () => {
  it('puts the owner’s messages into the day’s WhatsApp chat as one turn, then acks them', async () => {
    const h = harness({ messages: [msg('a', 'what is on today?'), msg('b', 'and check my inbox')] });
    await h.bridge.poll();
    expect(h.created).toEqual([expect.objectContaining({ origin: 'whatsapp', tags: ['whatsapp'] })]);
    expect(h.turns).toEqual([{ threadId: 'made-1', text: 'what is on today?\n\nand check my inbox' }]);
    expect(h.acked).toEqual(['a', 'b']);
    expect(h.state()).toMatchObject({ threadId: 'made-1', replyTo: 'b' });
  });

  it('keeps using the same chat during the day', async () => {
    const h = harness({ messages: [msg('a', 'one')] });
    await h.bridge.poll();
    const again = harness({ messages: [msg('b', 'two')], thread: thread({ id: 'made-1' }) });
    again.setState({ threadId: 'made-1', threadDay: h.state().threadDay });
    await again.bridge.poll();
    expect(again.created).toEqual([]);
    expect(again.turns).toEqual([{ threadId: 'made-1', text: 'two' }]);
  });

  it('leaves messages queued while the chat is still working', async () => {
    const h = harness({ messages: [msg('a', 'one')], thread: thread({ status: 'running' }) });
    h.setState({ threadId: 'wa-thread', threadDay: '2026-10-20' });
    await h.bridge.poll();
    expect(h.turns).toEqual([]);
    expect(h.acked).toEqual([]);
  });

  it('while the chat waits for a click, says so once and keeps the message for after', async () => {
    const waiting = thread({ status: 'waiting_confirm', pendingRequest: request() });
    const h = harness({ messages: [msg('a', 'done?')], thread: waiting });
    h.setState({ threadId: 'wa-thread', threadDay: '2026-10-20' });
    await h.bridge.poll();
    await h.bridge.poll();
    expect(h.turns).toEqual([]);
    expect(h.acked).toEqual([]);
    expect(h.sent).toEqual([{ text: 'wava_reply_stillWaiting|send: Send to Tomi', kind: 'reply', replyTo: 'a' }]);
  });

  it('does nothing when WhatsApp is not linked', async () => {
    const h = harness({ messages: [msg('a', 'one')], status: { ...LINKED, state: 'disconnected' } });
    await h.bridge.poll();
    expect(h.turns).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it('says why when a turn could not start, and does not try the same message again', async () => {
    const h = harness({ messages: [msg('a', 'one')] });
    h.startTurn.mockRejectedValueOnce(new Error('Too many chats are running.'));
    await h.bridge.poll();
    expect(h.acked).toEqual(['a']);
    expect(h.sent).toEqual([{ text: 'wava_reply_failed|Too many chats are running.', kind: 'reply', replyTo: 'a' }]);
  });
});

describe('answers back on WhatsApp', () => {
  const said = (seq: number, actor: ThreadMessage['actor'], content: string) =>
    ({ id: `m${seq}`, threadId: 'wa-thread', seq, actor, content, ts: seq }) as ThreadMessage;

  it('sends the turn’s answer once, as WhatsApp text, to the chat the message came from', async () => {
    const h = harness();
    h.setState({ replyTo: 'b' });
    h.messages.set('wa-thread', [
      said(1, 'user', 'what is on today?'),
      said(2, 'navigator', 'Opening the calendar'),
      said(3, 'planner', '## Today\n\n- **10:00** Standup\n\n| Time | What |\n|---|---|\n| 14:00 | Review |'),
    ]);
    await h.bridge.onThreadUpdate(thread({ status: 'running' }), { status: 'idle' });
    await h.bridge.onThreadUpdate(thread({ status: 'running' }), { status: 'idle' });
    expect(h.sent).toEqual([
      { text: '*Today*\n\n• *10:00* Standup\n\nTime · What\n14:00 · Review', kind: 'reply', replyTo: 'b' },
    ]);
  });

  it('holds a commit: tells him it needs his click in the browser, and approves nothing', async () => {
    const h = harness();
    await h.bridge.onThreadUpdate(thread({ status: 'running' }), {
      status: 'waiting_confirm',
      pendingRequest: request(),
    });
    expect(h.sent).toEqual([{ text: 'wava_reply_needsClick|send: Send to Tomi', kind: 'reply' }]);
    expect(h.startTurn).not.toHaveBeenCalled();
  });

  it('says when the turn stopped', async () => {
    const h = harness();
    await h.bridge.onThreadUpdate(thread({ status: 'running' }), {
      status: 'error',
      error: { kind: 'tab_closed', message: 'The tab was closed.' },
    });
    expect(h.sent[0].text).toBe('wava_reply_stopped|The tab was closed.');
  });

  it('picks the answer after the last message he sent', () => {
    expect(
      answerOf([said(1, 'user', 'a'), said(2, 'planner', 'old'), said(3, 'user', 'b'), said(4, 'system', 'Cancelled')])
        ?.content,
    ).toBe('Cancelled');
    expect(answerOf([said(1, 'user', 'a')])).toBeNull();
  });
});

describe('Ava messages him first', () => {
  it('when another chat waits for approval, even in quiet hours', async () => {
    const h = harness({ hour: 23 });
    await h.bridge.onThreadUpdate(
      thread({ id: 'other', origin: 'workflow', title: 'Pay invoice', status: 'running' }),
      {
        status: 'waiting_confirm',
        pendingRequest: request({ kind: 'purchase', target: 'Pay now' }),
      },
    );
    expect(h.sent).toEqual([{ text: '*wava_notice_approval|Pay invoice|purchase: Pay now*', kind: 'approval' }]);
  });

  it('keeps quiet in quiet hours and for kinds switched off, and sends a notice once', async () => {
    const night = harness({ hour: 23 });
    await night.bridge.notice({ kind: 'brief', title: 'Your brief', body: 'x', key: 'brief:1' });
    expect(night.sent).toEqual([]);

    const day = harness({ hour: 9 });
    day.setSettings({ notify: { ...DEFAULT_WHATSAPP_REMOTE_SETTINGS.notify, routine: false } });
    await day.bridge.notice({ kind: 'routine', title: 'Reminder', key: 'r:1' });
    expect(day.sent).toEqual([]);
    await day.bridge.notice({ kind: 'brief', title: 'Your brief', body: '- 3 meetings', key: 'brief:1' });
    await day.bridge.notice({ kind: 'brief', title: 'Your brief', body: '- 3 meetings', key: 'brief:1' });
    expect(day.sent).toEqual([{ text: '*Your brief*\n\n• 3 meetings', kind: 'brief' }]);
  });

  it('says nothing first while WhatsApp is not linked', async () => {
    const h = harness({ status: { ...LINKED, state: 'not_linked' } });
    await h.bridge.notice({ kind: 'approval', title: 'x', key: 'k' });
    expect(h.sent).toEqual([]);
  });

  it('when meeting notes are ready', async () => {
    const h = harness();
    const before = { id: 'meet-1', title: 'Weekly sync', status: 'finishing', note: null } as unknown as MeetingRecord;
    await h.bridge.onMeetingUpdate(before, {
      status: 'done',
      note: {
        title: 'Weekly sync',
        tldr: ['Launch moves'],
        decisions: [],
        actionItems: [{ owner: 'Avi', task: 'Tell Tomi', due: null }],
        openQuestions: [],
        participants: [],
      },
    });
    expect(h.sent).toEqual([
      { text: '*wava_notice_meeting|Weekly sync*\n\n• Launch moves\n☐ Avi: Tell Tomi', kind: 'meeting' },
    ]);
  });
});

describe('a chat from WhatsApp', () => {
  it('always asks before it commits, whatever the confirm settings say', () => {
    expect(alwaysAsks({ origin: 'whatsapp' })).toBe(true);
    expect(alwaysAsks({ origin: 'workflow' })).toBe(true);
    expect(alwaysAsks({ origin: 'user' })).toBe(false);
    expect(alwaysAsks(undefined)).toBe(true);
  });

  it('is not one the user is at: no hand-offs and nothing said in a call for him', () => {
    expect(isAttendedThread({ origin: 'whatsapp' })).toBe(false);
    expect(isAttendedThread({ origin: 'user' })).toBe(true);
  });
});
