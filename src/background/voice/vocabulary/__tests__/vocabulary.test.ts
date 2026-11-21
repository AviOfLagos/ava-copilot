import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, checkHeardAs, createVocabularyStore, spelledOut, suggestRule } from '@extension/storage';
import type { VocabEntry } from '@extension/storage';
import { addVocabulary, saidByUser } from '../add';
import { hintFromEntries } from '../hint';
import { correctTranscript } from '../index';
import type { CorrectDeps } from '../index';
import { seedsFromNames, worthSeeding } from '../seeds';
import { isEnglishWord } from '../words';
import { ENTRIES, entry } from './fixtures';

let db: AviCopilotDb;
let store: ReturnType<typeof createVocabularyStore>;
beforeEach(() => {
  db = new AviCopilotDb(`vocab-${crypto.randomUUID()}`);
  store = createVocabularyStore(db);
});

describe('what may be kept as "heard as"', () => {
  it('needs two letters once punctuation is removed', () => {
    expect(checkHeardAs('L', 'Ellum', 'avi', isEnglishWord)).toBe('tooShort');
    expect(checkHeardAs('.', 'Ellum', 'avi', isEnglishWord)).toBe('tooShort');
    expect(checkHeardAs('L.M.', 'Ellum', 'avi', isEnglishWord)).toBeNull();
  });
  it('is at most three words and never the spelling itself', () => {
    expect(checkHeardAs('one two three four', 'Ellum', 'avi', isEnglishWord)).toBe('tooLong');
    expect(checkHeardAs('ellum', 'Ellum', 'avi', isEnglishWord)).toBe('sameAsWrite');
  });
  it('an ordinary English word only when the owner typed it', () => {
    expect(checkHeardAs('allume', 'Ellum', 'seed', isEnglishWord)).toBeNull();
    expect(checkHeardAs('album', 'Ellum', 'seed', isEnglishWord)).toBe('ordinaryWord');
    expect(checkHeardAs('album', 'Ellum', 'correction', isEnglishWord)).toBe('ordinaryWord');
    expect(checkHeardAs('album', 'Ellum', 'avi', isEnglishWord)).toBeNull();
  });
});

describe('the store', () => {
  it('adds an entry and merges what is heard into the same spelling in the same scope', async () => {
    await store.add({ write: 'Ellum', heardAs: ['Illum'] });
    await store.add({ write: ' ellum ', heardAs: ['Elum', 'Illum'] });
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0].heardAs.sort()).toEqual(['Elum', 'Illum']);
    expect(all[0].learnedFrom).toBe('avi');
  });

  it('keeps a workspace entry apart from an everywhere entry', async () => {
    await store.add({ write: 'Ellum', workspaceId: null });
    await store.add({ write: 'Ellum', workspaceId: 'ws-a' });
    expect(await store.all()).toHaveLength(2);
  });

  it("a seed never replaces the owner's entry, and the owner's typing makes a seed his", async () => {
    await store.add({ write: 'Ellum', heardAs: ['Illum'], learnedFrom: 'avi' });
    await store.add({ write: 'ELLUM', heardAs: ['Elem'], learnedFrom: 'seed' });
    let [only] = await store.all();
    expect(only.write).toBe('Ellum');
    expect(only.heardAs).toEqual(['Illum']);
    await store.remove(only.id);
    await store.add({ write: 'Quillon', learnedFrom: 'seed' });
    await store.add({ write: 'Quillon', heardAs: ['Killon'], learnedFrom: 'avi' });
    [only] = await store.all();
    expect(only.learnedFrom).toBe('avi');
  });

  it('refuses a spelling of fewer than two letters', async () => {
    expect(await store.add({ write: 'E' })).toBeNull();
  });

  it("counts uses, and an owner's edit makes the entry his", async () => {
    const added = await store.add({ write: 'Zorvane', learnedFrom: 'seed' });
    await store.countUses([added!.id, added!.id]);
    expect((await store.all())[0].uses).toBe(2);
    await store.update(added!.id, { heardAs: ['Zor Vane'] });
    expect((await store.all())[0]).toMatchObject({ learnedFrom: 'avi', heardAs: ['Zor Vane'], uses: 2 });
  });

  it('keeps seeds in step: adds, renames, and drops what is gone, without touching other groups', async () => {
    await store.syncSeeds('workspace', [{ key: 'a', write: 'Brindle Labs', kind: 'name', workspaceId: null }]);
    await store.syncSeeds('person', [{ key: 'p1:0', write: 'Haldane', kind: 'person', workspaceId: null }]);
    await store.syncSeeds('workspace', [{ key: 'a', write: 'Brindle Works', kind: 'name', workspaceId: null }]);
    expect((await store.all()).map(e => e.write).sort()).toEqual(['Brindle Works', 'Haldane']);
    await store.syncSeeds('workspace', []);
    expect((await store.all()).map(e => e.write)).toEqual(['Haldane']);
  });

  it('keeps what the owner typed when the seed of the same name goes', async () => {
    await store.add({ write: 'Brindle Works', learnedFrom: 'avi' });
    await store.syncSeeds('workspace', []);
    expect(await store.all()).toHaveLength(1);
  });

  it('"never change" entries make a keep list and are not spellings', async () => {
    await store.add({ write: 'Illum', never: true });
    expect([...(await store.keepWords())]).toEqual(['illum']);
    expect((await store.all())[0].heardAs).toEqual([]);
  });
});

