import MiniSearch from 'minisearch';
import type { KnowledgeChunk, KnowledgeItem } from '@extension/storage';

// Reciprocal rank fusion constant: the usual value, which keeps one list from dominating
const RRF_K = 60;
// Candidates taken from each of the vector and keyword lists before fusing
const CANDIDATES = 50;
// Hits from one chat, meeting or page, so one long source does not crowd out the rest
const PER_ITEM = 3;
// How much a hit from the time the question names counts over others
const TIME_BOOST = 1.5;
// Below this similarity a vector match is noise
const MIN_SIMILARITY = 0.3;

export interface SearchHit {
  chunk: KnowledgeChunk;
  item: KnowledgeItem;
  score: number;
}

export interface TimeRange {
  from: number;
  to: number;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday 00:00 of the week holding `ms`. */
function startOfWeek(ms: number): number {
  const start = startOfDay(ms);
  const weekday = (new Date(start).getDay() + 6) % 7;
  return start - weekday * DAY;
}

/**
 * The time a question refers to, from plain phrases such as "yesterday", "last week" or "on
 * Tuesday". Ranges are generous on purpose: they raise matching sources, they never hide others.
 */
export function timeRangeOf(query: string, now = Date.now()): TimeRange | null {
  const q = query.toLowerCase();
  const today = startOfDay(now);

  if (/\btoday\b|\bthis morning\b|\bearlier today\b/.test(q)) return { from: today, to: now };
  if (/\byesterday\b/.test(q)) return { from: today - DAY, to: today };
  const days = q.match(/\b(?:last|past) (\d{1,3}) days?\b/);
  if (days) return { from: today - Number(days[1]) * DAY, to: now };
  if (/\bthis week\b/.test(q)) return { from: startOfWeek(now), to: now };
  if (/\blast week\b|\bpast week\b/.test(q)) return { from: startOfWeek(now) - 7 * DAY, to: now };
  if (/\bthis month\b/.test(q)) {
    const date = new Date(today);
    date.setDate(1);
    return { from: date.getTime(), to: now };
  }
  if (/\blast month\b|\bpast month\b/.test(q)) {
    const date = new Date(today);
    date.setDate(1);
    date.setMonth(date.getMonth() - 1);
    return { from: date.getTime(), to: now };
  }
  const weekday = WEEKDAYS.findIndex(name => new RegExp(`\\b${name}(?:'s)?\\b`).test(q));
  if (weekday !== -1) {
    // The latest such day before today
    const back = (new Date(today).getDay() - weekday + 7) % 7 || 7;
    const from = today - back * DAY;
    return { from, to: from + DAY };
  }
  return null;
}

/** Dot product: the cosine similarity of two unit-length vectors. */
export function similarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += a[i] * b[i];
  return sum;
}

/** Scales a vector to unit length, so similarity is a dot product. */
export function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map(value => value / norm) : vector;
}

/**
 * The knowledge base held in memory for searching: every chunk, its embedding, and a keyword index.
 * Built once and rebuilt when the knowledge base changes.
 */
export class KbIndex {
  private readonly items: Map<string, KnowledgeItem>;
  private readonly chunks: Map<string, KnowledgeChunk>;
  private readonly keywords: MiniSearch<{ id: string; text: string; title: string }>;

  constructor(items: KnowledgeItem[], chunks: KnowledgeChunk[]) {
    this.items = new Map(items.map(item => [item.id, item]));
    this.chunks = new Map(chunks.filter(chunk => this.items.has(chunk.itemId)).map(chunk => [chunk.id, chunk]));
    this.keywords = new MiniSearch({
      fields: ['text', 'title'],
      searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2 }, combineWith: 'OR' },
    });
    this.keywords.addAll(
      [...this.chunks.values()].map(chunk => ({
        id: chunk.id,
        text: chunk.text,
        title: this.items.get(chunk.itemId)?.title ?? '',
      })),
    );
  }

  get size(): number {
    return this.chunks.size;
  }

  /**
   * Finds the passages that best answer a query: vector and keyword matches fused by rank, raised
   * when they fall in the time the query names, with at most a few passages per source.
   *
   * @param queryVector - The query's embedding, or null to search by keywords only
   * @param embedModel - Only vectors made by this model are compared with the query's
   */
  search(
    query: string,
    queryVector: number[] | null,
    options: { limit?: number; now?: number; embedModel?: string | null } = {},
  ): SearchHit[] {
    const { limit = 8, now = Date.now(), embedModel = null } = options;
    const scores = new Map<string, number>();
    const add = (ids: string[]) =>
      ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

    if (queryVector) {
      const ranked = [...this.chunks.values()]
        .filter(chunk => chunk.vector && (!embedModel || chunk.embedModel === embedModel))
        .map(chunk => ({ id: chunk.id, similarity: similarity(queryVector, chunk.vector!) }))
        .filter(hit => hit.similarity >= MIN_SIMILARITY)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, CANDIDATES);
      add(ranked.map(hit => hit.id));
    }
    if (query.trim()) {
      add(
        this.keywords
          .search(query)
          .slice(0, CANDIDATES)
          .map(result => String(result.id)),
      );
    }

    const range = timeRangeOf(query, now);
    const hits: SearchHit[] = [];
    for (const [id, base] of scores) {
      const chunk = this.chunks.get(id)!;
      const item = this.items.get(chunk.itemId)!;
      const inRange = range && item.sourceDate >= range.from && item.sourceDate <= range.to;
      hits.push({ chunk, item, score: inRange ? base * TIME_BOOST : base });
    }
    hits.sort((a, b) => b.score - a.score);

    const perItem = new Map<string, number>();
    const chosen: SearchHit[] = [];
    for (const hit of hits) {
      const count = perItem.get(hit.item.id) ?? 0;
      if (count >= PER_ITEM) continue;
      perItem.set(hit.item.id, count + 1);
      chosen.push(hit);
      if (chosen.length >= limit) break;
    }
    return chosen;
  }
}
