import { describe, expect, it } from 'vitest';
import type { UserFact } from '@extension/storage';
import { ABOUT_YOU_CHARS, aboutYouLines, factsLeftOut } from '../prompt';
import type { IdentityContext } from '../prompt';
import { keyWords, searchFacts } from '../recall';

// A made-up person with forty facts (ten lasting ones, told first, and thirty small newer notes): more than the prompt can show, as after a few months of use
const TOPICS = [
  'Runs a small bakery called Crumb Lane with two co-founders in the old market',
  'Their daughter goes to Kingsmead primary school and starts at eight thirty each morning',
  'Prefers short answers on the phone and longer ones in the side panel when reading at the desk',
  'Banks with a local credit union and reviews the monthly statements on the first Monday',
  'Is allergic to peanuts and keeps an injector in the shop and in the car at all times',
  'Plays five-a-side football on Thursday evenings with the neighbourhood team',
  'Is saving for a delivery van and wants a quote from three suppliers before the spring',
  'Has a brother named Tobias who lives in Leeds and visits every second summer',
  'Drinks oat milk flat whites and avoids sugar before noon on weekdays',
  'Wants the weekly flour order placed every Tuesday before ten in the morning',
];

function sampleFacts(count: number): UserFact[] {
  return Array.from({ length: count }, (_, index): UserFact => {
    // The first ten are the older, lasting facts; the rest are newer small notes that fill the prompt
    const text = TOPICS[index] ?? `Keeps spare key number ${index} for locker ${index} at the sports hall`;
    return {
      id: `f${index}`,
      text,
      category: 'other',
      workspaceId: null,
      source: 'said',
      status: 'active',
      via: 'chat',
      previous: [],
      createdAt: index,
      // Told over time: a higher number is newer, and the newest facts are shown first
      updatedAt: Date.UTC(2026, 0, 1) + index * 86_400_000,
    };
  });
}

function context(facts: UserFact[], workspaceId: string | null = null): IdentityContext {
  return {
    name: 'Ava',
    core: { character: '', values: '', purpose: '' },
    facts,
    goals: [],
    insights: [],
    workspaceId,
  } as unknown as IdentityContext;
}

describe('which stored facts the prompt drops', () => {
  const facts = sampleFacts(40);
  const ctx = context(facts);
  const shown = aboutYouLines(ctx);
  const left = factsLeftOut(ctx);

  it('shows only the newest ones, inside the 1,500 characters, and drops the rest', () => {
    // The list the issue asks for, printed when the test is run with the reporter on
    console.log(
      `shown ${shown.length} of ${facts.length} facts in ${shown.join('\n').length} characters; left out: ${left.map(f => f.id).join(', ')}`,
    );
    expect(shown.join('\n').length).toBeLessThanOrEqual(ABOUT_YOU_CHARS);
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.length).toBeLessThan(facts.length / 2);
    expect(shown.length + left.length).toBe(facts.length);
    // Newest first: what is left out is the oldest
    expect(left.map(fact => fact.id)).toEqual(
      [...facts]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(shown.length)
        .map(fact => fact.id),
    );
    expect(left.some(fact => fact.id === 'f1')).toBe(true);
  });

  it('keeps the always-on block exactly as large as before: the new code adds nothing to it', () => {
    expect(aboutYouLines(ctx)).toEqual(shown);
    expect(aboutYouLines(ctx, 10)).toEqual([]);
    expect(factsLeftOut(context([]))).toEqual([]);
  });

  it('keeps another workspace’s facts out of what is left out, as it does of what is shown', () => {
    const mixed = [
      ...sampleFacts(30),
      { ...sampleFacts(31)[30], id: 'other', workspaceId: 'w-other', text: 'A secret of another workspace' },
    ];
    const inOne = factsLeftOut(context(mixed, 'w-mine'));
    expect(inOne.map(fact => fact.id)).not.toContain('other');
  });
});

describe('recall over stored facts', () => {
  const facts = sampleFacts(40);
  const left = new Set(factsLeftOut(context(facts)).map(fact => fact.id));

  it('finds a fact the prompt never shows', () => {
    // f1 is about the daughter's school, one of the oldest: beyond the cap
    expect(left.has('f1')).toBe(true);
    const found = searchFacts(facts, 'where does my daughter go to school?', null);
    expect(found[0].fact.text).toContain('Kingsmead');
    expect(left.has(found[0].fact.id)).toBe(true);
  });

  it('finds twenty stored facts from twenty questions, none of them shown in the prompt', () => {
    const questions: [string, string][] = [
      ['what is allergic about me', 'peanuts'],
      ['who is my brother?', 'Tobias'],
      ['when do I place the flour order', 'flour'],
      ['do I play football', 'five-a-side'],
      ['what milk do I drink', 'oat milk'],
      ['what am I saving for', 'delivery van'],
      ['where does my daughter go to school', 'Kingsmead'],
      ['how do I like answers on the phone', 'short answers'],
      ['what is my bakery called', 'Crumb Lane'],
      ['who do I bank with', 'credit union'],
    ];
    for (const [question, expected] of questions) {
      const found = searchFacts(facts, question, null);
      expect(found.length, question).toBeGreaterThan(0);
      expect(found[0].fact.text, question).toContain(expected);
    }
  });

  it('says nothing for a question no fact answers, and for an empty one', () => {
    expect(searchFacts(facts, 'what is the capital of Peru', null)).toEqual([]);
    expect(searchFacts(facts, 'the and of', null)).toEqual([]);
  });

  it('keeps to the chat’s workspace and to active facts', () => {
    const other: UserFact = { ...facts[0], id: 'o', workspaceId: 'w-other', text: 'Launch date is the ninth of May' };
    const inactive: UserFact = { ...facts[0], id: 'p', status: 'proposed', text: 'Launch party is in a boat' };
    expect(searchFacts([other, inactive], 'launch', 'w-mine')).toEqual([]);
    expect(searchFacts([other], 'launch', 'w-other')).toHaveLength(1);
    expect(searchFacts([other], 'launch', null)).toHaveLength(1);
  });

  it('folds plurals and ignores filler', () => {
    expect(keyWords('What are the Allergies of my brothers?')).toEqual(['allergie', 'brother']);
    expect(keyWords('I am')).toEqual(['am']);
  });
});
