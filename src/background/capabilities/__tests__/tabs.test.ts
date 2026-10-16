import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeTab, focusLine, targetTab, TabTracker } from '../tabs';

type FakeTab = { id: number; windowId: number; title: string; url: string; incognito?: boolean; active?: boolean };

function fakeChrome(tabs: FakeTab[], focusedWindow = 1) {
  const api = {
    focusedWindow,
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = tabs.find(item => item.id === id);
        if (!tab) throw new Error('No tab');
        return tab;
      }),
      query: vi.fn(async ({ windowId }: { windowId: number }) =>
        tabs.filter(tab => tab.windowId === windowId && tab.active),
      ),
    },
    windows: { getLastFocused: vi.fn(async () => ({ id: api.focusedWindow })) },
  };
  return api;
}

describe('TabTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('knows the tab in front and the one before, the moment the user switches', async () => {
    const tabs: FakeTab[] = [
      { id: 1, windowId: 1, title: 'Inbox', url: 'https://mail.google.com/', active: true },
      { id: 2, windowId: 1, title: 'Pull request', url: 'https://github.com/acme/pr/1' },
    ];
    const api = fakeChrome(tabs);
    const tracker = new TabTracker(api as never);
    const changes: { line: string; switched: boolean }[] = [];
    tracker.onChange((focus, switched) => changes.push({ line: focusLine(focus), switched }));
    await tracker.start();
    expect(tracker.state.current?.tabId).toBe(1);

    await tracker.activated(2, 1);
    expect(tracker.state.current?.tabId).toBe(2);
    expect(tracker.state.previous?.tabId).toBe(1);
    // One settled update for the listener, not one per event
    await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveLength(1);
    expect(changes[0].switched).toBe(true);
    expect(changes[0].line).toContain('"Pull request" (github.com) [tab 2]');
    expect(changes[0].line).toContain('(previous: "Inbox" (mail.google.com) [tab 1])');

    // The page in front changes its title: news, but not a switch
    tracker.updated({
      id: 2,
      windowId: 1,
      title: 'PR #1 merged',
      url: 'https://github.com/acme/pr/1',
      incognito: false,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(changes[1]).toMatchObject({ switched: false });
    expect(tracker.state.previous?.tabId).toBe(1);

    // A tab switched in a window behind is not what the user looks at
    tabs.push({ id: 3, windowId: 2, title: 'Other window', url: 'https://example.com/' });
    await tracker.activated(3, 2);
    expect(tracker.state.current?.tabId).toBe(2);

    tracker.removed(1);
    expect(tracker.state.previous).toBeNull();
  });

  it('never keeps a private tab’s title or address', async () => {
    const api = fakeChrome([
      { id: 5, windowId: 1, title: 'Secret', url: 'https://bank.example/', incognito: true, active: true },
    ]);
    const tracker = new TabTracker(api as never);
    await tracker.start();
    expect(tracker.state.current).toMatchObject({ title: '', url: '', incognito: true });
    expect(describeTab(tracker.state.current)).toBe('a private tab');
  });
});

describe('targetTab', () => {
  const web = { tabId: 1, windowId: 1, title: 'Docs', url: 'https://docs.example/', incognito: false };
  const browserPage = { tabId: 2, windowId: 1, title: 'Extensions', url: 'chrome://extensions', incognito: false };
  const worked = { tabId: 3, windowId: 1, title: 'Sheet', url: 'https://sheets.example/', incognito: false };
  it('is the tab in front, else the last one worked on, else the one before', () => {
    expect(targetTab({ current: web, previous: null, lastWorked: worked })?.tabId).toBe(1);
    expect(targetTab({ current: browserPage, previous: web, lastWorked: worked })?.tabId).toBe(3);
    expect(targetTab({ current: browserPage, previous: web, lastWorked: null })?.tabId).toBe(1);
    expect(targetTab({ current: null, previous: null, lastWorked: null })).toBeNull();
  });
});
