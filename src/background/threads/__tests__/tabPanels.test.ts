import { describe, expect, it, vi } from 'vitest';
import { panelPathFor, TabPanels } from '../tabPanels';
import type { TabPanelMap } from '../tabPanels';

vi.mock('../../log', () => ({ createLogger: () => ({ info() {}, warning() {}, error() {} }) }));

function panels(initial: TabPanelMap = {}) {
  let stored: TabPanelMap = { ...initial };
  const enabled: number[] = [];
  const panel = new TabPanels({
    read: async () => stored,
    write: async map => {
      stored = map;
    },
    enable: async tabId => void enabled.push(tabId),
    disable: async () => {},
  });
  return { panel, stored: () => stored, enabled };
}

describe('TabPanels: which chat each tab shows', () => {
  it('gives each tab its own panel page', () => {
    expect(panelPathFor(12)).toBe('sidepanel.html?tab=12');
  });

  it('binds a chat to the tab it was opened on, and stores it for the session', async () => {
    const { panel, stored } = panels();
    await panel.open(4, 'a');
    expect(panel.entryOf(4)).toEqual({ threadId: 'a', role: 'home' });
    expect(panel.homeOf('a')).toBe(4);
    expect(stored()).toEqual({ '4': { threadId: 'a', role: 'home' } });
  });

  it('restores what was stored before the background restarted', async () => {
    const { panel } = panels({ '7': { threadId: 'b', role: 'home' } });
    await panel.load();
    expect(panel.entryOf(7)?.threadId).toBe('b');
  });

  it('moves a chat opened on another tab there: one home tab per chat', async () => {
    const { panel } = panels();
    await panel.open(1, 'a');
    expect(await panel.open(2, 'a')).toBe(1);
    expect(panel.entryOf(1)).toBeNull();
    expect(panel.homeOf('a')).toBe(2);
  });

  it('replaces the chat a tab showed when another is opened on it', async () => {
    const { panel } = panels();
    await panel.open(1, 'a');
    await panel.open(1, 'b');
    expect(panel.entryOf(1)?.threadId).toBe('b');
    expect(panel.homeOf('a')).toBeNull();
  });

  it('lets no chat use a tab that is another chat’s home or work tab', async () => {
    const { panel } = panels();
    await panel.open(1, 'a');
    await panel.addWork(2, 'a');
    expect(panel.mayUse('a', 1)).toBe(true);
    expect(panel.mayUse('a', 2)).toBe(true);
    expect(panel.mayUse('b', 1)).toBe(false);
    expect(panel.mayUse('b', 2)).toBe(false);
    expect(panel.mayUse('b', 3)).toBe(true);
  });

  it('shows a chat on the tabs its run opened, turns the panel on there, and never takes a tab another chat has', async () => {
    const { panel, enabled } = panels();
    await panel.open(1, 'a');
    await panel.open(5, 'b');
    expect(await panel.addWork(2, 'a')).toBe(true);
    expect(await panel.addWork(5, 'a')).toBe(false);
    expect(panel.entryOf(2)).toEqual({ threadId: 'a', role: 'work' });
    expect(panel.entryOf(5)?.threadId).toBe('b');
    expect(enabled).toEqual([2]);
    // A work tab is not the chat's home: opening the chat elsewhere keeps it
    await panel.open(3, 'a');
    expect(panel.entryOf(2)?.threadId).toBe('a');
  });

  it('forgets a closed tab and every tab of a deleted chat', async () => {
    const { panel } = panels();
    await panel.open(1, 'a');
    await panel.addWork(2, 'a');
    await panel.open(3, 'b');
    await panel.forgetTab(3);
    expect(panel.entryOf(3)).toBeNull();
    await panel.forgetThread('a');
    expect(panel.entryOf(1)).toBeNull();
    expect(panel.entryOf(2)).toBeNull();
  });

  it('applies changes one at a time, so two at once both land', async () => {
    const { panel, stored } = panels();
    await Promise.all([panel.open(1, 'a'), panel.open(2, 'b'), panel.addWork(3, 'a')]);
    expect(Object.keys(stored()).sort()).toEqual(['1', '2', '3']);
  });
});
