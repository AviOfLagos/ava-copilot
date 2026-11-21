import { growthStore, shiftDay, utcDay } from '@extension/storage';
import type { GrowthStore } from '@extension/storage';
import { whatChanged } from '../../rounds/plan';

/**
 * Signals (docs/growth-team.md, Part 8): when a channel's sign-ups move, the Growth Lead puts `growth.signal` on
 * the bus so the other two act on it the same day. Plain code: yesterday against the 7 days before, by the same
 * test the rounds use (at least 5 and at least half the average). A day with no reading is left out, never 0.
 */

export interface ChannelSignal {
  workspaceId: string;
  day: string;
  channel: string;
  today: number;
  average: number;
  direction: 'up' | 'down';
}

/** The channels whose sign-ups moved yesterday (UTC), biggest move first. */
export async function channelSignals(
  workspaceId: string,
  now: number,
  store: Pick<GrowthStore, 'metrics' | 'readings'> = growthStore,
): Promise<ChannelSignal[]> {
  const day = shiftDay(utcDay(now), -1);
  const from = shiftDay(day, -7);
  const rows = await store.metrics(workspaceId, 'signups', from, day);
  // Only days that were read: a day with no reading is unknown, not zero
  const readDays = new Set(
    (await store.readings(workspaceId, 'signups', from, day))
      .filter(reading => reading.status === 'ok')
      .map(reading => reading.date),
  );
  const byChannel = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.channel || row.campaign || row.postId) continue;
    const days = byChannel.get(row.channel) ?? new Map<string, number>();
    days.set(row.date, (days.get(row.date) ?? 0) + row.value);
    byChannel.set(row.channel, days);
  }
  const signals: ChannelSignal[] = [];
  for (const [channel, days] of byChannel) {
    if (!readDays.has(day)) continue;
    const before = Array.from({ length: 7 }, (_, index) => shiftDay(day, -(index + 1))).map(date =>
      readDays.has(date) ? (days.get(date) ?? 0) : null,
    );
    const result = whatChanged(days.get(day) ?? 0, before);
    if (!result.flagged || result.direction === null || result.average === null) continue;
    signals.push({
      workspaceId,
      day,
      channel,
      today: days.get(day) ?? 0,
      average: Math.round(result.average * 10) / 10,
      direction: result.direction,
    });
  }
  return signals.sort((a, b) => Math.abs(b.today - b.average) - Math.abs(a.today - a.average));
}
