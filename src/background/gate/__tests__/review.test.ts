import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(data, items),
        onChanged: { addListener: () => undefined },
      },
    },
    i18n: { getMessage: (key: string) => key },
  });
});

const { db, onceStore, threadStore } = await import('@extension/storage');
const { reviewAction, settleCommit, verifyCommit } = await import('../review');
const { readCommitContent, readCommitEffect, readFocus } = await import('../probes');
const { ConfirmGate } = await import('../confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
const { DOMElementNode, DOMTextNode } = await import('../../browser/dom/views');
import type { ConfirmRequest } from '@extension/storage';
import type { AgentContext } from '../../agent/types';
import type Page from '../../browser/page';
import type { FocusReading } from '../probes';

/**
 * Do-once keys on a page (docs/growth-team.md, Part 2, issue #64). The page here is a chat composer on
 * mail.example: the tests count how often the send really runs, the way the builder's click and Enter do.
 */

interface PageState {
  url: string;
  fields: { label: string; value: string }[];
  // How many times a send really happened on the page
  sends: number;
}

const composerFocus: FocusReading = {
  where: 'element',
  element: { tagName: 'div', attributes: { role: 'textbox' }, text: '', editable: true, form: null, ancestry: '' },
};

function fakePage(state: PageState): Page {
  const content = () => ({ fields: state.fields, context: '' });
  return {
    url: () => state.url,
    title: async () => 'Compose',
    evaluateInPage: async (fn: unknown, arg: unknown) => {
      if (fn === readFocus) return composerFocus;
      if (fn === readCommitContent) return content();
      if (fn === readCommitEffect) {
        const snippets = arg as string[];
        return { url: state.url, visible: snippets.map(() => state.sends), pending: snippets.map(() => false) };
      }
      throw new Error('unexpected probe');
    },
    locateElement: async () => ({
      evaluate: async (fn: unknown) => (fn === readCommitContent ? content() : 'Send'),
    }),
  } as unknown as Page;
}

function sendButton() {
  const node = new DOMElementNode({
    tagName: 'button',
    xpath: 'button',
    attributes: {},
    children: [],
    isVisible: true,
  });
  node.children = [new DOMTextNode('Send', true, node)];
  return node;
}

function fakeContext(threadId: string, answer: 'approve' | 'decline' = 'approve') {
  const confirmGate = new ConfirmGate();
  const requests: ConfirmRequest[] = [];
  const context = {
    taskId: threadId,
    confirmGate,
    controller: new AbortController(),
    stop: vi.fn(async () => confirmGate.cancelAll()),
    emitEvent: vi.fn(async (_actor: unknown, state: string, details: string) => {
      if (state === ExecutionState.ACT_CONFIRM) {
        const request = JSON.parse(details) as ConfirmRequest;
        requests.push(request);
        setTimeout(() => confirmGate.answer(request.id, answer === 'approve'));
      }
    }),
  };
  return { context: context as unknown as AgentContext, requests, stop: context.stop };
}

const pressEnter = { action: 'send_keys' as const, args: { keys: 'Enter', intent: 'Send the reply' } };
const clickSend = () => ({ action: 'click_element' as const, args: { index: 3, intent: 'Send' }, node: sendButton() });

/** Does what the builder does with a reviewed action: runs it only when the gate lets it through. */
async function act(context: AgentContext, page: Page, state: PageState, gated: Parameters<typeof reviewAction>[2]) {
  const review = await reviewAction(context, page, gated);
  if (review.proceed) state.sends += 1;
  return review;
}

/** A chat with a task running in it; `restart` is the background coming back and resuming the same task. */
async function runningThread() {
  const thread = await threadStore.create({ origin: 'user' });
  await threadStore.update(thread.id, {
    taskRunId: `task-of-${thread.id}`,
    runStartedAt: Date.now() - 1,
    status: 'running',
  });
  return thread.id;
}
const restart = (threadId: string) => threadStore.update(threadId, { runStartedAt: Date.now() });
// The next run starts a moment later than anything recorded before it
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

let state: PageState;
let page: Page;

beforeEach(async () => {
  await db.doOnce.clear();
  state = {
    url: 'https://mail.example/compose?draft=1',
    fields: [{ label: 'Message', value: 'See you at 10.' }],
    sends: 0,
  };
  page = fakePage(state);
});

describe('do once on a page', () => {
  it('does not send again when the background is killed right after a send, before the result is recorded', async () => {
    const threadId = await runningThread();
    const first = fakeContext(threadId);
    const sent = await act(first.context, page, state, pressEnter);
    expect(sent.proceed).toBe(true);
    expect(state.sends).toBe(1);
    // Killed here: verifyCommit never ran, so the record is still at "started"
    const key = sent.proceed ? sent.commit?.onceKey : null;
    expect((await onceStore.get(key!))?.status).toBe('started');

    // The background restarts and the task is resumed. The model gets there another way (the button, a new
    // draft address) and tries the same send.
    await tick();
    await restart(threadId);
    state.url = 'https://mail.example/compose?draft=2';
    const retry = fakeContext(threadId);
    const again = await act(retry.context, page, state, clickSend());
    expect(again.proceed).toBe(false);
    expect(state.sends).toBe(1);
    // No card: the model is told to look for evidence first
    expect(retry.requests).toHaveLength(0);
    expect(again.proceed ? '' : again.result.error).toMatch(/cut off before its result was recorded/);

    // It tries once more in the same run: only the user's click can run it, and the card says why
    const third = await act(retry.context, page, state, clickSend());
    expect(retry.requests).toHaveLength(1);
    expect(retry.requests[0].repeat?.status).toBe('started');
    expect(third.proceed).toBe(true);
    expect(state.sends).toBe(2);
  });

  it('stops the task and sends nothing when the user declines the repeat', async () => {
    const threadId = await runningThread();
    await act(fakeContext(threadId).context, page, state, pressEnter);
    const retry = fakeContext(threadId, 'decline');
    await act(retry.context, page, state, pressEnter);
    const asked = await act(retry.context, page, state, pressEnter);
    expect(asked.proceed).toBe(false);
    expect(retry.requests[0].repeat?.status).toBe('started');
    expect(retry.stop).toHaveBeenCalled();
    expect(state.sends).toBe(1);
  });

  it('holds back a reworded send on the same site while an earlier one is cut off', async () => {
    const threadId = await runningThread();
    await act(fakeContext(threadId).context, page, state, pressEnter);
    await tick();
    await restart(threadId);
    // A retry seldom writes the message the same way twice
    state.fields = [{ label: 'Message', value: 'See you at ten!' }];
    const retry = fakeContext(threadId);
    const again = await act(retry.context, page, state, pressEnter);
    expect(again.proceed).toBe(false);
    expect(state.sends).toBe(1);
  });

  it('skips a step that is done, and still lets a different one through', async () => {
    const threadId = await runningThread();
    const first = fakeContext(threadId);
    const sent = await act(first.context, page, state, pressEnter);
    expect(await verifyCommit(first.context, page, sent.proceed ? sent.commit : null)).toBe('gate_verify_shown');
    const key = sent.proceed ? sent.commit?.onceKey : null;
    expect((await onceStore.get(key!))?.status).toBe('done');

    await tick();
    await restart(threadId);
    const retry = fakeContext(threadId);
    const again = await act(retry.context, page, state, clickSend());
    expect(again.proceed ? '' : again.result.error).toMatch(/Already done in this task/);
    expect(retry.requests).toHaveLength(0);
    expect(state.sends).toBe(1);

    // The next message of the same task is a different step: the usual card, no repeat note
    state.fields = [{ label: 'Message', value: 'And bring the deck.' }];
    const next = await act(retry.context, page, state, pressEnter);
    expect(next.proceed).toBe(true);
    expect(retry.requests[0].repeat).toBeUndefined();
    expect(state.sends).toBe(2);
  });

  it('starts clean for a new request in the same chat', async () => {
    const threadId = await runningThread();
    const first = fakeContext(threadId);
    const sent = await act(first.context, page, state, pressEnter);
    await settleCommit(sent.proceed ? sent.commit : null, 'shown');
    // The user asks for the same thing again: a new task, so it is theirs to have
    await threadStore.update(threadId, { taskRunId: 'a-new-request', runStartedAt: Date.now() });
    const again = await act(fakeContext(threadId).context, page, state, pressEnter);
    expect(again.proceed).toBe(true);
    expect(state.sends).toBe(2);
  });

  it('tells two chats apart when the caller names the step', async () => {
    const threadId = await runningThread();
    const context = fakeContext(threadId);
    const toChat = (chat: string) => ({
      ...pressEnter,
      once: { what: 'whatsapp.send', scope: 'web.whatsapp.com', label: 'send on WhatsApp', parts: [chat, 'On my way'] },
    });
    const first = await act(context.context, page, state, toChat('ada'));
    await settleCommit(first.proceed ? first.commit : null, 'shown');
    expect((await act(context.context, page, state, toChat('tomi'))).proceed).toBe(true);
    expect((await act(context.context, page, state, toChat('ada'))).proceed).toBe(false);
    expect(state.sends).toBe(2);
  });

  it('keeps no message text in the record', async () => {
    const threadId = await runningThread();
    await act(fakeContext(threadId).context, page, state, pressEnter);
    const records = await db.doOnce.toArray();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('See you');
    expect(records[0].label).toBe('send on mail.example');
  });

  it('writes nothing for an action that only fills a field', async () => {
    const threadId = await runningThread();
    const review = await reviewAction(fakeContext(threadId).context, page, { ...clickSend(), once: false });
    expect(review.proceed && review.commit?.onceKey).toBeNull();
    expect(await db.doOnce.count()).toBe(0);
  });
});