describe('seeds from names', () => {
  it('seeds workspace and product names that are not ordinary words', () => {
    const seeds = seedsFromNames(
      [
        { id: 'w1', name: 'Ellum' },
        { id: 'w2', name: 'My Workspace' },
        { id: 'w3', name: 'Work' },
        { id: 'w4', name: 'Quiet Hours' },
        { id: 'w5', name: 'Quillon Labs' },
      ],
      [{ workspaceId: 'w1', name: 'Ellum Cloud' }],
    );
    expect(seeds.workspaces.map(seed => seed.write)).toEqual(['Ellum', 'Quillon Labs']);
    expect(seeds.products.map(seed => seed.write)).toEqual(['Ellum Cloud']);
  });
  it('a short name or a made of ordinary words is not worth seeding', () => {
    expect(worthSeeding('Ada')).toBe(false);
    expect(worthSeeding('Personal')).toBe(false);
    expect(worthSeeding('Quillon')).toBe(true);
  });
});

describe('saying it: "it is spelled E-L-L-U-M", "when you hear Illum, write Ellum"', () => {
  it('turns spelled letters into the word', () => {
    expect(spelledOut('E-L-L-U-M')).toBe('Ellum');
    expect(spelledOut('e l l u m')).toBe('Ellum');
    expect(spelledOut('E.L.L.U.M.')).toBe('Ellum');
    expect(spelledOut('Ellum')).toBe('Ellum');
    expect(spelledOut('a b')).toBe('Ab');
  });

  it('saves the spelling and what it is heard as, and says so', async () => {
    const result = await addVocabulary({ write: 'E-L-L-U-M', heardAs: ['Illum'] }, store);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('"Ellum"');
    expect(await store.all()).toEqual([expect.objectContaining({ write: 'Ellum', heardAs: ['Illum'] })]);
  });

  it('the owner may say an ordinary word; a learned correction may not', async () => {
    expect((await addVocabulary({ write: 'Ellum', heardAs: ['album'] }, store)).refused).toEqual([]);
    const learned = await addVocabulary(
      { write: 'Quillon', heardAs: ['quil lon', 'album'], learnedFrom: 'correction' },
      store,
    );
    expect(learned.saved).toEqual(['quil lon']);
    expect(learned.refused).toEqual(['album']);
    expect(learned.message).toContain('ordinary word');
  });

  it('a correction learned by itself is never made of ordinary words, even two of them', async () => {
    const result = await addVocabulary({ write: 'gonna', heardAs: ['going to'], learnedFrom: 'correction' }, store);
    expect(result.refused).toEqual(['going to']);
    expect((await store.all())[0].heardAs).toEqual([]);
  });

  it('refuses a spelling that is not a word', async () => {
    const result = await addVocabulary({ write: 'E' }, store);
    expect(result.ok).toBe(false);
    expect(await store.all()).toEqual([]);
  });
});

describe('what the user must have said', () => {
  it("needs the spelling, and what it was heard as, in the user's own words", () => {
    expect(saidByUser('Ava, it is spelled E L L U M', 'Ellum')).toBe(true);
    expect(saidByUser('when you hear Illum, write Ellum', 'Ellum', ['Illum'])).toBe(true);
    // Words a page or a call said, not the user
    expect(saidByUser('Open the invoices page', 'Ellum')).toBe(false);
    expect(saidByUser('it is spelled Ellum', 'Ellum', ['yes'])).toBe(false);
    expect(saidByUser('', 'Ellum')).toBe(false);
  });
});

