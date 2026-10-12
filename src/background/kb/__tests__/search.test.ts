import { describe, expect, it } from 'vitest';
import type { KnowledgeChunk, KnowledgeItem } from '@extension/storage';
import { KbIndex, normalize, similarity, timeRangeOf } from '../search';

// Thursday 1 October 2026, 15:00 local time
const NOW = new Date(2026, 9, 1, 15, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function item(id: string, fields: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id,
    sourceType: 'meeting',
    sourceId: id,
    title: id,
    url: '',
    sourceDate: NOW - 30 * DAY,
    sourceUpdatedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    chunkCount: 0,
    unembedded: 0,
    ...fields,
  };
}

function chunk(itemId: string, index: number, text: string, vector: number[] | null = null): KnowledgeChunk {
  return {
    id: `${itemId}#${index}`,
    itemId,
    index,
    text,
    label: 'note',
    anchor: { kind: 'meeting', meetingId: itemId, t: -1 },
    hash: '',
    vector: vector && normalize(vector),
    embedModel: vector ? 'e1' : null,
  };
}

describe('timeRangeOf', () => {
  const day = (ms: number) => new Date(ms).toDateString();

  it('reads yesterday and today', () => {
    expect(day(timeRangeOf('what did we say yesterday', NOW)!.from)).toBe('Wed Sep 30 2026');
    expect(timeRangeOf('notes from today', NOW)!.to).toBe(NOW);
  });

  it('reads last week as the previous week up to now', () => {
    const range = timeRangeOf('What did we decide about Stage 2 deadlines last week?', NOW)!;
    expect(day(range.from)).toBe('Mon Sep 21 2026');
    expect(range.to).toBe(NOW);
  });

  it('reads a weekday as the latest one before today', () => {
    expect(day(timeRangeOf("Monday's standup", NOW)!.from)).toBe('Mon Sep 28 2026');
    // Today is Thursday, so "Thursday" means a week ago
    expect(day(timeRangeOf('the call on thursday', NOW)!.from)).toBe('Thu Sep 24 2026');
  });

  it('reads a number of days', () => {
    expect(day(timeRangeOf('in the past 3 days', NOW)!.from)).toBe('Mon Sep 28 2026');
  });

  it('finds no time in a question without one', () => {
    expect(timeRangeOf('who owns the mentor emails?', NOW)).toBeNull();
  });
});

describe('similarity', () => {
  it('is 1 for the same direction and 0 for orthogonal vectors', () => {
    expect(similarity(normalize([3, 4]), normalize([6, 8]))).toBeCloseTo(1);
    expect(similarity([1, 0], [0, 1])).toBe(0);
  });
});

describe('KbIndex', () => {
  it('finds passages by keyword without embeddings', () => {
    const index = new KbIndex(
      [item('a'), item('b')],
      [chunk('a', 0, 'Stage 2 deadline moved to Friday'), chunk('b', 0, 'Lunch menu for the offsite')],
    );
    const hits = index.search('stage deadline', null, { now: NOW });
    expect(hits.map(hit => hit.chunk.id)).toEqual(['a#0']);
  });

  it('finds passages by meaning when the words differ', () => {
    const index = new KbIndex(
      [item('a'), item('b')],
      [chunk('a', 0, 'Mentors get an email on Thursday', [1, 0, 0]), chunk('b', 0, 'Budget review', [0, 1, 0])],
    );
    const hits = index.search('who contacts the advisers', normalize([0.9, 0.1, 0]), { now: NOW, embedModel: 'e1' });
    expect(hits[0].chunk.id).toBe('a#0');
    // The budget passage is below the similarity floor and has no keyword in common
    expect(hits).toHaveLength(1);
  });

  it('ignores vectors made by another embedding model', () => {
    const index = new KbIndex([item('a')], [chunk('a', 0, 'Mentors get an email', [1, 0])]);
    expect(index.search('advisers', [1, 0], { embedModel: 'e2' })).toEqual([]);
  });

  it('ranks a source from the time the question names above an equal one', () => {
    const index = new KbIndex(
      [item('old', { sourceDate: NOW - 40 * DAY }), item('recent', { sourceDate: NOW - 3 * DAY })],
      [chunk('old', 0, 'Stage 2 deadline is Monday'), chunk('recent', 0, 'Stage 2 deadline is Friday')],
    );
    const hits = index.search('stage 2 deadline last week', null, { now: NOW });
    expect(hits[0].item.id).toBe('recent');
    expect(hits).toHaveLength(2);
  });

  it('takes at most three passages from one source', () => {
    const chunks = Array.from({ length: 6 }, (_, i) => chunk('long', i, `deadline detail ${i}`));
    const index = new KbIndex([item('long'), item('other')], [...chunks, chunk('other', 0, 'deadline elsewhere')]);
    const hits = index.search('deadline', null, { now: NOW });
    expect(hits.filter(hit => hit.item.id === 'long')).toHaveLength(3);
    expect(hits.some(hit => hit.item.id === 'other')).toBe(true);
  });

  it('skips chunks whose item is gone', () => {
    const index = new KbIndex([item('a')], [chunk('a', 0, 'kept'), chunk('gone', 0, 'kept too')]);
    expect(index.size).toBe(1);
  });

  it("keeps a search in one workspace away from another workspace's knowledge", () => {
    const index = new KbIndex(
      [item('tef', { workspaceId: 'tef' }), item('nex', { workspaceId: 'nexprove' }), item('none')],
      [
        chunk('tef', 0, 'sponsor deadline is Friday', [1, 0]),
        chunk('nex', 0, 'sponsor deadline is Monday', [1, 0]),
        chunk('none', 0, 'sponsor deadline general note', [1, 0]),
      ],
    );
    const ids = (workspaceId: string | null) =>
      index
        .search('sponsor deadline', [1, 0], { workspaceId })
        .map(hit => hit.item.id)
        .sort();
    expect(ids('tef')).toEqual(['none', 'tef']);
    expect(ids('nexprove')).toEqual(['nex', 'none']);
    expect(ids(null)).toEqual(['nex', 'none', 'tef']);
  });

  it("keeps a search for one agent to that agent's knowledge", () => {
    const index = new KbIndex(
      [item('mine', { agentId: 'scout' }), item('theirs', { agentId: 'writer' }), item('nobody')],
      [
        chunk('mine', 0, 'launch checklist done', [1, 0]),
        chunk('theirs', 0, 'launch checklist draft', [1, 0]),
        chunk('nobody', 0, 'launch checklist notes', [1, 0]),
      ],
    );
    const ids = (agentId: string | null) =>
      index
        .search('launch checklist', [1, 0], { agentId })
        .map(hit => hit.item.id)
        .sort();
    expect(ids('scout')).toEqual(['mine']);
    expect(ids(null)).toEqual(['mine', 'nobody', 'theirs']);
  });
});
