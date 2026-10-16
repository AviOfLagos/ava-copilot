import { beforeEach, describe, expect, it, vi } from 'vitest';

// base.ts reads globalThis.chrome when it is imported, so the mock must exist before the import
const data = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in values).map(k => [k, values[k]])),
        set: async (items: Record<string, unknown>) => Object.assign(values, items),
        onChanged: { addListener: () => undefined },
      },
    },
  });
  return values;
});

const { parseFrontmatter, parseSkill, skillId, skillToMarkdown, MAX_SKILL_CHARS } = await import('../parse');
const { builtinSkills, skillStore } = await import('../skills');

const ZEDU = `---
name: zedu-operator
description: "Running announcements on Zedu: channels, formats"
match:
  urls:
    - "*.zedu.chat/*"
    - zedu.app
  keywords: [zedu, "stage 2"]
---

# Zedu

- Announcements go in #general.
`;

describe('parseFrontmatter', () => {
  it('reads scalars, quoted values, inline lists, indented lists and nested mappings', () => {
    expect(
      parseFrontmatter(
        [
          'name: x',
          'description: "a: b"',
          'tags: [one, "two, three"]',
          '# a comment',
          'match:',
          '  urls:',
          '    - a.com/*',
          "    - 'b.com'",
          '  keywords: [k]',
        ].join('\n'),
      ),
    ).toEqual({
      name: 'x',
      description: 'a: b',
      tags: ['one', 'two, three'],
      match: { urls: ['a.com/*', 'b.com'], keywords: ['k'] },
    });
  });
});

describe('parseSkill', () => {
  it('reads a skill with nested match rules', () => {
    expect(parseSkill(ZEDU)).toEqual({
      name: 'zedu-operator',
      description: 'Running announcements on Zedu: channels, formats',
      urls: ['*.zedu.chat/*', 'zedu.app'],
      keywords: ['zedu', 'stage 2'],
      body: '# Zedu\n\n- Announcements go in #general.',
    });
  });

  it('accepts top-level rules, Windows line ends, and a name from the file', () => {
    const skill = parseSkill('---\r\ndescription: d\r\nurls: example.com\r\n---\r\nTip', 'My Site.md');
    expect(skill).toMatchObject({ name: 'My Site', urls: ['example.com'], keywords: [], body: 'Tip' });
    expect(skillId(skill.name)).toBe('my-site');
  });

  it('takes a file without frontmatter as a body called by its file name', () => {
    expect(parseSkill('Just tips.', 'notes.md')).toMatchObject({ name: 'notes', urls: [], body: 'Just tips.' });
  });

  it('refuses a skill without a name, without content, or too long', () => {
    expect(() => parseSkill('---\ndescription: d\n---\nTip')).toThrow(/needs a name/);
    expect(() => parseSkill('---\nname: empty\n---\n')).toThrow(/no content/);
    expect(() => parseSkill(`---\nname: big\n---\n${'x'.repeat(MAX_SKILL_CHARS + 1)}`)).toThrow(/too long/);
  });

  it('writes back what it reads', () => {
    const skill = parseSkill(ZEDU);
    expect(parseSkill(skillToMarkdown(skill))).toEqual(skill);
  });
});

describe('builtin skills', () => {
  it('ship account-switching, gmail, google-drive, google-forms, chat-apps and whatsapp-web, each with URL rules', () => {
    const skills = builtinSkills();
    expect(skills.map(skill => skill.id).sort()).toEqual([
      'account-switching',
      'chat-apps',
      'gmail',
      'google-drive',
      'google-forms',
      'whatsapp-web',
    ]);
    for (const skill of skills) {
      expect(skill.urls.length).toBeGreaterThan(0);
      expect(skill.body).toMatch(/confirmation/);
    }
  });
});

describe('skillStore', () => {
  beforeEach(() => {
    delete data.skills;
  });

  it('lists the built-in skills until the user adds their own', async () => {
    expect((await skillStore.all()).every(skill => skill.source === 'builtin')).toBe(true);
    const saved = await skillStore.save(ZEDU, 'imported', 'zedu-operator.md');
    expect(saved).toMatchObject({ id: 'zedu-operator', source: 'imported', enabled: true });
    expect((await skillStore.all())[0].id).toBe('zedu-operator');
  });

  it('replaces a skill saved again under the same name', async () => {
    await skillStore.save(ZEDU, 'imported');
    await skillStore.save(ZEDU.replace('#general', '#announcements'), 'written');
    const own = (await skillStore.all()).filter(skill => skill.id === 'zedu-operator');
    expect(own).toHaveLength(1);
    expect(own[0].body).toContain('#announcements');
  });

  it('turns skills off, built-in or not', async () => {
    await skillStore.save(ZEDU, 'imported');
    await skillStore.setEnabled('zedu-operator', false);
    await skillStore.setEnabled('gmail', false);
    const enabled = (await skillStore.enabled()).map(skill => skill.id);
    expect(enabled).not.toContain('zedu-operator');
    expect(enabled).not.toContain('gmail');
    await skillStore.setEnabled('gmail', true);
    expect((await skillStore.enabled()).map(skill => skill.id)).toContain('gmail');
  });

  it('lets a user skill replace a built-in one, which comes back when it is deleted', async () => {
    await skillStore.save('---\nname: gmail\n---\nMy own Gmail tips', 'written');
    const gmail = (await skillStore.all()).filter(skill => skill.id === 'gmail');
    expect(gmail).toEqual([expect.objectContaining({ source: 'written', body: 'My own Gmail tips' })]);
    await skillStore.remove('gmail');
    expect((await skillStore.all()).find(skill => skill.id === 'gmail')?.source).toBe('builtin');
  });
});
