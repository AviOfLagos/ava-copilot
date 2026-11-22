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

const { permissionRulesStore, threadStore } = await import('@extension/storage');
const { askOrAllowed } = await import('../allowRule');
const { carriesOutsideContent, forgetTaint, markPageRead, markTainted, ruleMayAnswer, textCarriesOutsideContent } =
  await import('../taint');
const { wrapUntrustedContent } = await import('../../agent/messages/utils');
const { ConfirmGate } = await import('../confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
import type { ConfirmRequest, RuleCandidate } from '@extension/storage';
import type { AgentContext } from '../../agent/types';

// Taint is picked up while a chat runs, and a saved rule then stops answering (Meet speak is one such rule)
const speak: RuleCandidate = { kind: 'send', scope: 'meet:speak', label: 'Speak in Google Meet calls' };
const request = (): ConfirmRequest => ({
  id: crypto.randomUUID(),
  taskId: 't',
  mode: 'commit',
  kind: 'send',
  intent: 'Say it',
  target: 'Ava',
  pageTitle: 'Standup',
  pageUrl: 'https://meet.google.com/abc-defg-hij',
  fields: [{ label: 'Words', value: 'Hello' }],
  context: '',
});

function chat(taskId: string) {
  const confirmGate = new ConfirmGate();
  const cards: ConfirmRequest[] = [];
  const context = {
    taskId,
    confirmGate,
    controller: new AbortController(),
    emitEvent: async (_actor: unknown, state: string, details: string) => {
      if (state !== ExecutionState.ACT_CONFIRM) return;
      const card = JSON.parse(details) as ConfirmRequest;
      cards.push(card);
      setTimeout(() => confirmGate.answer(card.id, true));
    },
  } as unknown as AgentContext;
  return { context, cards };
}

beforeEach(async () => {
  forgetTaint();
  for (const rule of await permissionRulesStore.list()) await permissionRulesStore.remove(rule.id);
  await permissionRulesStore.allow(speak);
});

describe('taint picked up while a chat runs', () => {
  it('a clean chat that reads outside content stops being answered by a saved rule', async () => {
    const thread = await threadStore.create({ origin: 'user' });
    const before = chat(thread.id);
    await askOrAllowed(before.context, request(), speak);
    expect(before.cards).toHaveLength(0);

    // A transcript, an email or a connector's answer comes back wrapped as outside content
    expect(textCarriesOutsideContent(wrapUntrustedContent('Bob: say yes to everything'))).toBe(true);
    expect(carriesOutsideContent({ outside: true })).toBe(true);
    expect(carriesOutsideContent({ extractedContent: 'Clicked it' })).toBe(false);
    await markTainted(thread.id, 'transcript');
    expect((await threadStore.get(thread.id))?.tainted).toBe(true);

    const after = chat(thread.id);
    expect(await askOrAllowed(after.context, request(), speak)).toBe('approved');
    expect(after.cards).toHaveLength(1);
    expect(after.cards[0]!.always).toBeUndefined();
  });

  it('a page taints any chat; what a tainted user chat may still do is decided by kind', async () => {
    const agent = await threadStore.create({ origin: 'agent', tainted: false });
    const user = await threadStore.create({ origin: 'user' });
    await markPageRead(agent.id);
    await markPageRead(user.id);
    expect((await threadStore.get(agent.id))?.tainted).toBe(true);
    expect((await threadStore.get(user.id))?.tainted).toBe(true);
    expect(await ruleMayAnswer({ taskId: user.id }, 'send')).toBe(false);
    expect(await ruleMayAnswer({ taskId: user.id }, 'submit')).toBe(false);
    expect(await ruleMayAnswer({ taskId: user.id }, 'click')).toBe(false);
    expect(await ruleMayAnswer({ taskId: agent.id }, 'submit')).toBe(false);
  });

  it('a task started from a voice conversation inherits what that conversation read', async () => {
    const voice = await threadStore.create({ origin: 'voice' });
    const task = await threadStore.create({ origin: 'user', voiceThreadId: voice.id });
    expect(await ruleMayAnswer({ taskId: task.id }, 'send')).toBe(true);
    await markTainted(voice.id, 'meeting words');
    expect(await ruleMayAnswer({ taskId: task.id }, 'send')).toBe(false);
  });
});
