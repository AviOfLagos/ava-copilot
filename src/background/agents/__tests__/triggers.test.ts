import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@extension/storage';
import {
  agentsForInboxItem,
  agentsWatching,
  pageKey,
  TAB_COOLDOWN_MS,
  TAB_MIN_GAP_MS,
  TabCooldown,
  TabDebouncer,
} from '../triggers';
import type { TabEvent } from '../triggers';
import { agentRecord } from './fixtures';

/** Timers driven by hand: `advance` runs what is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; callback: () => void }>();
  return {
    set: (callback: () => void, ms: number) => {
      const handle = next++;
      due.set(handle, { at: now + ms, callback });
      return handle;
    },
    clear: (handle: unknown) => void due.delete(handle as number),
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          due.delete(handle);
          timer.callback();
        }
      }
    },
  };
}

describe('TabDebouncer', () => {
  it('passes a page on once, after it has been still for the delay', () => {
    const timers = fakeTimers();
    const settled: TabEvent[] = [];
    const debouncer = new TabDebouncer(event => settled.push(event), timers, 2500);
    debouncer.observe({ tabId: 1, url: 'https://x.com/', title: '' });
    timers.advance(1000);
    debouncer.observe({ tabId: 1, url: 'https://x.com/home', title: 'Home' });
    timers.advance(2000);
    expect(settled).toEqual([]);
    timers.advance(600);
    expect(settled).toEqual([{ tabId: 1, url: 'https://x.com/home', title: 'Home' }]);
    timers.advance(10_000);
    expect(settled).toHaveLength(1);
  });

  it('keeps tabs apart and drops a tab closed before it settled', () => {
    const timers = fakeTimers();
    const settled: number[] = [];
    const debouncer = new TabDebouncer(event => settled.push(event.tabId), timers, 2500);
    debouncer.observe({ tabId: 1, url: 'https://x.com/', title: '' });
    debouncer.observe({ tabId: 2, url: 'https://y.com/', title: '' });
    debouncer.forget(1);
    timers.advance(3000);
    expect(settled).toEqual([2]);
    expect(debouncer.size).toBe(0);
  });
});

describe('TabCooldown', () => {
  it('wakes an agent once per page in the cooldown, and at most once a minute overall', () => {
    const cooldown = new TabCooldown();
    expect(cooldown.take('a', 'https://x.com/home', 0)).toBe(true);
    expect(cooldown.take('a', 'https://x.com/home#top', 5_000)).toBe(false);
    expect(cooldown.take('a', 'https://x.com/other', 5_000)).toBe(false);
    expect(cooldown.take('a', 'https://x.com/other', TAB_MIN_GAP_MS + 1)).toBe(true);
    expect(cooldown.take('b', 'https://x.com/home', 5_000)).toBe(true);
    expect(cooldown.take('a', 'https://x.com/home', TAB_COOLDOWN_MS - 1)).toBe(false);
    expect(cooldown.take('a', 'https://x.com/home', TAB_COOLDOWN_MS + TAB_MIN_GAP_MS + 2)).toBe(true);
  });

  it('counts a page without its fragment', () => {
    expect(pageKey('https://x.com/home#feed')).toBe('https://x.com/home');
  });
});

describe('agentsWatching', () => {
  const watcher = agentRecord({ name: 'Watcher', triggers: [{ type: 'tab', urlPattern: 'x.com/*' }] });

  it('finds the created, switched-on agents whose pattern matches', () => {
    const paused = agentRecord({ enabled: false, triggers: watcher.triggers });
    const draft = agentRecord({ status: 'draft', triggers: watcher.triggers });
    const other = agentRecord({ triggers: [{ type: 'tab', urlPattern: 'linkedin.com/*' }] });
    const found = agentsWatching([watcher, paused, draft, other], 'https://x.com/home');
    expect(found.map(agent => agent.id)).toEqual([watcher.id]);
  });

  it('ignores a pattern too broad to use, even if one was stored', () => {
    const broad = agentRecord({ triggers: [{ type: 'tab', urlPattern: '*' }] });
    expect(agentsWatching([broad], 'https://bank.example/')).toEqual([]);
  });
});

describe('agentsForInboxItem', () => {
  const item = (overrides: Partial<InboxItem>): Pick<InboxItem, 'source' | 'kind' | 'workspaceId'> => ({
    source: 'slack',
    kind: 'message',
    workspaceId: null,
    ...overrides,
  });
  const anyItem = agentRecord({ triggers: [{ type: 'inbox' }] });
  const slackOnly = agentRecord({ triggers: [{ type: 'inbox', source: 'slack' }] });
  const inWorkspace = agentRecord({ workspaceId: 'w1', triggers: [{ type: 'inbox' }] });

  it('wakes the agents listening for the source', () => {
    expect(agentsForInboxItem([anyItem, slackOnly], item({ source: 'gmail' })).map(agent => agent.id)).toEqual([
      anyItem.id,
    ]);
    expect(agentsForInboxItem([anyItem, slackOnly], item({})).length).toBe(2);
  });

  it('never wakes for what agents and routines left, or for approvals and alerts', () => {
    for (const source of ['agent:x', 'workflow:y', 'system']) {
      expect(agentsForInboxItem([anyItem], item({ source }))).toEqual([]);
    }
    expect(agentsForInboxItem([anyItem], item({ kind: 'approval' }))).toEqual([]);
    expect(agentsForInboxItem([anyItem], item({ kind: 'alert' }))).toEqual([]);
  });

  it('keeps workspaces apart', () => {
    expect(agentsForInboxItem([inWorkspace], item({ workspaceId: 'w2' }))).toEqual([]);
    expect(agentsForInboxItem([inWorkspace], item({ workspaceId: 'w1' }))).toHaveLength(1);
  });
});
