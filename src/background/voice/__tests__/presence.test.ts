import { describe, expect, it } from 'vitest';
import { OWN_SWITCH_MS, ago, onTabMove, recentChatsSection } from '../presence';

const place = { threadId: 'chat-a', tabId: 10, windowId: 1 };
const move = (over: Partial<Parameters<typeof onTabMove>[0]> = {}) =>
  onTabMove({
    place,
    paused: false,
    tabId: 20,
    windowId: 1,
    chatOfTab: null,
    voiceTab: false,
    ownSwitchAt: 0,
    now: 100_000,
    ...over,
  });

describe('when voice pauses and resumes', () => {
  it('pauses when the user goes to a tab that is not the chat’s', () => {
    expect(move()).toBe('pause');
  });

  it('stays on for the chat’s own tabs and tabs voice opened', () => {
    expect(move({ tabId: 10 })).toBe('stay');
    expect(move({ chatOfTab: 'chat-a' })).toBe('stay');
    expect(move({ voiceTab: true })).toBe('stay');
    expect(move({ ownSwitchAt: 100_000 - OWN_SWITCH_MS + 1 })).toBe('stay');
  });

  it('ignores other windows and conversations with no tab', () => {
    expect(move({ windowId: 2 })).toBe('stay');
    expect(move({ place: { threadId: 'chat-a' } })).toBe('stay');
    expect(move({ extensionPage: true })).toBe('stay');
    expect(move({ agentTab: true })).toBe('stay');
  });

  it('resumes only on coming back to the chat', () => {
    expect(move({ paused: true, tabId: 10 })).toBe('resume');
    expect(move({ paused: true, chatOfTab: 'chat-a' })).toBe('resume');
    expect(move({ paused: true })).toBe('stay');
    expect(move({ paused: true, chatOfTab: 'chat-b' })).toBe('stay');
  });
});

describe('the recent chats a new conversation knows', () => {
  const now = Date.UTC(2026, 10, 23, 12);

  it('lists the newest first, with when and the last line, marked as history', () => {
    const text = recentChatsSection(
      [
        { title: 'Invoice', updatedAt: now - 3 * 3600_000, lastLine: 'Sent to Ada' },
        { title: 'Flights', updatedAt: now - 5 * 60_000, lastLine: 'Lagos  to\nLondon on Friday' },
      ],
      now,
    );
    expect(text).toContain('search_chats');
    expect(text.indexOf('"Flights" (5 minutes ago): Lagos to London on Friday')).toBeGreaterThan(-1);
    expect(text.indexOf('Flights')).toBeLessThan(text.indexOf('Invoice'));
    expect(text).toContain('"Invoice" (3 hours ago): Sent to Ada');
  });

  it('keeps to five chats and a short length, and is empty with none', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `Chat ${i}`,
      updatedAt: now - i,
      lastLine: 'x'.repeat(500),
    }));
    const text = recentChatsSection(many, now);
    expect((text.match(/- "Chat/g) ?? []).length).toBeLessThanOrEqual(5);
    expect(text.length).toBeLessThan(2000);
    expect(recentChatsSection([], now)).toBe('');
  });

  it('says when in plain words', () => {
    expect(ago(now, now)).toBe('just now');
    expect(ago(now - 3600_000, now)).toBe('an hour ago');
    expect(ago(now - 26 * 3600_000, now)).toBe('yesterday');
  });
});
