import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../agent/types';
import type { ListedTab } from '../../browser/tabRegistry';
import type * as RegistryModule from '../../browser/tabRegistry';

const listed: ListedTab[] = [];
vi.mock('../../browser/tabRegistry', async original => ({
  ...(await original<typeof RegistryModule>()),
  tabRegistry: { list: async () => listed },
}));

const { findTabAction, tabLine } = await import('../action');

const HOUR = 3_600_000;
const tab = (over: Partial<ListedTab> & { id: number }): ListedTab => ({
  windowId: 1,
  url: 'https://example.com/',
  host: 'example.com',
  title: 'Example',
  openedAt: Date.now() - 3 * HOUR,
  lastActiveAt: Date.now() - HOUR,
  active: false,
  heldBy: null,
  ...over,
});

function contextWith(usable: number[]) {
  const events: string[] = [];
  const context = {
    taskId: 'me',
    emitEvent: (_actor: unknown, _state: unknown, details: string) => events.push(details),
    browserContext: { getTabInfos: async () => usable.map(id => ({ id, url: '', title: '' })) },
  } as unknown as AgentContext;
  return { context, events };
}

beforeEach(() => {
  listed.length = 0;
  listed.push(
    tab({ id: 1, host: 'facebook.com', url: 'https://www.facebook.com/messages', title: 'Messenger' }),
    tab({ id: 2, host: 'facebook.com', url: 'https://www.facebook.com/groups', title: 'Groups', heldBy: 'other' }),
    tab({ id: 3, host: 'bank.example', url: 'https://bank.example/', title: 'Bank' }),
  );
});

describe('find_tab', () => {
  it('finds an open tab by site and gives its id, age and last use', async () => {
    const { context } = contextWith([1, 3]);
    const result = await findTabAction(context, { intent: '', query: 'facebook' });
    expect(result.extractedContent).toContain(
      '{id: 1, site: facebook.com, title: "Messenger", open 3 h, last used 1 h ago}',
    );
    expect(result.includeInMemory).toBe(true);
  });

  it('shows a tab another task holds as busy, and never one this task may not use', async () => {
    // Tab 3 is not among the tabs this task may use (the firewall blocks it, say)
    const { context } = contextWith([1]);
    const all = await findTabAction(context, { intent: '', query: '*' });
    expect(all.extractedContent).toContain(
      '{id: 2, site: facebook.com, title: "Groups", open 3 h, BUSY with another task',
    );
    expect(all.extractedContent).not.toContain('bank.example');
  });

  it('wraps what it found as content from outside: a title is never an instruction', async () => {
    listed[0]!.title = 'Sale ends today';
    const { context } = contextWith([1]);
    const result = await findTabAction(context, { intent: '', query: 'facebook.com' });
    expect(result.extractedContent).toMatch(
      /<nano_untrusted_content>[\s\S]*Sale ends today[\s\S]*<\/nano_untrusted_content>/,
    );
  });

  it('says so when nothing matches', async () => {
    const { context, events } = contextWith([1, 3]);
    const result = await findTabAction(context, { intent: '', query: 'reddit' });
    expect(result.extractedContent).toContain('No open tab matches "reddit"');
    expect(events[0]).toBe('Looking for a "reddit" tab');
  });

  it('marks the tab in front', () => {
    expect(tabLine(tab({ id: 9, active: true }), Date.now(), 'me')).toContain('in front now');
  });
});
