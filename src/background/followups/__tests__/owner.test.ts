import { describe, expect, it } from 'vitest';
import type { Person } from '@extension/storage';
import { isOwnerName, isOwnerPerson, ownedByOther, ownerNamesOf } from '../owner';

const owner = ownerNamesOf('Avi Example');
const person = (name: string, aliases: string[] = []): Pick<Person, 'name' | 'aliases'> => ({
  name,
  aliases: aliases.map(text => ({ text }) as Person['aliases'][number]),
});
const people = new Map([
  ['p-ada', person('Ada Example')],
  ['p-me', person('Avi Example')],
  ['p-alias', person('A. Person', ['Avi'])],
]);

describe('ownerNamesOf', () => {
  it('holds the full name and its first word', () => {
    expect([...owner.keys].sort()).toEqual(['avi', 'avi example']);
  });
  it('is empty without a profile name', () => {
    expect(ownerNamesOf('  ').keys.size).toBe(0);
  });
});

describe('isOwnerName', () => {
  it.each([
    ['Avi', true],
    ['avi example', true],
    ['AVI EXAMPLE', true],
    ['me', true],
    ['I', true],
    ['You', true],
    ['Ada', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%s -> %s', (name, expected) => {
    expect(isOwnerName(name as string | null | undefined, owner)).toBe(expected);
  });
});

describe('isOwnerPerson', () => {
  it('matches by name or alias', () => {
    expect(isOwnerPerson(people.get('p-me'), owner)).toBe(true);
    expect(isOwnerPerson(people.get('p-alias'), owner)).toBe(true);
    expect(isOwnerPerson(people.get('p-ada'), owner)).toBe(false);
    expect(isOwnerPerson(undefined, owner)).toBe(false);
  });
});

describe('ownedByOther', () => {
  it.each([
    ['Ada by name', { ownerId: null, ownerName: 'Ada' }, true],
    ['Ada by id', { ownerId: 'p-ada', ownerName: 'Ada' }, true],
    ['an id with no name', { ownerId: 'p-ada', ownerName: null }, true],
    ['"me"', { ownerId: null, ownerName: 'me' }, false],
    ['"I"', { ownerId: null, ownerName: 'I' }, false],
    ['"You"', { ownerId: null, ownerName: 'You' }, false],
    ["Avi's profile name", { ownerId: null, ownerName: 'Avi Example' }, false],
    ["Avi's first word", { ownerId: null, ownerName: 'Avi' }, false],
    ["linked to Avi's person record", { ownerId: 'p-me', ownerName: 'Someone' }, false],
    ["linked to a person with Avi's alias", { ownerId: 'p-alias', ownerName: null }, false],
    ['"Unassigned"', { ownerId: null, ownerName: 'Unassigned' }, false],
    ['null', { ownerId: null, ownerName: null }, false],
    ['blank', { ownerId: null, ownerName: '   ' }, false],
    ['"team"', { ownerId: null, ownerName: 'team' }, false],
    ['"the team"', { ownerId: null, ownerName: 'the team' }, false],
    ['"Unassigned" even with an id', { ownerId: 'p-ada', ownerName: 'Unassigned' }, false],
  ])('%s -> %s', (_name, task, expected) => {
    expect(ownedByOther(task, owner, people)).toBe(expected);
  });
});
