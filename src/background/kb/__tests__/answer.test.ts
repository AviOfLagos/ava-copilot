import { describe, expect, it } from 'vitest';
import type { KnowledgeChunk, KnowledgeItem } from '@extension/storage';
import { citationsIn, dayLabel, describeSource, hitsForAgent, questionPrompt } from '../answer';
import type { SearchHit } from '../search';
import { parseKbExport } from '../transfer';

const DATE = new Date(2026, 8, 29, 10, 0).getTime();

function hit(sourceType: KnowledgeItem['sourceType'], label: string, title = 'Stage 2 sync'): SearchHit {
  const item: KnowledgeItem = {
    id: `${sourceType}:x`,
    sourceType,
    sourceId: 'x',
    title,
    url: sourceType === 'page' ? 'https://example.com/a' : '',
    sourceDate: DATE,
    sourceUpdatedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    chunkCount: 1,
    unembedded: 0,
  };
  const anchor: KnowledgeChunk['anchor'] =
    sourceType === 'meeting'
      ? { kind: 'meeting', meetingId: 'x', t: label === 'note' ? -1 : 724 }
      : sourceType === 'thread'
        ? { kind: 'thread', threadId: 'x', seq: 3 }
        : { kind: 'page', url: 'https://example.com/a' };
  return {
    item,
    chunk: {
      id: 'c',
      itemId: item.id,
      index: 0,
      text: 'Stage 2 is Friday',
      label,
      anchor,
      hash: '',
      vector: null,
      embedModel: null,
    },
    score: 1,
  };
}

describe('describeSource', () => {
  it('names the kind, title, date and place', () => {
    expect(dayLabel(DATE)).toBe('2026-09-29 (Tuesday)');
    expect(describeSource(hit('meeting', '12:04'))).toBe('Meeting "Stage 2 sync", 2026-09-29 (Tuesday), at 12:04');
    expect(describeSource(hit('meeting', 'note'))).toBe('Meeting "Stage 2 sync", 2026-09-29 (Tuesday), meeting notes');
    expect(describeSource(hit('thread', 'message 3'))).toContain('Chat "Stage 2 sync"');
    expect(describeSource(hit('page', 'part 1', 'Docs'))).toBe(
      'Saved page "Docs" (https://example.com/a), saved 2026-09-29 (Tuesday)',
    );
  });
});

describe('questionPrompt', () => {
  it('numbers the sources and gives today', () => {
    const prompt = questionPrompt('When is Stage 2?', [hit('meeting', 'note'), hit('thread', 'message 3')], DATE);
    expect(prompt).toContain('Today is 2026-09-29 (Tuesday).');
    expect(prompt).toContain('[1] Meeting');
    expect(prompt).toContain('[2] Chat');
    expect(prompt.endsWith('Question: When is Stage 2?')).toBe(true);
  });
});

describe('citationsIn', () => {
  const hits = [hit('meeting', '12:04'), hit('thread', 'message 3'), hit('page', 'part 1')];

  it('returns the cited sources in the order first cited, once each', () => {
    const citations = citationsIn('Friday [3]. Agreed by Ada [1][3], confirmed [1, 2].', hits);
    expect(citations.map(citation => citation.n)).toEqual([3, 1, 2]);
    expect(citations[1]).toMatchObject({
      sourceType: 'meeting',
      label: '12:04',
      anchor: { kind: 'meeting', meetingId: 'x', t: 724 },
    });
  });

  it('ignores numbers that match no source', () => {
    expect(citationsIn('Nothing [7] here [0].', hits)).toEqual([]);
  });
});

describe('hitsForAgent', () => {
  it('gives each passage with the citation to use', () => {
    expect(hitsForAgent('stage 2', [hit('meeting', '12:04')])).toContain(
      '(Meeting "Stage 2 sync", 2026-09-29 (Tuesday), at 12:04)\nStage 2 is Friday',
    );
    expect(hitsForAgent('nothing', [])).toBe('The knowledge base has nothing matching "nothing".');
  });
});

describe('parseKbExport', () => {
  const valid = {
    format: 'avi-copilot-kb',
    version: 1,
    exportedAt: 1,
    items: [hit('meeting', 'note').item],
    chunks: [hit('meeting', 'note').chunk, { ...hit('meeting', 'note').chunk, id: 'orphan', itemId: 'missing' }],
  };

  it('accepts an export and drops chunks without their item', () => {
    const parsed = parseKbExport(valid);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.chunks.map(chunk => chunk.id)).toEqual(['c']);
  });

  it('refuses anything else', () => {
    expect(() => parseKbExport({ format: 'other' })).toThrow(/Not a knowledge base export/);
    expect(() => parseKbExport(null)).toThrow(/Not a knowledge base export/);
    expect(() => parseKbExport({ ...valid, items: [{ id: 'x' }] })).toThrow(/Not a knowledge base export/);
  });
});
