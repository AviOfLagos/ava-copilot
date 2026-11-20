import { db as defaultDb } from '../threads/db';
import type { AviCopilotDb } from '../threads/db';
import { metricId, readingId, sourceStateId } from './types';
import type { GrowthLink, GrowthMetric, GrowthReading, GrowthSource, GrowthSourceState } from './types';

/** One metric's day, as a collector hands it over: a number that was read, or why there is none. */
export type DayReading =
  | {
      ok: true;
      productId: string;
      source: GrowthSource;
      metric: string;
      date: string;
      total: number;
      // The total split by where it came from; the parts need not add up to the total
      byChannel?: { channel: string; value: number }[];
      byCampaign?: { campaign: string; value: number }[];
      partial?: boolean;
      readAt: number;
    }
  | {
      ok: false;
      productId: string;
      source: GrowthSource;
      metric: string;
      date: string;
      reason: NonNullable<GrowthReading['reason']>;
      detail: string;
      readAt: number;
    };

/**
 * The growth numbers, over a database that defaults to the extension's own. Tests pass their own database.
 * The background is the only writer.
 */
export function createGrowthStore(db: AviCopilotDb = defaultDb) {
  const rowsOf = (productId: string, source: GrowthSource, metric: string, date: string) =>
    db.growthMetrics
      .where('[productId+metric+date]')
      .equals([productId, metric, date])
      .and(row => row.source === source);

  return {
    db,

    /**
     * Records one metric's day. A number that was read replaces what was there for that day. A failed read never
     * replaces a number that was read earlier: the earlier number stays, with the time it was read.
     */
    async record(reading: DayReading): Promise<void> {
      const key = { productId: reading.productId, source: reading.source, metric: reading.metric, date: reading.date };
      await db.transaction('rw', db.growthMetrics, db.growthReadings, async () => {
        if (!reading.ok) {
          const before = await db.growthReadings.get(readingId(key));
          if (before?.status === 'ok') return;
          await db.growthReadings.put({
            id: readingId(key),
            ...key,
            status: 'none',
            reason: reading.reason,
            detail: reading.detail,
            readAt: reading.readAt,
          });
          return;
        }
        await rowsOf(key.productId, key.source, key.metric, key.date).delete();
        const base = { ...key, readAt: reading.readAt };
        const rows: GrowthMetric[] = [{ ...base, id: metricId(base), value: reading.total }];
        for (const part of reading.byChannel ?? []) {
          const row = { ...base, channel: part.channel };
          rows.push({ ...row, id: metricId(row), value: part.value });
        }
        for (const part of reading.byCampaign ?? []) {
          const row = { ...base, campaign: part.campaign };
          rows.push({ ...row, id: metricId(row), value: part.value });
        }
        await db.growthMetrics.bulkPut(rows);
        await db.growthReadings.put({
          id: readingId(key),
          ...key,
          status: 'ok',
          reason: null,
          detail: null,
          ...(reading.partial ? { partial: true } : {}),
          readAt: reading.readAt,
        });
      });
    },

    /** Every row of a product's metric between two UTC days, both included. */
    async metrics(productId: string, metric: string, from: string, to: string): Promise<GrowthMetric[]> {
      return db.growthMetrics
        .where('[productId+metric+date]')
        .between([productId, metric, from], [productId, metric, to], true, true)
        .toArray();
    },

    async readings(productId: string, metric: string, from: string, to: string): Promise<GrowthReading[]> {
      return db.growthReadings
        .where('[productId+metric+date]')
        .between([productId, metric, from], [productId, metric, to], true, true)
        .toArray();
    },

    /** The metrics a product has any reading of, with the source each comes from. */
    async knownMetrics(productId: string): Promise<{ metric: string; source: GrowthSource }[]> {
      const seen = new Map<string, GrowthSource>();
      await db.growthReadings
        .where('productId')
        .equals(productId)
        .each(row => void seen.set(row.metric, row.source));
      return [...seen.entries()].map(([metric, source]) => ({ metric, source }));
    },

    sourceState(productId: string, source: GrowthSource): Promise<GrowthSourceState | undefined> {
      return db.growthSources.get(sourceStateId(productId, source));
    },

    async sourceStates(productId: string): Promise<GrowthSourceState[]> {
      return db.growthSources.where('productId').equals(productId).toArray();
    },

    async setSourceState(state: Omit<GrowthSourceState, 'id'>): Promise<void> {
      await db.growthSources.put({ ...state, id: sourceStateId(state.productId, state.source) });
    },

    /** Keeps a link made with make_link; the same tagged address is kept once. */
    async addLink(link: Omit<GrowthLink, 'id'>): Promise<GrowthLink> {
      const id = `${link.productId}|${link.url}`;
      const before = await db.growthLinks.get(id);
      if (before) return before;
      const row = { ...link, id };
      await db.growthLinks.put(row);
      return row;
    },

    async links(productId: string): Promise<GrowthLink[]> {
      return (await db.growthLinks.where('productId').equals(productId).toArray()).sort(
        (a, b) => b.createdAt - a.createdAt,
      );
    },

    /** Forgets everything about a product (its workspace was deleted). */
    async forget(productId: string): Promise<void> {
      await db.transaction('rw', db.growthMetrics, db.growthReadings, db.growthSources, db.growthLinks, async () => {
        await db.growthMetrics.where('productId').equals(productId).delete();
        await db.growthReadings.where('productId').equals(productId).delete();
        await db.growthSources.where('productId').equals(productId).delete();
        await db.growthLinks.where('productId').equals(productId).delete();
      });
    },
  };
}

export type GrowthStore = ReturnType<typeof createGrowthStore>;
export const growthStore = createGrowthStore();
