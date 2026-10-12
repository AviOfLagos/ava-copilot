import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import { addInboxItem } from '../store';
import { badgeText, refreshBadge } from '../badge';

let db: AviCopilotDb;

beforeEach(() => {
  db = new AviCopilotDb(`badge-${crypto.randomUUID()}`);
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe('badgeText', () => {
  it('is empty for zero or fewer', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
  });
  it('is the number, capped at "99+"', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
  });
});

describe('refreshBadge', () => {
  it('sets the unread count on the global badge', async () => {
    await addInboxItem({ source: 'slack-web', externalId: 'c1', kind: 'message', title: 'A', body: '' }, db);
    await addInboxItem({ source: 'slack-web', externalId: 'c2', kind: 'message', title: 'B', body: '' }, db);
    await refreshBadge(db);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '2' });
  });

  it("never touches the badge while a meeting records: that is meetings' own per-tab badge", async () => {
    await addInboxItem({ source: 'slack-web', externalId: 'c1', kind: 'message', title: 'A', body: '' }, db);
    await db.meetings.put({
      id: 'm1',
      threadId: null,
      tabId: 1,
      title: '',
      platform: 'meet',
      url: '',
      startedAt: Date.now(),
      endedAt: null,
      status: 'recording',
      source: 'captions',
      withMic: false,
      rollingSummary: '',
      summaryAt: 0,
      summaryUpTo: 0,
      blockSummaries: [],
      note: null,
      markdown: '',
      warnings: [],
      liveCaptions: [],
      live: 'off',
      chunksTotal: 0,
      chunksDone: 0,
      error: null,
    });
    await refreshBadge(db);
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });
});