describe('seeds and the owner', () => {
  it('never write over what the owner edited, and do not come back once removed', async () => {
    await store.syncSeeds('workspace', [{ key: 'a', write: 'Quillon Labs', kind: 'name', workspaceId: null }]);
    const [seed] = await store.all();
    await store.update(seed.id, { write: 'Quillon Labs Ltd', heardAs: ['Quill on Labs'] });
    await store.syncSeeds('workspace', [{ key: 'a', write: 'Quillon Labs', kind: 'name', workspaceId: null }]);
    expect(await store.all()).toEqual([expect.objectContaining({ write: 'Quillon Labs Ltd', learnedFrom: 'avi' })]);
    await store.remove(seed.id);
    await store.syncSeeds(
      'workspace',
      [{ key: 'a', write: 'Quillon Labs', kind: 'name', workspaceId: null }],
      new Set([seed.id]),
    );
    expect(await store.all()).toEqual([]);
  });

  it('a product name applies in its own workspace only', () => {
    const seeds = seedsFromNames([], [{ workspaceId: 'ws-a', name: 'Zorvane' }]);
    expect(seeds.products[0].workspaceId).toBe('ws-a');
  });
});

describe('learning from a correction in the composer', () => {
  it.each([
    ['Please open Illum AI now', 'Please open Ellum AI now', 'Illum', 'Ellum'],
    ['Call Killon back', 'Call Quillon back', 'Killon', 'Quillon'],
    ['The Zor Vane beta', 'The Zorvane beta', 'Zor Vane', 'Zorvane'],
    ['Send it to L.M. today', 'Send it to Ellum today', 'L.M', 'Ellum'],
  ])('"%s" edited to "%s" is a rule: %s for %s', (before, after, from, to) => {
    expect(suggestRule(before, after)).toEqual({ from, to });
  });

  it.each([
    ['Please open Illum AI now', 'Please open Illum AI now'],
    ['See you tomorrow at noon', 'See you Friday at noon'],
    ['Please open Illum AI now', 'Please open illum AI now'],
    ['Please open Illum AI now', 'Please open now'],
    ['Please open Illum AI now', 'Please open Illum AI now, thanks'],
    ['Please open Illum AI now', 'Kindly close the old report immediately'],
    ['Open it', 'Open it a b c d'],
  ])('"%s" edited to "%s" is not', (before, after) => {
    expect(suggestRule(before, after)).toBeNull();
  });
});

describe('the recogniser hint', () => {
  it("lists the entries in scope, the owner's first, with what they are heard as", () => {
    const hint = hintFromEntries(
      [
        ...ENTRIES(),
        entry('Seedling', [], { learnedFrom: 'seed' }),
        entry('Hidden', ['Hiden'], { workspaceId: 'other' }),
        entry('Illum', [], { never: true }),
      ],
      null,
    );
    expect(hint).toContain('Ellum (not Illum, L.M.)');
    expect(hint).not.toContain('Hidden');
    expect(hint).not.toContain('; Illum');
    expect(hint.indexOf('Ellum')).toBeLessThan(hint.indexOf('Seedling'));
  });

  it('is empty without entries and stays short with many', () => {
    expect(hintFromEntries([], null)).toBe('');
    const many = Array.from({ length: 200 }, (_, i) => entry(`Name${i}x`, ['Heard A', 'Heard B']));
    expect(hintFromEntries(many, null).length).toBeLessThan(700);
  });
});

describe('correctTranscript', () => {
  const depsWith = (entries: VocabEntry[], extra: Partial<CorrectDeps> = {}): CorrectDeps => ({
    entries: async () => entries,
    keep: async () => new Set(),
    countUses: vi.fn(async () => {}),
    sync: async () => {},
    isWord: isEnglishWord,
    ...extra,
  });

  it('corrects and counts which entries fired', async () => {
    const countUses = vi.fn(async () => {});
    const entries = ENTRIES();
    const result = await correctTranscript(
      'Illum AI and Elum',
      { workspaceId: null },
      depsWith(entries, { countUses }),
    );
    expect(result.text).toBe('Ellum AI and Ellum');
    expect(countUses).toHaveBeenCalledWith([entries[0].id, entries[0].id]);
  });

  it('never throws and never loses the words when the store fails', async () => {
    const broken = depsWith([], {
      entries: async () => {
        throw new Error('disk');
      },
    });
    expect(await correctTranscript('Illum AI', {}, broken)).toEqual({ text: 'Illum AI', changes: [], unsure: [] });
  });

  it('works on the stored table end to end', async () => {
    await store.add({ write: 'Ellum', heardAs: ['Illum'] });
    const result = await correctTranscript('Illum AI', {}, depsWith(await store.all()));
    expect(result.text).toBe('Ellum AI');
  });
});
