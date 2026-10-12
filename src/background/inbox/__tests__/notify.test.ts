import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@extension/storage';
import { NOTIFY_MIN_GAP_MS } from '../constants';
import { notifyHighPriority, shouldNotify } from '../notify';

const item = (priority: InboxItem['priority'] = 'high'): InboxItem => ({
  id: 'x|1',
  source: 'x',
  externalId: '1',
  kind: 'message',
  title: 'Someone',
  body: 'secret body text',
  links: [],
  priority,
  status: 'unread',
  snoozeUntil: null,
  workspaceId: null,
  agentId: null,
  runId: null,
  approval: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('shouldNotify', () => {
  it('waits out the minimum gap', () => {
    expect(shouldNotify(0, NOTIFY_MIN_GAP_MS - 1, NOTIFY_MIN_GAP_MS)).toBe(false);
    expect(shouldNotify(0, NOTIFY_MIN_GAP_MS, NOTIFY_MIN_GAP_MS)).toBe(true);
  });
});

// A realistic epoch time: `lastNotifiedAt` defaults to 0, and the gap check must not mistake "no
// notification yet" for "one just went out" when `now` itself is smaller than the minimum gap.
const BASE_NOW = NOTIFY_MIN_GAP_MS * 100;

describe('notifyHighPriority', () => {
  let session: Record<string, unknown>;

  beforeEach(() => {
    session = {};
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(async (key: string) => ({ [key]: session[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(session, values)),
        },
      },
      notifications: { create: vi.fn().mockResolvedValue(undefined) },
      runtime: { getURL: (path: string) => `chrome-extension://x/${path}` },
    });
  });

  it('never notifies for normal or low priority', async () => {
    await notifyHighPriority(item('normal'));
    await notifyHighPriority(item('low'));
    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it('notifies for high priority, with the title only, never the body', async () => {
    await notifyHighPriority(item('high'), BASE_NOW);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    const [, options] = (chrome.notifications.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.message).toBe('Someone');
    expect(options.message).not.toContain('secret body text');
  });

  it('throttles a second high-priority item that arrives too soon', async () => {
    await notifyHighPriority(item('high'), BASE_NOW);
    await notifyHighPriority({ ...item('high'), id: 'x|2' }, BASE_NOW + 1000);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
  });

  it('notifies again once the minimum gap has passed', async () => {
    await notifyHighPriority(item('high'), BASE_NOW);
    await notifyHighPriority({ ...item('high'), id: 'x|2' }, BASE_NOW + NOTIFY_MIN_GAP_MS);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(2);
  });
});
