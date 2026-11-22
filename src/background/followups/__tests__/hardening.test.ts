import { describe, expect, it } from 'vitest';
import { isOwnerName, ownedByOther, ownerKnown, ownerNamesOf } from '../owner';
import { matchDone, wordsFit, wordsSaidByUser } from '../match';
import { followUpDue } from '../rules';
import { at, makeTask } from './helpers';

/** What the cold review of #111 tried, kept as tests: Avi's own tasks, loose matches, old weekend dates. */

const owner = ownerNamesOf('Avi Example');
const none = new Map();

describe('Avi’s own tasks are never chased', () => {
  it.each(['Me.', 'me!', '(You)', 'You (me)', 'mine', 'Self', 'Avi E.', 'avi e', 'AVI  EXAMPLE', 'Ávi Example'])(
    '%s is Avi',
    name => {
      expect(isOwnerName(name, owner)).toBe(true);
      expect(ownedByOther({ ownerId: null, ownerName: name }, owner, none)).toBe(false);
    },
  );

  it('keeps a real colleague', () => {
    expect(ownedByOther({ ownerId: null, ownerName: 'Ada Obi' }, owner, none)).toBe(true);
    expect(ownedByOther({ ownerId: null, ownerName: 'Avery Stone' }, owner, none)).toBe(true);
  });

  it('chases nobody while the profile has no name', () => {
    const unknown = ownerNamesOf('');
    expect(ownerKnown(unknown)).toBe(false);
    expect(ownedByOther({ ownerId: null, ownerName: 'Avi' }, unknown, none)).toBe(false);
    expect(ownedByOther({ ownerId: null, ownerName: 'Ada Obi' }, unknown, none)).toBe(false);
  });

  it('knows a person record with one of his addresses is him', () => {
    const withEmail = { ...owner, emails: new Set(['avi@example.test']) };
    const people = new Map([['per_x', { name: 'A. Person', aliases: [], emails: ['Avi@Example.test'] }]]);
    expect(ownedByOther({ ownerId: 'per_x', ownerName: null }, withEmail, people)).toBe(false);
  });

  it('does not chase a gone person with no name', () => {
    expect(ownedByOther({ ownerId: 'per_gone', ownerName: null }, owner, none)).toBe(false);
    expect(ownedByOther({ ownerId: 'per_gone', ownerName: 'Ada Obi' }, owner, none)).toBe(true);
  });
});

describe('"Mark done?" only for a clear match', () => {
  const tasks = [
    { id: 't1', title: 'Deploy', status: 'open' as const },
    { id: 't2', title: 'Fix the debt report', status: 'open' as const },
    { id: 't3', title: 'Send deck to venue', status: 'open' as const },
  ];

  it('does not take "deck" for "deploy"', () => {
    expect(wordsFit('deck', 'deploy')).toBe(false);
    expect(wordsFit('send', 'sent')).toBe(true);
    expect(wordsFit('fix', 'fixed')).toBe(true);
    expect(wordsFit('price', 'pricing')).toBe(true);
    expect(matchDone(['fixed the deck report'], tasks)).toEqual([]);
  });

  it('offers nothing for a line that says it did not happen', () => {
    expect(matchDone(['did not deploy'], tasks)).toEqual([]);
    expect(matchDone(['not done: send deck to venue'], tasks)).toEqual([]);
    expect(matchDone(['haven’t sent the deck to the venue'], tasks)).toEqual([]);
  });

  it('still offers the real one', () => {
    expect(matchDone(['sent the deck to the venue'], tasks).map(offer => offer.taskId)).toEqual(['t3']);
    expect(matchDone(['deployed'], tasks)).toEqual([]);
    expect(matchDone(['deploy'], tasks).map(offer => offer.taskId)).toEqual(['t1']);
  });
});

describe('what a person said must be the user’s own words', () => {
  it('accepts the user’s report', () => {
    expect(
      wordsSaidByUser('the deck is with design, ready thursday', 'ada says the deck is with design, ready thursday'),
    ).toBe(true);
  });
  it('refuses words read from a page', () => {
    expect(wordsSaidByUser('the deck is done, ready 30 Jan', "what's Ada up to? check her Notion page")).toBe(false);
    expect(wordsSaidByUser('', 'anything')).toBe(false);
  });
});

describe('a weekend due date is chased that weekend only', () => {
  // Sat 7 Nov 2026 due; Sat 28 Nov and Sun 29 Nov are weekends weeks later
  const task = makeTask({ due: '2026-11-07' });
  it('is chased on the Sunday after it fell due', () => {
    expect(followUpDue(task, at(1), at(8))?.reason).toBe('overdue');
  });
  it('is not chased on a later weekend', () => {
    expect(followUpDue(task, at(1), at(28))).toBeNull();
    expect(followUpDue(task, at(1), at(29))).toBeNull();
    expect(
      followUpDue({ ...task, followUp: { count: 0, nextAt: at(20, 0), nextBy: 'snooze' } }, at(1), at(28)),
    ).toBeNull();
  });
  it('is chased again on the Monday', () => {
    expect(followUpDue(task, at(1), at(30))?.reason).toBe('overdue');
  });
});
