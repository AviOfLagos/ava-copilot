import { describe, expect, it, vi } from 'vitest';

const listeners: ((tabId: number, change: { audible?: boolean }) => void)[] = [];
const query = vi.fn();
vi.stubGlobal('chrome', { tabs: { onUpdated: { addListener: (fn: never) => listeners.push(fn) }, query } });

const { soundRecently, watchSound } = await import('../sound');

describe('soundRecently', () => {
  it('counts sound playing now, sound that just stopped, and a failed check', async () => {
    watchSound();
    query.mockResolvedValueOnce([{ id: 1 }]);
    expect(await soundRecently()).toBe(true);

    query.mockResolvedValueOnce([]);
    expect(await soundRecently()).toBe(false);

    listeners[0](1, { audible: false });
    query.mockResolvedValue([]);
    expect(await soundRecently()).toBe(true);
    expect(await soundRecently(Date.now() + 20_000)).toBe(false);

    query.mockRejectedValueOnce(new Error('no tabs'));
    expect(await soundRecently(Date.now() + 20_000)).toBe(true);
  });
});
