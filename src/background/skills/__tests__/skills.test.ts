import { describe, expect, it } from 'vitest';
import { parseSkill } from '@extension/storage';
import type { SkillRecord } from '@extension/storage';
import {
  keywordMatches,
  matchSkills,
  MAX_INJECTED_CHARS,
  MAX_SKILLS,
  skillsSection,
  slashNames,
  urlMatches,
} from '../match';
import { draftToMarkdown, teachTranscript } from '../teach';

function skill(id: string, fields: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id,
    name: id,
    description: '',
    urls: [],
    keywords: [],
    body: `Tips for ${id}`,
    source: 'imported',
    enabled: true,
    updatedAt: 0,
    ...fields,
  };
}

describe('urlMatches', () => {
  it('matches host and path globs, with a leading *. covering the bare domain', () => {
    expect(urlMatches('mail.google.com/*', 'https://mail.google.com/mail/u/0/#inbox')).toBe(true);
    expect(urlMatches('mail.google.com/*', 'https://docs.google.com/forms/x')).toBe(false);
    expect(urlMatches('*.slack.com/*', 'https://acme.slack.com/archives/C1')).toBe(true);
    expect(urlMatches('*.slack.com/*', 'https://slack.com/intl')).toBe(true);
    expect(urlMatches('*.slack.com/*', 'https://notslack.com/x')).toBe(false);
    expect(urlMatches('docs.google.com/forms/*', 'https://docs.google.com/forms/d/e/abc/viewform?usp=sf')).toBe(true);
  });

  it('matches a bare domain and its subdomains, and ports in host patterns', () => {
    expect(urlMatches('zedu.app', 'https://zedu.app/')).toBe(true);
    expect(urlMatches('zedu.app', 'https://team.zedu.app/c/1')).toBe(true);
    expect(urlMatches('zedu.app', 'https://zedu.application.com/')).toBe(false);
    expect(urlMatches('127.0.0.1:*/fixture.html', 'http://127.0.0.1:5173/fixture.html?x=1')).toBe(true);
  });

  it('matches whole URLs when the pattern has a scheme, and never a bad URL', () => {
    expect(urlMatches('https://github.com/*/issues/*', 'https://github.com/acme/app/issues/4')).toBe(true);
    expect(urlMatches('https://github.com/*', 'http://github.com/acme')).toBe(false);
    expect(urlMatches('github.com', 'not a url')).toBe(false);
    expect(urlMatches('', 'https://github.com')).toBe(false);
  });
});

describe('keywordMatches and slashNames', () => {
  it('matches whole words and phrases, ignoring case', () => {
    expect(keywordMatches('zedu', 'Post the update on Zedu please')).toBe(true);
    expect(keywordMatches('zedu', 'zedusoft')).toBe(false);
    expect(keywordMatches('stage 2', 'What about Stage 2?')).toBe(true);
    expect(keywordMatches('c++', 'write c++ code')).toBe(true);
  });

  it('finds skills called by name', () => {
    expect(slashNames('/gmail reply to Ada, then /zedu-operator')).toEqual(['gmail', 'zedu-operator']);
    expect(slashNames('see https://x.com/gmail')).toEqual([]);
  });
});

describe('matchSkills', () => {
  const skills = [
    skill('gmail', { urls: ['mail.google.com/*'], keywords: ['gmail'] }),
    skill('zedu', { keywords: ['zedu'] }),
    skill('forms', { urls: ['docs.google.com/forms/*'] }),
    skill('notes'),
  ];

  it('loads what the task calls, then what the page matches, then keywords', () => {
    const matches = matchSkills(skills, { url: 'https://mail.google.com/mail', task: 'Tell Zedu people /notes' });
    expect(matches.map(match => [match.skill.id, match.reason])).toEqual([
      ['notes', 'slash'],
      ['gmail', 'url'],
      ['zedu', 'keyword'],
    ]);
  });

  it('loads nothing when nothing matches', () => {
    expect(matchSkills(skills, { url: 'https://example.com', task: 'book a table' })).toEqual([]);
  });

  it('loads at most three', () => {
    const many = Array.from({ length: 5 }, (_, i) => skill(`s${i}`, { keywords: ['deploy'] }));
    expect(matchSkills(many, { url: 'https://x.com', task: 'deploy it' })).toHaveLength(MAX_SKILLS);
  });
});

describe('skillsSection', () => {
  it('wraps each skill and keeps the confirmation rule', () => {
    const section = skillsSection([{ skill: skill('gmail'), reason: 'url' }]);
    expect(section).toContain('<skill name="gmail">\nTips for gmail\n</skill>');
    expect(section).toContain('still waits for the user');
    expect(skillsSection([])).toBe('');
  });

  it('cuts long skills to share the limit', () => {
    const long = skill('long', { body: 'x'.repeat(MAX_INJECTED_CHARS) });
    const section = skillsSection([
      { skill: long, reason: 'url' },
      { skill: skill('short'), reason: 'keyword' },
    ]);
    expect(section).toContain('[…cut for length]');
    expect(section.length).toBeLessThan(MAX_INJECTED_CHARS + 1000);
  });
});

describe('teach', () => {
  it('gives the model the requests, steps and pages, newest kept', () => {
    const text = teachTranscript(
      { title: 'Post in #general', boundUrl: 'https://app.zedu.app/c/general' },
      [
        { actor: 'user', content: 'Post hello in #general' },
        { actor: 'navigator', content: 'Clicking Send message' },
        { actor: 'planner', content: 'Posted.' },
      ],
      ['https://app.zedu.app/c/general', 'https://app.zedu.app/c/random'],
    );
    expect(text).toContain('Pages: https://app.zedu.app/c/general, https://app.zedu.app/c/random');
    expect(text).toContain('User: Post hello in #general\nStep: Clicking Send message\nPlanner: Posted.');

    const long = teachTranscript({ title: 't', boundUrl: null }, [{ actor: 'user', content: 'y'.repeat(40_000) }], []);
    expect(long).toContain('[…earlier steps cut]');
    expect(long).toContain('Pages: unknown');
  });

  it('turns a draft into a skill file that parses', () => {
    const markdown = draftToMarkdown({
      name: 'zedu-announcements',
      description: 'Posting announcements on Zedu',
      urls: ['app.zedu.app/*', ''],
      keywords: ['zedu', 'announcement'],
      tips: ['- The composer is at the bottom', 'Pick the channel from the sidebar', ' '],
    });
    expect(parseSkill(markdown)).toEqual({
      name: 'zedu-announcements',
      description: 'Posting announcements on Zedu',
      urls: ['app.zedu.app/*'],
      keywords: ['zedu', 'announcement'],
      body: '- The composer is at the bottom\n- Pick the channel from the sidebar',
    });
  });
});
