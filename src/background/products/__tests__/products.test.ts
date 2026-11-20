import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyProductProfile } from '@extension/storage';
import type { ConfirmRequest, ProductProfile } from '@extension/storage';
import type * as StorageModule from '@extension/storage';
import type { AgentContext } from '../../agent/types';

const state = {
  thread: { workspaceId: 'acme' as string | null },
  workspaces: [{ id: 'acme', name: 'Acme', about: 'Invoices.', keywords: [], accounts: {}, createdAt: 0 }],
  products: {} as Record<string, ProductProfile>,
};
vi.mock('@extension/storage', async original => ({
  ...(await original<typeof StorageModule>()),
  threadStore: { get: async () => state.thread },
  workspaceStore: { get: async (id: string | null) => state.workspaces.find(item => item.id === id) },
  productStore: {
    forWorkspace: async (id: string | null) => (id ? state.products[id] : undefined),
    save: async (profile: ProductProfile) => {
      state.products[profile.workspaceId] = profile;
      return profile;
    },
  },
}));
// The card's own words come from the locale files: here each key answers with itself and what it was given
vi.stubGlobal('chrome', {
  i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join(':') },
});

const { productSection } = await import('../section');
const { profileChanges, updateProductProfileAction } = await import('../action');
const { workspaceSectionFor } = await import('../../workspaces/inject');

const acme = (): ProductProfile => ({
  ...emptyProductProfile({ id: 'acme', name: 'Acme' }),
  url: 'https://acme.test',
  audience: ['Freelancers who bill by the hour', 'Small agencies'],
  pricing: '$9 a month, first invoice free',
  budget: { totalUsd: 100, spentUsd: 0 },
  slackChannels: [{ name: '#acme-alerts', id: 'C0123456789' }],
});

function contextWith(answer: 'approved' | 'declined' | 'cancelled') {
  const asked: ConfirmRequest[] = [];
  const context = {
    taskId: 'thread-1',
    emitEvent: () => undefined,
    controller: new AbortController(),
    stop: vi.fn(async () => undefined),
    confirmGate: {
      ask: async (request: ConfirmRequest) => {
        asked.push(request);
        return answer;
      },
    },
  } as unknown as AgentContext;
  return { context, asked };
}

beforeEach(() => {
  state.thread = { workspaceId: 'acme' };
  state.workspaces = [{ id: 'acme', name: 'Acme', about: 'Invoices.', keywords: [], accounts: {}, createdAt: 0 }];
  state.products = { acme: acme() };
});

describe('productSection', () => {
  it('states the audience and the pricing from the profile', () => {
    const section = productSection(acme());
    expect(section).toContain('[Product: Acme]');
    expect(section).toContain('Who it is for (most valuable first): Freelancers who bill by the hour; Small agencies');
    expect(section).toContain('Pricing: $9 a month, first invoice free');
    // Nothing has been spent that anything recorded: no "spent" figure is stated
    expect(section).toContain('Marketing budget: $100 in total');
    expect(section).not.toContain('spent');
    expect(productSection({ ...acme(), budget: { totalUsd: 100, spentUsd: 12.5 } })).toContain(
      'Marketing budget: $100 in total, $12.50 spent',
    );
    // No stage was given, so none is stated
    expect(section).toContain('Stage: not set');
    expect(section).toContain('Slack channels with its notifications: #acme-alerts');
  });

  it('reads "not set" for every fact that is missing, and tells the agent not to fill the gap', () => {
    const section = productSection(acme());
    for (const label of [
      'Outreach email comes from',
      'Postal address for email footers',
      'Beta rule',
      'Social accounts',
      'North star',
      'The user hears about it on',
      'The problem it solves',
    ]) {
      expect(section).toContain(`${label}: not set`);
    }
    expect(section).toMatch(/say you do not know it/);
    expect(section).toMatch(/never fill a "not set" with a guess/);
  });

  it('is part of what every task in the workspace is told, and absent in a workspace with no product', async () => {
    const context = { taskId: 'thread-1' } as AgentContext;
    const withProduct = await workspaceSectionFor(context);
    expect(withProduct).toContain('[Workspace: Acme]');
    expect(withProduct).toContain('Pricing: $9 a month, first invoice free');
    state.products = {};
    expect(await workspaceSectionFor(context)).not.toContain('[Product:');
  });
});

