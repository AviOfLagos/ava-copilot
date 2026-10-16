import { describe, expect, it, vi } from 'vitest';
import { parseSkill } from '@extension/storage';
import type { SkillRecord } from '@extension/storage';
import { enT } from './en';
import {
  keywordMatches,
  matchSkills,
  MAX_INJECTED_CHARS,
  MAX_SKILLS,
  skillsSection,
  slashNames,
  urlMatches,
} from '../match';
import { canTeachFrom, draftToMarkdown, teachTranscript } from '../teach';

vi.mock('@extension/i18n', () => ({ t: enT }));

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

    const long = teachTranscript({ title: 't', boundUrl: null }, [{ actor: 'user', content: 'y '.repeat(20_000) }], []);
    expect(long).toContain('[…earlier steps cut]');
    expect(long).toContain('Pages: unknown');
  });

  it('leaves out what the user typed or picked, and fences the log off as data', () => {
    const text = teachTranscript(
      { title: 'Fill the quote form for ada@example.com', boundUrl: 'https://app.example.com/quote?token=abc123' },
      [
        { actor: 'user', content: 'Fill name "Grace Hopper", phone +1 (555) 010-9999, password is hunter2' },
        { actor: 'navigator', content: 'Input Grace Hopper into index 4' },
        { actor: 'navigator', content: 'Selected option "Premium plan" from dropdown with index 7' },
        { actor: 'navigator', content: 'Sent keys: Control+V' },
        { actor: 'navigator', content: 'Opened https://app.example.com/quote?session=s3cret' },
        { actor: 'navigator', content: 'Pasted sk-live-abcdefghijklmnop' },
        { actor: 'planner', content: 'Done.' },
      ],
      [],
    );
    for (const secret of [
      'Grace Hopper',
      'ada@example.com',
      '555',
      'hunter2',
      'Premium plan',
      'Control+V',
      's3cret',
      'abc123',
      'sk-live',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('Step: Input [value] into index 4');
    expect(text).toContain('Step: Selected option [value] from dropdown with index 7');
    expect(text).toContain('Step: Sent keys: [value]\n');
    expect(text).toContain('Opened https://app.example.com/quote');
    expect(text).toContain('Pages: https://app.example.com/quote');
    expect(text).toContain('<nano_untrusted_content>');
  });

  it('is never offered or written for a chat an agent, routine or brief started', () => {
    const done = { status: 'idle' as const, error: null, meetingId: null };
    expect(canTeachFrom({ ...done, origin: 'user' })).toBe(true);
    expect(canTeachFrom({ ...done, origin: 'voice' })).toBe(true);
    for (const origin of ['agent', 'workflow', 'brief']) {
      expect(canTeachFrom({ ...done, origin })).toBe(false);
      expect(() => teachTranscript({ title: 't', boundUrl: null, origin }, [], [])).toThrow(/agent or a routine/);
    }
    expect(canTeachFrom({ ...done, status: 'error' })).toBe(false);
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
