import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageModule from '@extension/storage';
import type { ProductProfile } from '@extension/storage';
import type { AgentContext } from '../../agent/types';

vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({}), set: async () => undefined, onChanged: { addListener: () => undefined } },
    },
    i18n: { getMessage: (key: string) => key },
  });
});

const state = {
  thread: { workspaceId: 'acme' as string | null },
  products: {} as Record<string, ProductProfile>,
};
vi.mock('@extension/storage', async original => {
  const real = await original<typeof StorageModule>();
  return {
    ...real,
    threadStore: { get: async () => state.thread },
    workspaceStore: {
      get: async (id: string | null) =>
        id
          ? { id, name: id === 'acme' ? 'Acme' : 'Other', about: '', keywords: [], accounts: {}, createdAt: 0 }
          : undefined,
    },
    productStore: { forWorkspace: async (id: string | null) => (id ? state.products[id] : undefined) },
  };
});

const { db, emptyProductProfile, growthStore, utcDay } = await import('@extension/storage');
const { makeLinkAction, metricsQueryAction, metricsQueryActionSchema } = await import('../actions');

const context = { taskId: 'thread-1', emitEvent: () => undefined } as unknown as AgentContext;
const query = (input: Record<string, unknown>) =>
  metricsQueryAction(context, metricsQueryActionSchema.schema.parse({ metric: 'signups', ...input }));
const today = utcDay(Date.now());

beforeEach(async () => {
  state.thread = { workspaceId: 'acme' };
  state.products = {
    acme: { ...emptyProductProfile({ id: 'acme', name: 'Acme' }), url: 'https://acme.test' },
    other: { ...emptyProductProfile({ id: 'other', name: 'Other' }), url: 'https://other.test' },
  };
  await Promise.all([
    db.growthMetrics.clear(),
    db.growthReadings.clear(),
    db.growthSources.clear(),
    db.growthLinks.clear(),
  ]);
  const base = { source: 'product' as const, metric: 'signups', date: today, readAt: Date.now() };
  await growthStore.record({ ...base, ok: true, productId: 'acme', total: 4, byChannel: [{ channel: 'x', value: 4 }] });
  await growthStore.record({ ...base, ok: true, productId: 'other', total: 99 });
});

describe('metrics_query', () => {
  it("reads the numbers of the chat's own workspace product, with when they were read", async () => {
    const result = await query({ by: 'channel' });
    expect(result.extractedContent).toContain(`Acme · signups · ${today} (UTC days)`);
    expect(result.extractedContent).toContain('Total: 4 over 1 of 1 day');
    expect(result.extractedContent).toContain('By channel: x 4');
    expect(result.extractedContent).toMatch(/Read: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    // Channel names come from visitors: they reach the model as outside content
    expect(result.extractedContent).toContain('nano_untrusted_content');
  });

  it("never reads another workspace's product, whatever the model asks for", async () => {
    const result = await query({ product: 'other' });
    expect(result.error).toMatch(/only read the numbers of Acme/);
    expect(result.extractedContent ?? '').not.toContain('99');
    // Its own product by name or id is fine
    expect((await query({ product: 'Acme' })).extractedContent).toContain('Total: 4');
  });

  it('says there is no number, never zero, for a metric nobody read', async () => {
    const result = await query({ metric: 'revenue' });
    expect(result.extractedContent).toContain('Do not say 0');
    expect(result.extractedContent).toContain('No collector has ever read "revenue" for Acme');
    expect(result.extractedContent).not.toMatch(/Total/);
  });

  it('lists what exists, refuses a bad range, and a chat with no product', async () => {
    expect((await query({ metric: 'list' })).extractedContent).toContain('Numbers collected for Acme: signups');
    expect((await query({ from: '2026-11-19', to: '2026-11-01' })).error).toMatch(/after/);
    state.thread = { workspaceId: null };
    expect((await query({})).error).toMatch(/no workspace/);
    state.thread = { workspaceId: 'acme' };
    state.products = {};
    expect((await query({})).error).toMatch(/no product profile/);
  });
});

describe('make_link', () => {
  const link = { intent: '', url: 'https://acme.test/pricing', source: 'X', medium: 'social', campaign: 'Launch' };

  it('gives the tagged link and keeps a record of it, once', async () => {
    const result = await makeLinkAction(context, link);
    expect(result.extractedContent).toContain(
      'https://acme.test/pricing?utm_source=x&utm_medium=social&utm_campaign=launch',
    );
    await makeLinkAction(context, link);
    expect(await growthStore.links('acme')).toMatchObject([{ source: 'x', campaign: 'launch', threadId: 'thread-1' }]);
  });

  it("refuses a link to a site that is not the product's", async () => {
    const result = await makeLinkAction(context, { ...link, url: 'https://other.test/' });
    expect(result.error).toMatch(/own site \(acme\.test\)/);
    expect(await growthStore.links('acme')).toEqual([]);
  });
});
