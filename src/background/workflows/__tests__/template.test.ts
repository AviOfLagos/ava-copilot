import { describe, expect, it } from 'vitest';
import { compactJson, forStorage, lookupPath, malformedPlaces, resolveTemplate, templateRefs } from '../template';
import { resolveParams } from '../engine';

const scope = {
  steps: {
    hn: {
      output: {
        hits: [
          { title: 'First', points: 120 },
          { title: 'Second', points: 80 },
        ],
      },
    },
    sum: { output: 'Two stories.' },
  },
  run: { date: '2026-10-12' },
  workflow: { name: 'News' },
};

describe('templates', () => {
  it('fills places from earlier steps: text as it is, data as JSON, paths into lists', () => {
    expect(resolveTemplate('{{steps.sum.output}}', scope)).toBe('Two stories.');
    expect(resolveTemplate('Top: {{ steps.hn.output.hits.0.title }} ({{steps.hn.output.hits.0.points}})', scope)).toBe(
      'Top: First (120)',
    );
    expect(resolveTemplate('{{steps.hn.output.hits}}', scope)).toBe(
      '[{"title":"First","points":120},{"title":"Second","points":80}]',
    );
    expect(resolveTemplate('{{workflow.name}} on {{run.date}}', scope)).toBe('News on 2026-10-12');
  });

  it('leaves nothing for what it cannot find, and never walks into prototypes', () => {
    expect(resolveTemplate('[{{steps.missing.output}}]', scope)).toBe('[]');
    expect(resolveTemplate('[{{steps.hn.output.hits.9.title}}]', scope)).toBe('[]');
    expect(resolveTemplate('[{{steps.sum.constructor}}]', scope)).toBe('[]');
    expect(lookupPath({ a: {} }, ['a', '__proto__', 'polluted'])).toBeUndefined();
    expect(lookupPath(scope, ['steps', 'hn', 'output', 'hits', 'length'])).toBeUndefined();
  });

  it('finds places and the ones written wrong', () => {
    expect(templateRefs('{{steps.a.output}} and {{run.date}}')).toEqual([
      ['steps', 'a', 'output'],
      ['run', 'date'],
    ]);
    expect(malformedPlaces('{{steps.a.output}} {{ steps a }} {{}}')).toEqual(['{{ steps a }}', '{{}}']);
  });

  it('cuts a value that would swamp a step', () => {
    const long = 'x'.repeat(50);
    expect(resolveTemplate('{{steps.long.output}}', { steps: { long: { output: long } } }, 10)).toBe(
      'xxxxxxxxxx\n[…cut at 10 characters]',
    );
  });

  it('only fills the data fields of a node', () => {
    const params = resolveParams(
      {
        id: 'pick',
        type: 'step.llm',
        label: '{{steps.sum.output}}',
        instructions: 'Use {{steps.sum.output}}',
        input: 'In: {{steps.sum.output}}',
      },
      scope,
    );
    expect(params.input).toBe('In: Two stories.');
    expect(params.instructions).toBe('Use {{steps.sum.output}}');
    expect(params.label).toBe('{{steps.sum.output}}');
  });
});

describe('compactJson and forStorage', () => {
  it('drops internal keys, cuts long text and long lists, and caps depth', () => {
    const compact = compactJson(
      { _highlight: { big: true }, title: 'a'.repeat(700), items: Array.from({ length: 45 }, (_, index) => index) },
      { maxString: 600, maxArray: 40, maxDepth: 8 },
    ) as { title: string; items: unknown[] };
    expect(compact).not.toHaveProperty('_highlight');
    expect(compact.title).toHaveLength(601);
    expect(compact.items).toHaveLength(41);
    expect(compact.items[40]).toBe('…and 5 more');
    expect(compactJson({ a: { b: { c: 1 } } }, { maxString: 10, maxArray: 10, maxDepth: 2 })).toEqual({
      a: { b: '{…}' },
    });
  });

  it('keeps a value whole when it fits, else as cut text', () => {
    expect(forStorage({ a: 1 })).toEqual({ a: 1 });
    expect(forStorage(undefined)).toBeNull();
    expect(typeof forStorage({ text: 'y'.repeat(300) }, 100)).toBe('string');
  });
});
