import { describe, expect, it } from 'vitest';
import { correctWithEntries, editDistance, isNear } from '../engine';
import { isEnglishWord } from '../words';
import { ENTRIES, entry } from './fixtures';

const run = (text: string, entries = ENTRIES(), keep?: Set<string>) =>
  correctWithEntries(text, entries, { workspaceId: null, isWord: isEnglishWord, keep });

// What the recogniser wrote, and what it should have written. Known mishearings and near misses.
const MISHEARD: [string, string][] = [
  // known mishearings (what the entries say)
  ['Illum AI', 'Ellum AI'],
  ['illum ai', 'Ellum ai'],
  ['ILLUM is hiring', 'Ellum is hiring'],
  ['I work at Illum.', 'I work at Ellum.'],
  ["Illum's roadmap is ready", "Ellum's roadmap is ready"],
  ['Please ask Illum about it, then Illum again', 'Please ask Ellum about it, then Ellum again'],
  ['L.M. is shipping on Friday', 'Ellum is shipping on Friday'],
  ['Did you see the L.M. dashboard', 'Did you see the Ellum dashboard'],
  ['Quill on is late today', 'Quillon is late today'],
  ['Ask Killon for the notes', 'Ask Quillon for the notes'],
  ['Zor Vane launches next week', 'Zorvane launches next week'],
  ['The Zor Vane beta and the Vex Tra beta', 'The Zorvane beta and the Vextra beta'],
  ['Brindle Lab is in Lagos', 'Brindle Labs is in Lagos'],
  // near misses: not a word, close to one spelling
  ['Elum AI', 'Ellum AI'],
  ['Elllum is up', 'Ellum is up'],
  ['The Ellam roadmap', 'The Ellum roadmap'],
  ['Ellem said so', 'Ellum said so'],
  ['Illem AI', 'Ellum AI'],
  ['Elem is shipping', 'Ellum is shipping'],
  ['Quillen is late', 'Quillon is late'],
  ['Quilon is late', 'Quillon is late'],
  ['Kwillon is late', 'Quillon is late'],
  ['Zorvain is live', 'Zorvane is live'],
  ['Zorvan is live', 'Zorvane is live'],
  ['Zorvaine shipped', 'Zorvane shipped'],
  ['Haldain called', 'Haldane called'],
  ['Haldayne called', 'Haldane called'],
  ['Pemberley emailed', 'Pemberly emailed'],
  ['Pemburly emailed', 'Pemberly emailed'],
  ['Vextro is new', 'Vextra is new'],
  ['Vextrah is new', 'Vextra is new'],
  // two words heard as one name
  ['Brindel Labs is in Lagos', 'Brindle Labs is in Lagos'],
  ['El lum is up', 'Ellum is up'],
];

// Sentences that must stay exactly as they are
const MUST_NOT_CHANGE = [
  'LM Studio is installed on my laptop',
  'I run LM Studio and Ollama locally',
  'The ratio of L to M is low',
  'The ilium is part of the pelvis in anatomy class',
  'She broke her ilium in the fall',
  'Ellum AI is already right',
  'We shipped Zorvane and Vextra yesterday',
  'Good morning, let us review the roadmap and ship the release on Friday',
  'Please send the invoice to the finance team before noon',
  'Can you move the call to three thirty tomorrow afternoon',
  'The quill and the quilt were in the same box',
  'I love an album of old photographs',
  'Ellen and Allen are coming to the review',
  'The little elm in the garden is very old',
  'The illusion of choice is a real problem',
  'Illumination of the room was poor',
  'Remind me to chase Ada about the figures',
  'I met an Ellum employee at the demo',
  'Please talk to Ellum about it',
  'It is Ellum AI that we use at home',
  'Did you ask of Zorvane or in Vextra',
  'The vector graphics are rendered by the browser',
  'Our next extra step is to extract the data',
  'Is the plumber coming on Thursday or Friday',
  'The hall was dim and the lamp was low',
  'They were pleased with the old building plan',
  'Hold on while I check the other tab',
  'The haunted house was brindled and grey',
  'He saw a pemmican tin in the pantry',
  'Hold the line while I transfer you to billing',
  'Add the quarterly numbers to the board pack',
  'The vexing problem was the timing of the release',
  'Book a table for six at seven thirty',
  'Tell me what changed since last week in the north office',
  'We will test it in staging and then promote it to production',
  'I need to renew the domain and update the billing address',
  'The tin of paint was nearly empty after the second coat',
  'She presented the findings to the whole team on Monday',
];

describe('known mishearings and near misses', () => {
  it('has at least 30 of each kind to check', () => {
    expect(MISHEARD.length).toBeGreaterThanOrEqual(30);
    expect(MUST_NOT_CHANGE.length).toBeGreaterThanOrEqual(30);
  });

  it.each(MISHEARD)('"%s" reads "%s"', (heard, expected) => {
    expect(run(heard).text).toBe(expected);
  });

  it.each(MUST_NOT_CHANGE)('"%s" is left alone', sentence => {
    const result = run(sentence);
    expect(result.text).toBe(sentence);
    expect(result.changes).toEqual([]);
  });
});

