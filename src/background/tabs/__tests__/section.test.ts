import { describe, expect, it } from 'vitest';
import type { ListedTab } from '../../browser/tabRegistry';
import { tabsView } from '../section';

const HOUR = 3_600_000;
const now = 10 * HOUR;
const tab = (over: Partial<ListedTab> & { id: number }): ListedTab => ({
  windowId: 1,
  url: `https://site${over.id}.example/`,
  host: `site${over.id}.example`,
  title: `Site ${over.id}`,
  openedAt: now - HOUR,
  lastActiveAt: now - HOUR,
  active: false,
  heldBy: null,
  ...over,
});
const info = (id: number) => ({ id, url: `https://site${id}.example/`, title: `Site ${id}` });

describe('tabsView', () => {
  it("lists the task's own window one by one and sums up the other windows by site", () => {
    const listed = [
      tab({ id: 1, heldBy: 'me', active: true }),
      tab({ id: 2 }),
      tab({ id: 3, windowId: 2, host: 'facebook.com', openedAt: now - 3 * HOUR, lastActiveAt: now - HOUR / 3 }),
      tab({ id: 4, windowId: 2, host: 'app.slack.com', heldBy: 'other' }),
    ];
    const view = tabsView(listed, { tabId: 1, tabs: [info(1), info(2), info(3)] }, 'me', now);
    expect([...(view.near ?? [])].sort()).toEqual([1, 2]);
    expect(view.section).toContain('facebook.com: 1 tab, open 3 h, last used 20 min ago');
    expect(view.section).toContain('app.slack.com: 1 tab, open 1 h, last used 1 h ago (busy with another task)');
    expect(view.section).not.toContain('site2.example');
  });

  it('says nothing more for a task that stays in its own window (an agent)', () => {
    const listed = [tab({ id: 1, heldBy: 'me' }), tab({ id: 2 }), tab({ id: 3, windowId: 2, heldBy: 'other' })];
    const view = tabsView(listed, { tabId: 1, tabs: [info(1), info(2)] }, 'me', now, false);
    expect(view.section).toBe('');
    expect([...(view.near ?? [])].sort()).toEqual([1, 2]);
  });

  it('shows a busy tab in another window even when nothing there is free', () => {
    const listed = [tab({ id: 1, heldBy: 'me' }), tab({ id: 3, windowId: 2, host: 'facebook.com', heldBy: 'other' })];
    const view = tabsView(listed, { tabId: 1, tabs: [info(1)] }, 'me', now);
    expect(view.section).toContain('facebook.com: 1 tab, open 1 h, last used 1 h ago (busy with another task)');
  });

  it('keeps a tab the registry does not list in the one-by-one list', () => {
    const view = tabsView([tab({ id: 1, heldBy: 'me' })], { tabId: 1, tabs: [info(1), info(9)] }, 'me', now);
    expect(view.near?.has(9)).toBe(true);
  });
});
