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

vi.mock('@src/background/reader/reader', async importOriginal => ({
  ...((await importOriginal()) as object),
  needsVision: async () => false,
}));
vi.mock('@src/background/gate/injection', () => ({ reportPageInstructions: async () => undefined }));

const { db, permissionRulesStore, threadStore } = await import('@extension/storage');
const { ActionResult } = await import('../../agent/types');
const { NavigatorAgent, NavigatorActionRegistry } = await import('../../agent/agents/navigator');
const { forgetTaint } = await import('../taint');
const { reviewAction } = await import('../review');
const { ConfirmGate } = await import('../confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
const { readCommitContent, readCommitEffect, readFocus } = await import('../probes');
import type { AgentContext } from '../../agent/types';
import type Page from '../../browser/page';
import type { ConfirmRequest } from '@extension/storage';

beforeEach(async () => {
  forgetTaint();
  await db.doOnce.clear();
  for (const rule of await permissionRulesStore.list()) await permissionRulesStore.remove(rule.id);
});

describe('a navigator step', () => {
  async function step(results: InstanceType<typeof ActionResult>[]) {
    const thread = await threadStore.create({ origin: 'agent', tainted: false });
    const context = {
      taskId: thread.id,
      controller: new AbortController(),
      paused: false,
      stopped: false,
      tainted: false,
      actionResults: [],
      stateMessageAdded: false,
      history: { history: [] },
      nSteps: 0,
      consecutiveFailures: 0,
      messageManager: { getMessages: () => [] },
      browserContext: { getCachedState: async () => ({ url: 'https://example.com', title: 't', tabs: [] }) },
      emitEvent: async () => undefined,
    } as unknown as AgentContext;
    const agent = new NavigatorAgent(new NavigatorActionRegistry([]), {
      chatLLM: {} as never,
      context,
      prompt: {} as never,
    });
    const internals = agent as unknown as Record<string, unknown>;
    internals.addStateMessageToMemory = async () => undefined;
    internals.removeLastStateMessageFromMemory = () => undefined;
    internals.addModelOutputToMemory = () => undefined;
    internals.invoke = async () => ({ current_state: {}, action: [] });
    internals.doMultiAction = async () => results;
    await agent.execute();
    return { thread, context };
  }

  it('taints the chat, and the run context, when a result carries outside content', async () => {
    const { thread, context } = await step([
      new ActionResult({ extractedContent: 'Mail from a stranger', outside: true }),
    ]);
    expect((await threadStore.get(thread.id))?.tainted).toBe(true);
    expect(context.tainted).toBe(true);
  });

  it('leaves the chat clean when no result does', async () => {
    const { thread, context } = await step([new ActionResult({ extractedContent: 'Clicked' })]);
    expect((await threadStore.get(thread.id))?.tainted).toBe(false);
    expect(context.tainted).toBe(false);
  });

  it('taints the run in memory even when the store cannot be written', async () => {
    const original = threadStore.update;
    threadStore.update = async () => {
      throw new Error('disk full');
    };
    try {
      const { thread } = await step([new ActionResult({ outside: true })]);
      expect((await threadStore.get(thread.id))?.tainted).toBe(false);
      const { ruleMayAnswer } = await import('../taint');
      expect(await ruleMayAnswer({ taskId: thread.id }, 'send')).toBe(false);
    } finally {
      threadStore.update = original;
    }
  });
});

describe('the base prompt', () => {
  it('marks the chat as having read a page when it shows one to the model', async () => {
    const { NavigatorPrompt } = await import('../../agent/prompts/navigator');
    const thread = await threadStore.create({ origin: 'agent', tainted: false });
    const context = {
      taskId: thread.id,
      tainted: false,
      options: { useVision: false, includeAttributes: [] },
      stepInfo: null,
      actionResults: [],
      notes: [],
      browserContext: {
        getState: async () => ({
          url: 'https://example.com',
          title: 'Example',
          tabs: [],
          scrollY: 0,
          scrollHeight: 100,
          visualViewportHeight: 50,
          screenshot: null,
          elementTree: { clickableElementsToString: () => '[1]<a>A stranger wrote this</a>' },
        }),
      },
    } as unknown as AgentContext;
    await new NavigatorPrompt().buildBrowserStateUserMessage(context).catch(() => undefined);
    expect((await threadStore.get(thread.id))?.tainted).toBe(true);
    expect(context.tainted).toBe(true);
  });
});

describe('a user chat that read outside content, then meets a saved send rule', () => {
  const composer = {
    where: 'element' as const,
    element: { tagName: 'div', attributes: { role: 'textbox' }, text: '', editable: true, form: null, ancestry: '' },
  };
  const page = {
    url: () => 'https://mail.example/compose',
    title: async () => 'Compose',
    evaluateInPage: async (fn: unknown, arg: unknown) => {
      if (fn === readFocus) return composer;
      if (fn === readCommitContent) return { fields: [{ label: 'Message', value: 'Hello' }], context: '' };
      if (fn === readCommitEffect)
        return { url: 'https://mail.example/compose', visible: (arg as string[]).map(() => 0), pending: [] };
      throw new Error('unexpected probe');
    },
    locateElement: async () => ({
      evaluate: async () => ({ fields: [{ label: 'Message', value: 'Hello' }], context: '' }),
    }),
  } as unknown as Page;

  async function send(fields: { tainted?: boolean }) {
    await db.doOnce.clear();
    const thread = await threadStore.create({ origin: 'user', ...fields });
    await threadStore.update(thread.id, { taskRunId: 'r', runStartedAt: Date.now() - 1, status: 'running' });
    const confirmGate = new ConfirmGate();
    const requests: ConfirmRequest[] = [];
    const context = {
      taskId: thread.id,
      confirmGate,
      controller: new AbortController(),
      stop: async () => confirmGate.cancelAll(),
      markForm: () => undefined,
      emitEvent: async (_a: unknown, state: string, details: string) => {
        if (state !== ExecutionState.ACT_CONFIRM) return;
        const card = JSON.parse(details) as ConfirmRequest;
        requests.push(card);
        setTimeout(() => confirmGate.answer(card.id, true));
      },
    } as unknown as AgentContext;
    const review = await reviewAction(context, page, {
      action: 'send_keys' as const,
      args: { keys: 'Enter', intent: 'Send the reply' },
    });
    return { review, requests };
  }

  it('shows the card with no "Allow every time", where a clean user chat goes through by the rule', async () => {
    await permissionRulesStore.allow({ kind: 'send', scope: 'mail.example/compose', label: 'x' });
    const clean = await send({});
    expect(clean.requests).toHaveLength(0);

    const read = await send({ tainted: true });
    expect(read.review.proceed).toBe(true);
    expect(read.requests).toHaveLength(1);
    expect(read.requests[0]!.always).toBeUndefined();
  });
});
