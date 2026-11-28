import { describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest, ThreadMessage, ThreadRecord } from '@extension/storage';
import type { DesktopMessage } from '@src/shared/lib/protocol/companion';

vi.mock('@extension/i18n', () => ({
  t: (key: string, subs?: string | string[]) => [key, ...(Array.isArray(subs) ? subs : subs ? [subs] : [])].join('|'),
}));

const { DesktopBridge, DEFAULT_DESKTOP_REMOTE_STATE } = await import('../bridge');
type State = typeof DEFAULT_DESKTOP_REMOTE_STATE;

const CHAT = 'dc_abcdefgh12';
const message = (text: string, chatId = CHAT): DesktopMessage => ({ id: `dm_${text}`, chatId, text, at: 1 });
const thread = (fields: Partial<ThreadRecord> = {}): ThreadRecord =>
  ({ id: 't1', status: 'idle', origin: 'desktop', pendingRequest: null, error: null, ...fields }) as ThreadRecord;
const said = (seq: number, actor: ThreadMessage['actor'], content: string) =>
  ({ seq, actor, content, threadId: 't1' }) as ThreadMessage;

function setup(
  options: { inbox?: DesktopMessage[]; threads?: Record<string, ThreadRecord>; state?: Partial<State> } = {},
) {
  let state: State = { ...DEFAULT_DESKTOP_REMOTE_STATE, ...options.state };
  const threads = { ...options.threads };
  const replies: { chatId: string; kind: string; text: string }[] = [];
  const started: { threadId: string | null; text: string }[] = [];
  let inbox = options.inbox ?? [];
  let messages: ThreadMessage[] = [];
  const bridge = new DesktopBridge({
    inbox: async () => {
      const taken = inbox;
      inbox = [];
      return taken;
    },
    reply: async request => {
      replies.push(request);
    },
    getThread: async id => threads[id],
    messages: async () => messages,
    startTurn: async (threadId, text) => {
      started.push({ threadId, text });
      const id = threadId ?? `t${started.length}`;
      threads[id] = thread({ id, status: 'running' });
      return id;
    },
    getState: async () => state,
    updateState: async changes => {
      state = { ...state, ...changes };
    },
    warn: () => {},
  });
  return {
    bridge,
    replies,
    started,
    threads,
    state: () => state,
    setMessages: (next: ThreadMessage[]) => {
      messages = next;
    },
    push: (next: DesktopMessage[]) => {
      inbox = next;
    },
  };
}

describe('DesktopBridge', () => {
  it('starts a chat for a new conversation, says it is working, and keeps the chat for the next message', async () => {
    const test = setup({ inbox: [message('hello')] });
    await test.bridge.poll();
    expect(test.started).toEqual([{ threadId: null, text: 'hello' }]);
    expect(test.replies).toEqual([{ chatId: CHAT, kind: 'working', text: '' }]);
    expect(test.state().chats).toEqual({ [CHAT]: 't1' });

    test.threads.t1 = thread({ status: 'idle' });
    test.push([message('again')]);
    await test.bridge.poll();
    expect(test.started[1]).toEqual({ threadId: 't1', text: 'again' });
  });

  it('holds words for a busy chat, and sends them in when it is idle with its answer', async () => {
    const test = setup({ inbox: [message('first'), message('second')] });
    await test.bridge.poll();
    // One turn per chat: the second waits
    expect(test.started.map(turn => turn.text)).toEqual(['first']);
    expect(test.state().pending.map(item => item.text)).toEqual(['second']);

    test.setMessages([said(1, 'user', 'first'), said(2, 'planner', 'Done, here it is.')]);
    const before = test.threads.t1;
    test.threads.t1 = thread({ status: 'idle' });
    await test.bridge.onThreadUpdate(before, { status: 'idle' });
    expect(test.replies).toContainEqual({ chatId: CHAT, kind: 'answer', text: 'Done, here it is.' });
    expect(test.started.map(turn => turn.text)).toEqual(['first', 'second']);
    expect(test.state().pending).toEqual([]);

    // The same answer is never sent twice
    const count = test.replies.filter(reply => reply.kind === 'answer').length;
    await test.bridge.onThreadUpdate(thread({ status: 'running' }), { status: 'idle' });
    expect(test.replies.filter(reply => reply.kind === 'answer')).toHaveLength(count);
  });

  it('tells the app when the chat waits for a click or stopped, and not for a retry it queued', async () => {
    const test = setup({ state: { chats: { [CHAT]: 't1' } } });
    const pendingRequest = { id: 'r', kind: 'send', mode: 'commit', target: 'Send to Ada' } as ConfirmRequest;
    await test.bridge.onThreadUpdate(thread({ status: 'running' }), { status: 'waiting_confirm', pendingRequest });
    expect(test.replies[0].kind).toBe('needs_click');

    await test.bridge.onThreadUpdate(thread({ status: 'running' }), {
      status: 'error',
      error: { message: 'Model down https://x.example' } as ThreadRecord['error'],
    });
    expect(test.replies[1]).toMatchObject({ kind: 'error' });
    expect(test.replies[1].text).not.toContain('https://');

    await test.bridge.onThreadUpdate(thread({ status: 'running' }), {
      status: 'error',
      failure: { retryAt: 5 } as ThreadRecord['failure'],
    });
    expect(test.replies).toHaveLength(2);
  });

  it("ignores chats that are not the desktop app's", async () => {
    const test = setup({ state: { chats: { [CHAT]: 't1' } } });
    await test.bridge.onThreadUpdate(thread({ status: 'running', origin: 'user' }), { status: 'idle' });
    expect(test.replies).toEqual([]);
  });

  it('says why when a message could not start', async () => {
    const test = setup({ inbox: [message('hello')] });
    const bridge = new DesktopBridge({
      inbox: async () => [message('hello')],
      reply: async request => {
        test.replies.push(request);
      },
      getThread: async () => undefined,
      messages: async () => [],
      startTurn: async () => {
        throw new Error('No model set');
      },
      getState: async () => test.state(),
      updateState: async () => {},
      warn: () => {},
    });
    await bridge.poll();
    expect(test.replies).toEqual([{ chatId: CHAT, kind: 'error', text: 'No model set' }]);
  });
});
