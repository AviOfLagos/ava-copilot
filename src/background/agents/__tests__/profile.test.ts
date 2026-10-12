import { describe, expect, it } from 'vitest';
import { diffProfiles, fieldsOf, initialsOf, newAgentRecord, validateProfile } from '../profile';
import { AGENT_TEMPLATE_IDS, agentTemplate } from '../templates';
import { profile } from './fixtures';

const now = Date.UTC(2026, 9, 12, 9, 0);

const issuesOf = (input: unknown) => {
  const check = validateProfile(input, now);
  return check.ok ? [] : check.issues;
};

describe('validateProfile', () => {
  it('accepts a small agent and fills what was left out', () => {
    const check = validateProfile({ name: 'Ada helper', instructions: 'Check my inbox.' }, now);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.profile).toMatchObject({
      avatar: 'AH',
      modelRole: 'smart',
      executor: 'browser',
      triggers: [],
      budget: { dailyUsd: 1, maxStepsPerRun: 40, runsPerDay: 24 },
      inboxResults: true,
    });
  });

  it('puts sites, topics and triggers in their normal form', () => {
    const check = validateProfile(
      profile({
        domains: ['https://www.X.com/home', 'x.com', '*.linkedin.com'],
        triggers: [
          { type: 'tab', urlPattern: 'x.com/*' },
          { type: 'tab', urlPattern: 'x.com/*' },
          { type: 'topic', topic: 'Research.Brief' },
          { type: 'schedule', cron: '0 8 * * 1-5' },
        ],
        subscribes: ['social.*'],
        publishes: ['Digest.Daily'],
        startUrl: 'https://x.com/home',
      }),
      now,
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.profile.domains).toEqual(['x.com', '*.linkedin.com']);
    expect(check.profile.triggers).toHaveLength(4);
    expect(check.profile.triggers).toContainEqual({ type: 'topic', topic: 'research.brief' });
    expect(check.profile.triggers).toContainEqual({ type: 'topic', topic: 'social.*' });
    expect(check.profile.subscribes.sort()).toEqual(['research.brief', 'social.*']);
    expect(check.profile.publishes).toEqual(['digest.daily']);
    const schedule = check.profile.triggers.find(trigger => trigger.type === 'schedule');
    expect(schedule && schedule.type === 'schedule' && schedule.timezone).toBeTruthy();
  });

  it('says what is wrong in plain sentences', () => {
    expect(issuesOf(profile({ name: '' })).join(' ')).toMatch(/The name/);
    expect(issuesOf(profile({ triggers: [{ type: 'schedule', cron: '* * * * *' }] })).join(' ')).toMatch(/too often/);
    expect(issuesOf(profile({ triggers: [{ type: 'schedule', cron: 'every day at 7' }] })).join(' ')).toMatch(
      /not a schedule/,
    );
    expect(issuesOf(profile({ triggers: [{ type: 'tab', urlPattern: '*' }] })).join(' ')).toMatch(/every site/);
    expect(issuesOf(profile({ domains: ['x.com'], startUrl: 'https://y.com/' })).join(' ')).toMatch(
      /not one of its sites/,
    );
    expect(issuesOf(profile({ startUrl: 'javascript:alert(1)' })).join(' ')).toMatch(/http or https/);
    expect(issuesOf(profile({ domains: ['not a host'] })).join(' ')).toMatch(/not a site/);
    expect(issuesOf(profile({ executor: 'companion' })).join(' ')).toMatch(/companion/);
  });

  it('refuses an agent that would set itself off through the bus', () => {
    expect(issuesOf(profile({ subscribes: ['news.*'], publishes: ['news.daily'] })).join(' ')).toMatch(
      /set itself off/,
    );
    expect(issuesOf(profile({ subscribes: ['a.b'], publishes: ['a.b'] })).join(' ')).toMatch(/set itself off/);
    expect(issuesOf(profile({ subscribes: ['a.b'], publishes: ['c.d'] }))).toEqual([]);
  });

  it('accepts every template as it is', () => {
    for (const id of AGENT_TEMPLATE_IDS) expect(issuesOf(agentTemplate(id, 'Europe/Lisbon'))).toEqual([]);
  });
});

describe('drafts and diffs', () => {
  it('makes a new agent that only holds a draft', () => {
    const agent = newAgentRecord(profile(), 'make me a scout');
    expect(agent.status).toBe('draft');
    expect(agent.draft).toMatchObject({ base: null, request: 'make me a scout' });
    expect(agent.version).toBe(0);
  });

  it('lists every field of a new agent, and only what changed otherwise', () => {
    const base = profile();
    expect(diffProfiles(null, base).map(change => change.field)).toEqual(
      expect.arrayContaining(['name', 'instructions', 'triggers', 'budget']),
    );
    const next = { ...fieldsOf(base), domains: ['x.com'], triggers: [{ type: 'tab' as const, urlPattern: 'x.com/*' }] };
    const changes = diffProfiles(base, next);
    expect(changes.map(change => change.field).sort()).toEqual(['domains', 'triggers']);
    expect(changes.find(change => change.field === 'triggers')).toMatchObject({
      before: 'when asked',
      after: 'when a page matching "x.com/*" opens or changes',
    });
  });

  it('makes initials for an agent with no emoji', () => {
    expect(initialsOf('research scout bot')).toBe('RS');
    expect(initialsOf('  ')).toBe('A');
  });
});
