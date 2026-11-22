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

const { permissionRulesStore, threadStore, toolScope } = await import('@extension/storage');
const { reviewToolCall } = await import('../gate');
const { ConfirmGate } = await import('../../gate/confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
import type { ConfirmRequest } from '@extension/storage';
import type { AgentContext } from '../../agent/types';

/** A saved "Allow every time" for one connector tool never answers for a run that read content from outside. */

const review = {
  connector: { id: 'c1', name: 'Mail', url: 'https://mcp.example/mcp' },
  tool: { tool: 'send_message', title: 'Send a message', annotations: null, hash: 'h1' },
  args: { to: 'someone@example.com', body: 'Hello' },
  intent: 'Send it',
};

function user(taskId: string, always: boolean) {
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
      setTimeout(() => confirmGate.answer(card.id, true, undefined, always));
    },
  } as unknown as AgentContext;
  return { context, cards };
}

beforeEach(async () => {
  for (const rule of await permissionRulesStore.list()) await permissionRulesStore.remove(rule.id);
  await permissionRulesStore.allow({
    kind: 'tool',
    scope: toolScope('c1', 'send_message', 'h1'),
    label: 'Run Mail › Send a message',
  });
});

describe('a connector tool call and a saved rule', () => {
  it('is approved without a card on a clean chat', async () => {
    const thread = await threadStore.create({ origin: 'user' });
    const run = user(thread.id, false);
    expect(await reviewToolCall(run.context, review)).toBe('approved');
    expect(run.cards).toHaveLength(0);
    expect((await permissionRulesStore.list())[0]!.uses).toBe(1);
  });

  it('shows the card, offers no rule and saves none on a tainted run', async () => {
    for (const fields of [
      { origin: 'agent' as const, tainted: true },
      { origin: 'agent' as const },
      { tainted: true },
    ]) {
      const thread = await threadStore.create(fields);
      const run = user(thread.id, true);
      expect(await reviewToolCall(run.context, review)).toBe('approved');
      expect(run.cards).toHaveLength(1);
      expect(run.cards[0]!.always).toBeUndefined();
    }
    expect(await permissionRulesStore.list()).toHaveLength(1);
    expect((await permissionRulesStore.list())[0]!.uses).toBe(0);
  });

  it('shows the card when the chat cannot be read', async () => {
    const run = user('no-such-chat', false);
    expect(await reviewToolCall(run.context, review)).toBe('approved');
    expect(run.cards).toHaveLength(1);
    expect(run.cards[0]!.always).toBeUndefined();
  });
});
