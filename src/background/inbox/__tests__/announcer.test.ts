import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@extension/storage';
import { ANNOUNCE_MIN_GAP_MS } from '../constants';
import { lineForItem, lineForReminder, shouldAnnounce, withinQuietHours } from '../announcer';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'x|1',
  source: 'whatsapp-web',
  externalId: '1',
  kind: 'message',
  title: 'Jordan',
  body: 'a secret only the recipient should see',
  links: [],
  priority: 'normal',
  status: 'unread',
  snoozeUntil: null,
  workspaceId: null,
  agentId: null,
  runId: null,
  approval: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

describe('withinQuietHours', () => {
  it('is false when neither time is set', () => {
    expect(withinQuietHours(new Date(2026, 9, 12, 23, 0), { start: null, end: null })).toBe(false);
  });

  it('handles a plain same-day window', () => {
    const quiet = { start: '13:00', end: '14:00' };
    expect(withinQuietHours(new Date(2026, 9, 12, 13, 30), quiet)).toBe(true);
    expect(withinQuietHours(new Date(2026, 9, 12, 12, 59), quiet)).toBe(false);
    expect(withinQuietHours(new Date(2026, 9, 12, 14, 0), quiet)).toBe(false);
  });

  it('wraps past midnight', () => {
    const quiet = { start: '22:00', end: '07:00' };
    expect(withinQuietHours(new Date(2026, 9, 12, 23, 0), quiet)).toBe(true);
    expect(withinQuietHours(new Date(2026, 9, 12, 5, 0), quiet)).toBe(true);
    expect(withinQuietHours(new Date(2026, 9, 12, 12, 0), quiet)).toBe(false);
  });

  it('ignores a malformed time rather than guessing', () => {
    expect(withinQuietHours(new Date(2026, 9, 12, 10, 0), { start: 'nope', end: '07:00' })).toBe(false);
  });
});

describe('shouldAnnounce', () => {
  const base = { enabled: true, quiet: { start: null, end: null }, lastAnnouncedAt: 0, now: 100_000 };

  it('never announces when the setting is off', () => {
    expect(shouldAnnounce({ ...base, enabled: false })).toBe(false);
  });

  it('never announces during quiet hours', () => {
    const at10am = new Date(2026, 9, 12, 10, 0).getTime();
    expect(shouldAnnounce({ ...base, now: at10am, quiet: { start: '09:00', end: '11:00' } })).toBe(false);
  });

  it('waits out the minimum gap between announcements', () => {
    expect(shouldAnnounce({ ...base, lastAnnouncedAt: base.now - ANNOUNCE_MIN_GAP_MS + 1 })).toBe(false);
    expect(shouldAnnounce({ ...base, lastAnnouncedAt: base.now - ANNOUNCE_MIN_GAP_MS })).toBe(true);
  });
});

describe('lineForItem', () => {
  it('names the title for an approval, never the body', () => {
    const line = lineForItem(item({ kind: 'approval', title: 'Send the weekly report?', priority: 'high' }));
    expect(line).toContain('Send the weekly report?');
    expect(line).not.toContain('secret');
  });

  it('says a new message is from the title (a sender name), never the body', () => {
    const line = lineForItem(item({ priority: 'high' }));
    expect(line).toContain('Jordan');
    expect(line).not.toContain('secret');
  });

  it('names the count and source for a digest', () => {
    const line = lineForItem(item({ title: '6 new messages', digestCount: 6, priority: 'high' }));
    expect(line).toContain('6 new messages');
    expect(line).toContain('WhatsApp');
  });
});

const calendarEvent = (title: string) => ({
  id: '1',
  title,
  start: 0,
  end: 0,
  allDay: false,
  location: '',
  joinUrl: null,
});

describe('lineForReminder', () => {
  it('never carries the meeting title', () => {
    expect(lineForReminder({ event: calendarEvent('Secret deal talks'), minutes: 5 })).not.toContain(
      'Secret deal talks',
    );
  });

  it('says "now" at zero or below, otherwise the minutes', () => {
    expect(lineForReminder({ event: calendarEvent(''), minutes: 0 })).toContain('now');
    expect(lineForReminder({ event: calendarEvent(''), minutes: 5 })).toContain('5 minutes');
  });
});
