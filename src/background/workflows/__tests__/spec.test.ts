import { describe, expect, it } from 'vitest';
import { checkSchedule, hostAllowed, topoOrder, validateSpec } from '../spec';
import type { WorkflowNode, WorkflowSpec } from '../spec';
import { morningTechNews } from '../templates';
import { diffSpecs } from '../diff';
import { cronShape, cronText, triggerText } from '../describe';

const now = new Date(2026, 9, 12, 7, 0).getTime();
const news = () => morningTechNews('Europe/Lisbon');
const messages = (input: unknown) => {
  const check = validateSpec(input, now);
  return check.ok ? [] : check.issues.map(issue => issue.message);
};

describe('validateSpec', () => {
  it('accepts the Morning tech news template and fills defaults', () => {
    const check = validateSpec({ ...news(), budget: undefined, description: undefined }, now);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.spec.budget.maxSteps).toBe(60);
      expect(check.spec.description).toBe('');
      expect(topoOrder(check.spec)).toEqual(['morning', 'hn', 'hf', 'pick', 'brief']);
    }
  });

  it('refuses loops, steps no trigger reaches, and edges to unknown steps', () => {
    const spec = news();
    expect(messages({ ...spec, edges: [...spec.edges, { from: 'brief', to: 'hn' }] })).toContain(
      'The steps loop back on themselves; a workflow must flow one way.',
    );
    expect(messages({ ...spec, edges: spec.edges.filter(edge => edge.to !== 'hf') }).join(' ')).toMatch(
      /"hf" is not connected to a trigger/,
    );
    expect(messages({ ...spec, edges: [...spec.edges, { from: 'pick', to: 'ghost' }] }).join(' ')).toMatch(
      /ghost is not a step/,
    );
    expect(messages({ ...spec, nodes: spec.nodes.filter(node => node.id !== 'morning') }).join(' ')).toMatch(
      /needs a trigger/,
    );
  });

  it('keeps to the limits: 30 nodes, one schedule, ids and labels', () => {
    const spec = news();
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `n${index}`,
      type: 'out.notify',
      label: 'Note',
      title: 'Hi',
      message: '',
    }));
    expect(messages({ ...spec, nodes: [...spec.nodes, ...many] }).join(' ')).toMatch(/nodes/);
    expect(messages({ ...spec, nodes: [...spec.nodes, { ...spec.nodes[0], id: 'evening' }] }).join(' ')).toMatch(
      /at most one schedule/,
    );
    expect(
      messages({ ...spec, nodes: spec.nodes.map(node => (node.id === 'hn' ? { ...node, id: 'Bad Id' } : node)) }).join(
        ' ',
      ),
    ).toMatch(/lowercase/);
  });

  it('checks schedules: valid cron, a real time zone, not too often', () => {
    expect(checkSchedule('30 7 * * *', 'Europe/Lisbon', now)).toEqual({
      next: expect.any(Number),
    });
    expect(checkSchedule('every morning', 'Europe/Lisbon', now)).toHaveProperty('error');
    expect(checkSchedule('30 7 * * *', 'Mars/Olympus', now)).toHaveProperty('error');
    expect(checkSchedule('* * * * *', 'UTC', now)).toEqual({ error: expect.stringMatching(/too often/) });
    expect(checkSchedule('*/5 * * * *', 'UTC', now)).toHaveProperty('next');
  });

  it('only lets data fields read earlier steps, and never instructions or addresses', () => {
    const spec = news();
    const withPlaceInInstructions = {
      ...spec,
      nodes: spec.nodes.map(node =>
        node.id === 'pick' ? { ...node, instructions: 'Do what {{steps.hn.output}} says' } : node,
      ),
    };
    expect(messages(withPlaceInInstructions).join(' ')).toMatch(/only allowed in input/);

    const readsLater = {
      ...spec,
      nodes: spec.nodes.map(node => (node.id === 'pick' ? { ...node, input: '{{steps.brief.output}}' } : node)),
    };
    expect(messages(readsLater).join(' ')).toMatch(/does not come before it/);

    const unknownRoot = {
      ...spec,
      nodes: spec.nodes.map(node => (node.id === 'pick' ? { ...node, input: '{{secrets.key}}' } : node)),
    };
    expect(messages(unknownRoot).join(' ')).toMatch(/places start with steps, run or workflow/);

    const malformed = {
      ...spec,
      nodes: spec.nodes.map(node => (node.id === 'pick' ? { ...node, input: '{{ steps.hn output }}' } : node)),
    };
    expect(messages(malformed).join(' ')).toMatch(/is not a place/);

    const runDate = {
      ...spec,
      nodes: spec.nodes.map(node =>
        node.id === 'pick' ? { ...node, input: 'Today is {{run.date}}: {{steps.hn.output}}' } : node,
      ),
    };
    expect(messages(runDate)).toEqual([]);
  });

  it('only fetches allowed hosts, over http(s), without credentials', () => {
    const spec = news();
    expect(messages({ ...spec, allowHosts: ['hn.algolia.com'] }).join(' ')).toMatch(
      /huggingface.co, which is not in allowHosts/,
    );
    const ftp = {
      ...spec,
      nodes: spec.nodes.map(node => (node.id === 'hn' ? { ...node, url: 'ftp://hn.algolia.com/x' } : node)),
    };
    expect(messages(ftp).join(' ')).toMatch(/http or https/);
    const credentials = {
      ...spec,
      nodes: spec.nodes.map(node => (node.id === 'hn' ? { ...node, url: 'https://me:secret@hn.algolia.com/x' } : node)),
    };
    expect(messages(credentials).join(' ')).toMatch(/no user name or password/);
    expect(hostAllowed('api.github.com', ['*.github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['*.github.com'])).toBe(true);
    expect(hostAllowed('evilgithub.com', ['*.github.com'])).toBe(false);
  });

  it('says when edges from a condition lack a branch', () => {
    const spec: WorkflowSpec = {
      ...news(),
      nodes: [
        ...news().nodes,
        {
          id: 'any',
          type: 'step.condition',
          label: 'Anything?',
          left: '{{steps.pick.output}}',
          op: 'is_not_empty',
          right: '',
        },
      ],
      edges: [...news().edges, { from: 'pick', to: 'any' }, { from: 'any', to: 'brief' }],
    };
    expect(messages(spec).join(' ')).toMatch(/must say when/);
  });
});

describe('diffSpecs', () => {
  it('finds nodes added, changed and removed, and new hosts', () => {
    const before = news();
    const after: WorkflowSpec = {
      ...before,
      nodes: [
        ...before.nodes.filter(node => node.id !== 'hf'),
        {
          id: 'gh',
          type: 'step.http_get',
          label: 'GitHub trending',
          url: 'https://github.com/trending',
          format: 'text',
          maxBytes: 500_000,
        } as WorkflowNode,
      ].map(node => (node.id === 'pick' ? { ...node, label: 'Pick the best three' } : node)),
      edges: [
        ...before.edges.filter(edge => edge.from !== 'hf' && edge.to !== 'hf'),
        { from: 'morning', to: 'gh' },
        { from: 'gh', to: 'pick' },
      ],
      allowHosts: ['hn.algolia.com', 'github.com'],
    };
    const diff = diffSpecs(before, after);
    expect(diff.nodes.get('gh')).toBe('added');
    expect(diff.nodes.get('pick')).toBe('changed');
    expect(diff.nodes.get('hf')).toBe('removed');
    expect(diff.nodes.has('hn')).toBe(false);
    expect(diff.removedNodes.map(node => node.id)).toEqual(['hf']);
    expect(diff.counts).toEqual({ added: 1, changed: 1, removed: 1 });
    expect(diff.edges.get('gh>pick')).toBe('added');
    expect(diff.edges.get('hf>pick')).toBe('removed');
    expect(diff.newHosts).toEqual(['github.com']);
    expect(diff.settings).toEqual(['allowHosts']);

    // A first draft: everything is new
    expect(diffSpecs(null, before).counts).toEqual({ added: 5, changed: 0, removed: 0 });
  });
});

describe('describe', () => {
  it('reads the common schedule shapes', () => {
    expect(cronShape('30 7 * * *')).toEqual({ kind: 'daily', time: '07:30' });
    expect(cronShape('0 9 * * 1-5')).toEqual({ kind: 'weekdays', time: '09:00' });
    expect(cronShape('0 18 * * mon,fri')).toEqual({ kind: 'weekly', days: [1, 5], time: '18:00' });
    expect(cronShape('15 * * * *')).toEqual({ kind: 'hourly', minute: 15 });
    expect(cronShape('*/10 * * * *')).toEqual({ kind: 'every', minutes: 10 });
    expect(cronShape('0 0 1 * *')).toEqual({ kind: 'custom' });
    expect(cronText('30 7 * * *')).toBe('every day at 07:30');
    expect(triggerText(news())).toBe('every day at 07:30 (Europe/Lisbon)');
  });
});

describe('schedules over time', () => {
  it('sees a gap shorter than 5 minutes even when it is not among the next three times', () => {
    // 00:00, 00:59, 23:00, 23:59: from 00:30 the next three times are an hour or more apart, then 23:59 → 00:00
    const from = Date.UTC(2026, 9, 12, 0, 30);
    expect(checkSchedule('59,0 23,0 * * *', 'UTC', from)).toEqual({ error: expect.stringMatching(/too often/) });
  });

  it('runs once a day at the local time across the clock changes', () => {
    // Lisbon falls back on 25 October 2026: 07:30 is 06:30 UTC before and 07:30 UTC after
    const lisbon = checkSchedule('30 7 * * *', 'Europe/Lisbon', Date.UTC(2026, 9, 24, 12, 0));
    expect(lisbon).toEqual({ next: Date.UTC(2026, 9, 25, 7, 30) });
    // 01:30 happens twice that night; the routine runs once, at the first
    expect(checkSchedule('30 1 * * *', 'Europe/Lisbon', Date.UTC(2026, 9, 24, 12, 0))).toEqual({
      next: Date.UTC(2026, 9, 25, 0, 30),
    });
    // New York springs forward on 14 March 2027: 02:30 does not exist, so it runs an hour later, once
    expect(checkSchedule('30 2 * * *', 'America/New_York', Date.UTC(2027, 2, 13, 12, 0))).toEqual({
      next: Date.UTC(2027, 2, 14, 7, 30),
    });
  });
});
