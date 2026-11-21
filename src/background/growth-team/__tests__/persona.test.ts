import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

const local: Record<string, unknown> = {};
vi.hoisted(() => {
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string) => key },
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in store()).map(k => [k, store()[k]])),
        set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
});
function store() {
  return local;
}

const { emptyProductProfile, productStore, teamStore } = await import('@extension/storage');
const { namedSources, personaRefusal } = await import('../persona');
const { propose } = await import('../queue');

describe('a personality is only inspired by a person', () => {
  it('finds the people and their books, whatever the case or spacing', () => {
    expect(namedSources('As sean   ellis would say, ask the must-have question')).toEqual(['Sean Ellis']);
    expect(namedSources("I'm April Dunford, and positioning matters")).toEqual(['April Dunford', 'Dunford']);
    expect(namedSources('Read Zero to Sold this weekend')).toEqual(['Zero to Sold']);
    expect(namedSources('Like Bezos says: Day 1')).toEqual(['Bezos']);
  });

  it('does not take ordinary growth words for a name', () => {
    expect(
      namedSources('Traction this week: 40 sign-ups from the eval post. Growth is slow, positioning helps.'),
    ).toEqual([]);
    expect(namedSources('Ellison and Kahlo are not the people we mean')).toEqual([]);
  });

  it('refuses a draft for other people that names one, and leaves requests to the user alone', () => {
    expect(personaRefusal('post', 'Lessons', 'Arvid Kahl taught me to build in public')).toMatch(
      /names "Arvid Kahl", "Kahl".*Never name the person/,
    );
    expect(personaRefusal('outreach_email', 'Hi', 'As Sean Ellis puts it…')).not.toBeNull();
    expect(personaRefusal('post', 'Week 3', 'What we shipped, and the number that moved')).toBeNull();
    // Only the user reads a spending request
    expect(personaRefusal('spend', 'A copy of Hacking Growth', 'For the team')).toBeNull();
  });

  it('is checked by code when an agent proposes a post, before anything is written', async () => {
    await productStore.save({ ...emptyProductProfile({ id: 'suture', name: 'Suture' }) });
    const result = await propose({
      workspaceId: 'suture',
      agentId: 'social',
      agentName: 'Social Manager',
      action: 'post',
      title: 'Building in public, week 3',
      body: "Hi, I'm Arvid Kahl. This week we shipped the fix loop.",
      target: 'x',
      why: "This week's experiment",
    });
    expect(result).toMatchObject({ state: 'refused', why: expect.stringMatching(/Never name the person/) });
    expect(await teamStore.forWorkspace('suture')).toHaveLength(0);
  });
});
