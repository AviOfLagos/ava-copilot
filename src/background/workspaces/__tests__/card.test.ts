import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageModule from '@extension/storage';
import type { AgentContext } from '../../agent/types';

// The workspace card (issue #143): about 800 characters, not the raw "about" of up to 4,000 on every step
const state = {
  about: 'x '.repeat(2000).trim(),
  accounts: { google: 'sample@example.com' } as Record<string, string>,
  items: [{ id: 'a', updatedAt: 1, workspaceId: 'acme' }] as unknown[],
  summary: null as { text: string; fingerprint: string } | null,
};
vi.mock('@extension/storage', async original => ({
  ...(await original<typeof StorageModule>()),
  threadStore: { get: async () => ({ workspaceId: 'acme' }) },
  workspaceStore: {
    get: async () => ({ id: 'acme', name: 'Acme', about: state.about, keywords: [], accounts: state.accounts }),
  },
  productStore: { forWorkspace: async () => undefined },
  kbStore: { items: async () => state.items },
  historyStore: { summaries: async () => (state.summary ? { acme: state.summary } : {}) },
}));
vi.mock('../../history/rollup', () => ({
  itemsOf: (items: unknown[]) => items,
  fingerprintOf: (items: { id: string; updatedAt: number }[]) =>
    items.map(item => `${item.id}:${item.updatedAt}`).join('|'),
}));

const { workspaceSectionFor } = await import('../inject');
const context = { taskId: 't' } as AgentContext;

beforeEach(() => {
  state.about = 'x '.repeat(2000).trim();
  state.accounts = { google: 'sample@example.com' };
  state.items = [{ id: 'a', updatedAt: 1, workspaceId: 'acme' }];
  state.summary = null;
});

describe('the workspace card', () => {
  it('keeps a 4,000-character about and a long summary to a card of about 1,000 characters at most (was over 4,800), with the summary when it is current', async () => {
    state.summary = { text: 'Launch is Friday. '.repeat(100), fingerprint: 'a:1' };
    const card = await workspaceSectionFor(context);
    expect(card).toContain('[Workspace: Acme]');
    expect(card).toContain('Where it is at');
    // Worst case: the longest about, a long summary and an account
    expect(card.length).toBeLessThan(1100);
    expect(card).toContain('workspace_context');
    expect(card).toContain('sample@example.com');
  });

  it('is under 800 characters for a typical workspace, and keeps a short about whole', async () => {
    state.about = 'Invoicing for small shops.';
    const card = await workspaceSectionFor(context);
    expect(card).toContain('Invoicing for small shops.');
    expect(card.length).toBeLessThan(800);
  });

  it('follows the summary: a new one shows at once, and one that no longer matches what may be read does not', async () => {
    state.summary = { text: 'Old status.', fingerprint: 'a:1' };
    expect(await workspaceSectionFor(context)).toContain('Old status.');
    state.summary = { text: 'New status.', fingerprint: 'a:1' };
    expect(await workspaceSectionFor(context)).toContain('New status.');
    // An item changed (or was made private) since the summary was written
    state.items = [{ id: 'a', updatedAt: 2, workspaceId: 'acme' }];
    expect(await workspaceSectionFor(context)).not.toContain('New status.');
    // Nothing readable left
    state.items = [];
    expect(await workspaceSectionFor(context)).not.toContain('Where it is at');
  });

  it('says a long about was cut, and never lets it grow the card', async () => {
    const card = await workspaceSectionFor(context);
    expect(card).toContain('…');
    expect(card.length).toBeLessThan(900);
  });
});
