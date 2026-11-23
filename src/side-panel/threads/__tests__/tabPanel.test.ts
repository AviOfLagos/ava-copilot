import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/background/log', () => ({ createLogger: () => ({ info() {}, warning() {}, error() {} }) }));
const { pageOf, panelTabId, tabChange } = await import('../tabPanel');

describe('a tab’s own panel', () => {
  it('knows its tab from its address, and a pop-out has none', () => {
    expect(panelTabId('?tab=42')).toBe(42);
    expect(panelTabId('?thread=abc')).toBeNull();
    expect(panelTabId('?tab=x')).toBeNull();
    expect(panelTabId('')).toBeNull();
  });

  it('shows the chat of its tab when it opens or the chat is opened there from elsewhere', () => {
    expect(tabChange(3, null, {}, { '3': { threadId: 'a', role: 'home' } })).toEqual({ kind: 'show', threadId: 'a' });
    // Already showing it: nothing to do
    expect(tabChange(3, 'a', {}, { '3': { threadId: 'a', role: 'home' } })).toBeNull();
    // Another tab's change
    expect(tabChange(3, 'a', {}, { '9': { threadId: 'b', role: 'home' } })).toBeNull();
  });

  it('goes back to the start screen, and says so, when its chat moved to another tab', () => {
    const before = { '3': { threadId: 'a', role: 'home' as const } };
    expect(tabChange(3, 'a', before, { '8': { threadId: 'a', role: 'home' } })).toEqual({ kind: 'moved' });
    expect(tabChange(3, 'a', before, {})).toEqual({ kind: 'cleared' });
    // The panel had already moved on to another chat
    expect(tabChange(3, 'b', before, {})).toBeNull();
  });

  it('names the page each past chat belongs to', () => {
    expect(pageOf({ boundUrl: 'https://www.facebook.com/messages/t/123' })).toBe('facebook.com/messages/t/123');
    expect(pageOf({ boundUrl: 'https://news.example/' })).toBe('news.example');
    expect(pageOf({ boundUrl: 'https://docs.example/a/very/long/path/to/some/page' })).toBe(
      'docs.example/a/very/long/path/to/so…',
    );
    expect(pageOf({ boundUrl: null })).toBe('');
    expect(pageOf({ boundUrl: 'chrome://newtab/' })).toBe('');
  });
});