describe('the rules', () => {
  it('Illum AI becomes Ellum AI and says where, so it can be undone', () => {
    const result = run('Please open Illum AI now');
    expect(result.text).toBe('Please open Ellum AI now');
    expect(result.changes).toEqual([expect.objectContaining({ from: 'Illum', to: 'Ellum', at: 12, stage: 'known' })]);
    expect(result.text.slice(12, 17)).toBe('Ellum');
  });

  it('positions stay right after several changes of different lengths', () => {
    const result = run('L.M. and Zor Vane and Elum');
    expect(result.text).toBe('Ellum and Zorvane and Ellum');
    for (const change of result.changes) {
      expect(result.text.slice(change.at, change.at + change.to.length)).toBe(change.to);
    }
    expect(result.changes.map(change => change.stage)).toEqual(['known', 'known', 'near']);
  });

  it('"Elum" is corrected by the near-miss stage', () => {
    const result = run('Elum is great');
    expect(result.text).toBe('Ellum is great');
    expect(result.changes[0].stage).toBe('near');
  });

  it('a real word is never changed: "ilium" stays and is offered', () => {
    const result = run('The ilium is a bone');
    expect(result.text).toBe('The ilium is a bone');
    expect(result.unsure).toEqual([{ word: 'ilium', at: 4, options: ['Ellum'] }]);
  });

  it('"L.M." never rewrites "LM Studio"', () => {
    expect(run('LM Studio and L.M. Studio').text).toBe('LM Studio and Ellum Studio');
  });

  it('a word close to two spellings is not changed, and is offered with both', () => {
    const entries = [entry('Marlon'), entry('Marlen')];
    const result = run('Ask Marlin about it', entries);
    expect(result.text).toBe('Ask Marlin about it');
    expect(result.unsure[0].options.sort()).toEqual(['Marlen', 'Marlon']);
  });

  it('is only the same spelling once even when a seed and the owner both have it', () => {
    const entries = [entry('Ellum', [], { learnedFrom: 'seed' }), entry('Ellum', [])];
    expect(run('Elum is great', entries).text).toBe('Ellum is great');
  });

  it('words under four letters are not near-miss candidates', () => {
    expect(run('Elm and Elum').text).toBe('Elm and Ellum');
  });

  it('edit distance is 1 up to five letters and 2 for longer words', () => {
    expect(isNear('elum', 'ellum')).toBe(true);
    expect(isNear('ellom', 'ellum')).toBe(true);
    expect(isNear('ellem', 'ellum')).toBe(true);
    expect(isNear('qullon', 'quillon')).toBe(true);
    expect(isNear('quilen', 'quillon')).toBe(true);
    expect(isNear('quilxxn', 'quillon')).toBe(true);
    expect(isNear('quixxxn', 'quillon')).toBe(false);
  });

  it('counts swapping two neighbouring letters as one change', () => {
    expect(editDistance('ellmu', 'ellum')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBeGreaterThan(2);
  });

  it('only entries in scope apply: a workspace entry stays in its workspace', () => {
    const entries = [entry('Tolurex', ['Tolu Rex'], { workspaceId: 'ws-a' })];
    expect(correctWithEntries('Tolu Rex is up', entries, { workspaceId: 'ws-a', isWord: isEnglishWord }).text).toBe(
      'Tolurex is up',
    );
    expect(correctWithEntries('Tolu Rex is up', entries, { workspaceId: 'ws-b', isWord: isEnglishWord }).text).toBe(
      'Tolu Rex is up',
    );
    expect(correctWithEntries('Tolu Rex is up', entries, { workspaceId: null, isWord: isEnglishWord }).text).toBe(
      'Tolu Rex is up',
    );
  });

  it("the owner's entry wins over a seed that hears the same words differently", () => {
    const entries = [
      entry('Ellum Group', ['Illum'], { learnedFrom: 'seed' }),
      entry('Ellum', ['Illum'], { learnedFrom: 'avi' }),
    ];
    expect(run('Illum AI', entries).text).toBe('Ellum AI');
  });

  it('a word the user said never to change is left alone', () => {
    expect(run('Illum and Elum', ENTRIES(), new Set(['illum', 'elum'])).text).toBe('Illum and Elum');
  });

  it('keeps case, spacing and punctuation of everything else', () => {
    const text = '  Hello,\n  Illum   AI!  (and Elum?)  ';
    expect(run(text).text).toBe('  Hello,\n  Ellum   AI!  (and Ellum?)  ');
  });

  it('a short word before a misheard name is kept: "an Elum" is "an Ellum"', () => {
    expect(run('I met an Elum employee').text).toBe('I met an Ellum employee');
  });

  it('a person who was only seeded is protected but not matched by near misses', () => {
    const entries = [entry('Tobi', [], { kind: 'person', learnedFrom: 'seed' }), entry('Ellum')];
    expect(run('Toby and Tobi met Elum', entries).text).toBe('Toby and Tobi met Ellum');
    const typed = [entry('Tobi', [], { kind: 'person' })];
    expect(run('Toby met Tobi', typed).text).toBe('Tobi met Tobi');
  });

  it('a phrase is not heard across the end of a sentence unless it was written with dots', () => {
    const entries = [entry('OpenAI', ['Open AI']), entry('Ellum', ['L.M.'])];
    expect(run('They will open. AI is next', entries).text).toBe('They will open. AI is next');
    expect(run('They use Open AI daily and L.M. too', entries).text).toBe('They use OpenAI daily and Ellum too');
  });

  it('does nothing without entries or text', () => {
    expect(run('Illum', []).text).toBe('Illum');
    expect(run('   ').text).toBe('   ');
  });

  it('does not touch words inside other words', () => {
    expect(run('Illumination and Illum').text).toBe('Illumination and Ellum');
  });
});
