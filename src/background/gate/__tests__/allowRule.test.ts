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

const { permissionRulesStore } = await import('@extension/storage');
const { askOrAllowed } = await import('../allowRule');
const { ConfirmGate } = await import('../confirmGate');
const { ExecutionState } = await import('../../agent/event/types');
import type { ConfirmRequest, RuleCandidate } from '@extension/storage';
import type { AgentContext } from '../../agent/types';

/** One card with a rule behind it, for a place with no page to read a scope from (speaking in a call). */

const speak: RuleCandidate = { kind: 'send', scope: 'meet:speak', label: 'Speak in Google Meet calls' };

function request(): ConfirmRequest {
  return {
    id: crypto.randomUUID(),
    taskId: 't1',
    mode: 'commit',
    kind: 'send',
    intent: 'Say it',
    target: 'Ava',
    pageTitle: 'Standup',
    pageUrl: 'https://meet.google.com/abc-defg-hij',
    fields: [{ label: 'Words', value: 'Hello' }],
    context: '',
  };
}

/** A task whose user answers every card: Allow once, or Allow every time. */
function user(answer: 'approve' | 'decline', always: boolean) {
  const confirmGate = new ConfirmGate();
  const cards: ConfirmRequest[] = [];
  const context = {
    taskId: 't1',
    confirmGate,
    controller: new AbortController(),
    emitEvent: async (_actor: unknown, state: string, details: string) => {
      if (state !== ExecutionState.ACT_CONFIRM) return;
      const card = JSON.parse(details) as ConfirmRequest;
      cards.push(card);
      setTimeout(() => confirmGate.answer(card.id, answer === 'approve', undefined, always));
    },
  } as unknown as AgentContext;
  return { context, cards };
}

beforeEach(async () => {
  for (const rule of await permissionRulesStore.list()) await permissionRulesStore.remove(rule.id);
});

describe('askOrAllowed', () => {
  it('offers Allow every time, saves the rule on it, and skips the card afterwards', async () => {
    const first = user('approve', true);
    expect(await askOrAllowed(first.context, request(), speak)).toBe('approved');
    expect(first.cards[0]!.always).toMatchObject({ kind: 'send', scope: 'meet:speak' });
    expect(await permissionRulesStore.list()).toHaveLength(1);

    const later = user('decline', false);
    expect(await askOrAllowed(later.context, request(), speak)).toBe('approved');
    expect(later.cards).toHaveLength(0);
    expect((await permissionRulesStore.list())[0]!.uses).toBe(1);
  });

  it('Allow once and a refusal save nothing', async () => {
    expect(await askOrAllowed(user('approve', false).context, request(), speak)).toBe('approved');
    expect(await askOrAllowed(user('decline', true).context, request(), speak)).toBe('declined');
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });

  it('never offers a rule for money, deleting or access', async () => {
    for (const kind of ['purchase', 'delete', 'permission'] as const) {
      const asked = user('approve', true);
      const candidate: RuleCandidate = { kind, scope: 'meet:speak', label: kind };
      expect(await askOrAllowed(asked.context, { ...request(), kind }, candidate)).toBe('approved');
      expect(asked.cards[0]!.always).toBeUndefined();
    }
    expect(await permissionRulesStore.list()).toHaveLength(0);
  });
});
