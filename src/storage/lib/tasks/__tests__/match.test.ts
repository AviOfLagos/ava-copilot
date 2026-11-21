import { describe, expect, it } from 'vitest';
import { isSameTask, normaliseTitle, numbersOf, overlap, ownerKey, sameTitle, titleWords } from '../match';
import type { Task, TaskCandidate } from '../types';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 10, 18, 10).getTime();

const task = (fields: Partial<Task> = {}): Task => ({
  id: 'tsk_aaaaaaaaaa',
  title: 'Send the login to Ada',
  workspaceId: 'ws-1',
  workspaceSetBy: 'rule',
  ownerId: null,
  ownerName: 'Ada',
  status: 'open',
  source: { kind: 'meeting', id: 'm-1' },
  seenIn: ['m-1'],
  links: [],
  externalRefs: [],
  createdAt: T0,
  updatedAt: T0,
  ...fields,
});

const mention = (fields: Partial<TaskCandidate> = {}): TaskCandidate => ({
  title: 'Send the login to Ada',
  workspaceId: 'ws-1',
  ownerName: 'Ada',
  source: { kind: 'meeting', id: 'm-2' },
  ...fields,
});

describe('normalising a title', () => {
  it('lowers case, drops punctuation and squeezes spaces', () => {
    expect(normaliseTitle('  Send   the LOGIN, to Ada!! ')).toBe('send the login to ada');
    expect(normaliseTitle("Don't forget: ship v2")).toBe('dont forget ship v2');
  });

  it('drops the stop list from the word set', () => {
    expect([...titleWords('Please send the deck to Ada and Bo')]).toEqual(['send', 'deck', 'ada', 'bo']);
  });
});

describe('the same title', () => {
  it.each([
    ['Send the login to Ada', 'send the login to ada.', true, 'equal after normalising'],
    ['Send the login to Ada', 'Please send login to Ada', true, 'only stop words differ'],
    ['Update the pricing page', 'Update pricing page copy', false, 'overlap 0.75 is below 0.85'],
    ['Review PR 12', 'Review PR 13', false, 'a number in one is not in the other'],
    ['Review PR 12', 'Review PR #12', true, 'the same number'],
    ['Ship v1.2 release notes', 'Ship v1.3 release notes', false, 'versions are numbers'],
    ['Call the bank', 'Call the bank 2 times', false, 'a number on one side only'],
    ['Draft the Q4 plan for Orchid', 'Draft Q4 plan for Orchid', true, 'stop words and same number'],
    ['Write the blog post', 'Write the onboarding email', false, 'different work'],
  ])('%s / %s → %s (%s)', (a, b, expected) => {
    expect(sameTitle(a, b)).toBe(expected);
    expect(sameTitle(b, a)).toBe(expected);
  });

  it('measures overlap as shared words over all words', () => {
    expect(overlap(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c', 'd']))).toBeCloseTo(0.75);
    expect(overlap(new Set(), new Set())).toBe(0);
  });

  it('reads numbers from titles', () => {
    expect([...numbersOf('PR 12 and v1.2 at 3pm')]).toEqual(['12', '1.2', '3']);
  });

  it('reads "1,000" as 1000 and "2,5" as 2.5', () => {
    expect([...numbersOf('Raise 1,000 by 2,5 points')]).toEqual(['1000', '2.5']);
    expect([...numbersOf('Raise 1000')]).toEqual([...numbersOf('Raise 1,000')]);
  });
});

describe('the same task', () => {
  it('matches the same title, workspace and owner within 14 days', () => {
    expect(isSameTask(task(), mention(), T0 + 13 * DAY)).toBe(true);
  });

  it('does not match a mention more than 14 days after the last change', () => {
    expect(isSameTask(task(), mention(), T0 + 15 * DAY)).toBe(false);
  });

  it('keeps workspaces apart, and "no workspace" is its own', () => {
    expect(isSameTask(task(), mention({ workspaceId: 'ws-2' }), T0)).toBe(false);
    expect(isSameTask(task(), mention({ workspaceId: null }), T0)).toBe(false);
    expect(isSameTask(task({ workspaceId: null }), mention({ workspaceId: null }), T0)).toBe(true);
  });

  it('keeps two owners apart, but one side without an owner matches', () => {
    expect(isSameTask(task(), mention({ ownerName: 'Bo' }), T0)).toBe(false);
    expect(isSameTask(task(), mention({ ownerName: null }), T0)).toBe(true);
    expect(isSameTask(task(), mention({ ownerName: 'Unassigned' }), T0)).toBe(true);
    expect(isSameTask(task({ ownerName: null }), mention({ ownerName: 'Bo' }), T0)).toBe(true);
    expect(isSameTask(task(), mention({ ownerName: 'ada' }), T0)).toBe(true);
  });

  it('lets person ids decide when both sides have one', () => {
    expect(isSameTask(task({ ownerId: 'p1' }), mention({ ownerId: 'p2', ownerName: 'Ada' }), T0)).toBe(false);
    expect(isSameTask(task({ ownerId: 'p1' }), mention({ ownerId: 'p1', ownerName: 'Ada L.' }), T0)).toBe(true);
  });

  it('reads "Unassigned" and friends as no owner', () => {
    expect(ownerKey('Unassigned')).toBeNull();
    expect(ownerKey(' TBD ')).toBeNull();
    expect(ownerKey('Ada')).toBe('ada');
  });
});