describe('update_product_profile', () => {
  it('lists only the fields that change, with what each says now', () => {
    const { changes, next } = profileChanges(acme(), {
      intent: '',
      pricing: '$12 a month',
      url: 'https://acme.test',
      never: ['Never promise a refund'],
    });
    expect(changes).toEqual([
      { key: 'pricing', label: 'Pricing', before: '$9 a month, first invoice free', after: '$12 a month' },
      { key: 'never', label: 'Never say or do', before: 'not set', after: 'Never promise a refund' },
    ]);
    expect(next.pricing).toBe('$12 a month');
  });

  it('saves nothing until the user confirms, and shows them every change', async () => {
    const { context, asked } = contextWith('approved');
    const result = await updateProductProfileAction(context, { intent: 'New price', pricing: '$12 a month' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ mode: 'commit', target: 'product_title › Acme' });
    expect(asked[0]!.fields).toEqual([
      { label: 'product_pricing', value: '$12 a month\n(product_card_now:$9 a month, first invoice free)' },
    ]);
    expect(state.products.acme!.pricing).toBe('$12 a month');
    expect(result.extractedContent).toContain('Saved to the product profile of Acme: Pricing');
  });

  it('changes nothing and ends the task when the user declines', async () => {
    const { context } = contextWith('declined');
    const result = await updateProductProfileAction(context, { intent: '', pricing: 'Free forever' });
    expect(state.products.acme!.pricing).toBe('$9 a month, first invoice free');
    expect(result.error).toBeTruthy();
    expect(context.stop).toHaveBeenCalled();
  });

  it('applies the change to the profile as it is when the user confirms, not as it was when the card opened', async () => {
    const { context } = contextWith('approved');
    const ask = context.confirmGate.ask;
    context.confirmGate.ask = (async (...args: Parameters<typeof ask>) => {
      // While the card waits, the user fixes the audience in the workspace screen
      state.products.acme = { ...state.products.acme!, audience: ['Edited meanwhile'] };
      return ask(...args);
    }) as typeof ask;
    await updateProductProfileAction(context, { intent: '', pricing: '$12 a month' });
    expect(state.products.acme).toMatchObject({ pricing: '$12 a month', audience: ['Edited meanwhile'] });
  });

  it('saves nothing for a workspace that was deleted while the card waited', async () => {
    const { context } = contextWith('approved');
    const ask = context.confirmGate.ask;
    context.confirmGate.ask = (async (...args: Parameters<typeof ask>) => {
      state.workspaces = [];
      state.products = {};
      return ask(...args);
    }) as typeof ask;
    const result = await updateProductProfileAction(context, { intent: '', pricing: '$12 a month' });
    expect(result.error).toMatch(/no longer exists/);
    expect(state.products).toEqual({});
  });

  it('asks nothing when the profile already says so', async () => {
    const { context, asked } = contextWith('approved');
    const result = await updateProductProfileAction(context, { intent: '', pricing: '$9 a month, first invoice free' });
    expect(asked).toHaveLength(0);
    expect(result.extractedContent).toContain('Nothing was changed');
  });

  it('cannot change the limits or the sender: those are not fields of the tool', async () => {
    const { context } = contextWith('approved');
    await updateProductProfileAction(context, {
      intent: '',
      pricing: '$12 a month',
      ...({ budget: { totalUsd: 9999, spentUsd: 0 }, betaRule: { testersPerWeek: 99, days: 99, plan: 'x' } } as object),
    });
    expect(state.products.acme!.budget).toEqual({ totalUsd: 100, spentUsd: 0 });
    expect(state.products.acme!.betaRule).toBeNull();
  });

  it('starts a profile for a workspace that has none, and refuses a chat in no workspace', async () => {
    state.products = {};
    const first = contextWith('approved');
    await updateProductProfileAction(first.context, { intent: '', audience: ['Freelancers'] });
    expect(state.products.acme).toMatchObject({ workspaceId: 'acme', name: 'Acme', audience: ['Freelancers'] });

    state.thread = { workspaceId: null };
    const none = contextWith('approved');
    const result = await updateProductProfileAction(none.context, { intent: '', pricing: 'Free' });
    expect(result.error).toMatch(/no workspace/);
    expect(none.asked).toHaveLength(0);
  });
});
