import { describe, expect, it } from 'vitest';
import { doneScore, matchDone, tasksNamed } from '../match';

const task = (id: string, title: string, status: 'open' | 'done' | 'dropped' = 'open') => ({ id, title, status });

describe('matchDone', () => {
  const tasks = [
    task('deck', 'Send the deck to the venue'),
    task('login', 'Fix the login page'),
    task('invoice', 'Pay the invoice for catering'),
  ];

  it.each([
    ['I sent the deck to the venue', 'deck'],
    ['sent the decks to the venue yesterday', 'deck'],
    ['finished the login page fix', 'login'],
  ])('"%s" offers %s', (line, id) => {
    expect(matchDone([line], tasks).map(offer => offer.taskId)).toEqual([id]);
  });

  it('keeps the line as said on the offer', () => {
    expect(matchDone(['I sent  the deck   to the venue'], tasks)).toEqual([
      { taskId: 'deck', said: 'I sent the deck to the venue' },
    ]);
  });

  it.each([['booked the flights to Lagos'], ['did some thinking'], ['   '], ['']])('"%s" offers nothing', line => {
    expect(matchDone([line], tasks)).toEqual([]);
  });

  it('two equally good tasks offer neither', () => {
    const twins = [task('a', 'Send the deck to the venue'), task('b', 'Send the deck to the venue')];
    expect(matchDone(['sent the deck to the venue'], twins)).toEqual([]);
  });

  it('a closed task is never offered', () => {
    expect(matchDone(['sent the deck to the venue'], [task('x', 'Send the deck to the venue', 'done')])).toEqual([]);
  });

  it('a task is offered once only, for the first line that names it', () => {
    const offers = matchDone(['sent the deck to the venue', 'the deck went to the venue too'], tasks);
    expect(offers.map(offer => offer.taskId)).toEqual(['deck']);
    expect(offers[0].said).toBe('sent the deck to the venue');
  });

  it('two lines naming two tasks offer both', () => {
    const offers = matchDone(['sent the deck to the venue', 'fixed the login page'], tasks);
    expect(offers.map(offer => offer.taskId)).toEqual(['deck', 'login']);
  });

  it('a better fit beats a weaker one', () => {
    const both = [task('short', 'Send the deck'), task('long', 'Send the deck to the venue')];
    // Every word of both titles is said: equal share, but more words shared wins
    expect(matchDone(['sent the deck to the venue'], both).map(offer => offer.taskId)).toEqual(['long']);
    // "to the venue" is not said, so only the short title fits in full
    expect(matchDone(['sent the deck'], both).map(offer => offer.taskId)).toEqual(['short']);
  });
});

describe('doneScore', () => {
  it('counts the title words the line holds', () => {
    // The opening verb ("Send") is left out: it says what kind of work, not which task
    expect(doneScore('sent the deck to the venue', 'Send the deck to the venue')).toMatchObject({ shared: 2, of: 2 });
    expect(doneScore('finished the login page', 'Build the login page')).toMatchObject({ shared: 2, of: 2 });
    expect(doneScore('deployed', 'Deploy')).toMatchObject({ of: 1, exact: 0 });
  });
});

describe('tasksNamed', () => {
  const tasks = [task('deck', 'Send the deck to the venue'), task('login', 'Fix the login page')];
  it('names every clear fit among open tasks', () => {
    expect(tasksNamed(['the deck is with the venue'], tasks)).toEqual(['deck']);
    expect(tasksNamed(['deck venue', 'login page'], tasks).sort()).toEqual(['deck', 'login']);
    expect(tasksNamed(['nothing relevant'], tasks)).toEqual([]);
  });
});
