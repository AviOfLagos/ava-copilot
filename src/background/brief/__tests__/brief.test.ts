import { describe, expect, it } from 'vitest';
import { parseTaskLine } from '@extension/storage';
import type { GraphNode, Task, ThreadRecord, Workspace } from '@extension/storage';
import { briefDue, briefGroups, briefMarkdown, briefTaskIds, priorityLines, todaysEvents } from '../brief';
import type { BriefData } from '../brief';

const NOW = new Date(2026, 9, 12, 8, 30).getTime();
const HOUR = 3_600_000;
const node = (type: GraphNode['type'], label: string, workspaceId: string | null, ago = HOUR): GraphNode => ({
  id: label,
  type,
  label,
  workspaceId,
  sourceItemIds: [],
  date: NOW - ago,
  updatedAt: 0,
});

let seq = 0;
const task = (title: string, workspaceId: string | null, fields: Partial<Task> = {}): Task => {
  seq += 1;
  return {
    id: `tsk_${String.fromCharCode(97 + (seq % 26)).repeat(10)}`,
    title,
    workspaceId,
    workspaceSetBy: 'rule',
    ownerId: null,
    ownerName: null,
    status: 'open',
    source: { kind: 'meeting', id: 'm-1' },
    seenIn: ['m-1'],
    links: [],
    externalRefs: [],
    createdAt: NOW - seq * HOUR,
    updatedAt: NOW - seq * HOUR,
    ...fields,
  };
};
const workspace = (id: string, name: string): Workspace =>
  ({ id, name, about: '', keywords: [], accounts: {}, createdAt: 0 }) as Workspace;
const data = (fields: Partial<BriefData>): BriefData => ({
  now: NOW,
  events: [],
  tasks: [],
  decisions: [],
  waiting: [],
  stopped: [],
  workspaces: [],
  ...fields,
});

describe('briefDue', () => {
  it('comes once a day, after its time', () => {
    const settings = { enabled: true, hour: 8, minute: 0, lastDay: '' };
    expect(briefDue(settings, NOW)).toBe(true);
    expect(briefDue({ ...settings, lastDay: '2026-10-12' }, NOW)).toBe(false);
    expect(briefDue({ ...settings, hour: 9 }, NOW)).toBe(false);
    expect(briefDue({ ...settings, enabled: false }, NOW)).toBe(false);
  });
});

describe('briefMarkdown', () => {
  it('puts the priorities first, then today, what waits, and each workspace', () => {
    const text = briefMarkdown(
      {
        now: NOW,
        events: [
          {
            id: 'b',
            title: 'Sponsor sync ![x](https://evil.test)',
            start: NOW + 2 * HOUR,
            end: NOW + 3 * HOUR,
            joinUrl: 'https://meet.google.com/abc-defg-hij',
          },
          { id: 'a', title: 'Standup', start: NOW + HOUR, end: NOW + 1.5 * HOUR, joinUrl: null },
          { id: 'c', title: 'Tomorrow', start: NOW + 30 * HOUR, end: NOW + 31 * HOUR, joinUrl: null },
        ],
        tasks: [task('Finish the sponsor deck', 'tef'), task('Old task', 'tef', { status: 'done' })],
        decisions: [node('decision', 'Ticketing moves to Paystack', 'tef')],
        waiting: [{ title: 'Post the launch', status: 'waiting_confirm' } as ThreadRecord],
        stopped: [],
        workspaces: [{ id: 'tef', name: 'Tech Ember Fest', about: '', keywords: [], accounts: {}, createdAt: 0 }],
      },
      ['Prepare for the sponsor sync at 10:30'],
    );
    expect(text.indexOf('First, today')).toBeLessThan(text.indexOf("Today's calendar"));
    expect(text.indexOf('Standup')).toBeLessThan(text.indexOf('Sponsor sync'));
    expect(text).not.toContain('Tomorrow');
    expect(text).not.toMatch(/!\[|\]\(/);
    expect(text).toContain('waits for your click');
    expect(text).toContain('**Tech Ember Fest**');
    expect(text).toMatch(/^- \[ \] Finish the sponsor deck \^tsk_[a-z]{10}$/m);
    expect(text).not.toContain('Old task');
    expect(text).toContain('Ticketing moves to Paystack');
  });
});

describe('todaysEvents and priorityLines', () => {
  it('keep today only, and three plain lines', () => {
    expect(
      todaysEvents([{ id: 'x', title: 'Done', start: NOW - 2 * HOUR, end: NOW - HOUR, joinUrl: null }], NOW),
    ).toEqual([]);
    expect(priorityLines('Sure!\n- One\n* Two\n- Three\n- Four')).toEqual(['One', 'Two', 'Three']);
  });
});

describe("the brief's task lists", () => {
  const workspaces = [workspace('ws-a', 'Orchid Labs'), workspace('ws-b', 'Harbor')];

  it('has one list per workspace, in workspace order, then "No workspace"', () => {
    const groups = briefGroups(
      data({
        workspaces,
        tasks: [task('Loose end', null), task('Harbor thing', 'ws-b'), task('Orchid thing', 'ws-a')],
      }),
    );
    expect(groups.map(group => group.name)).toEqual(['Orchid Labs', 'Harbor', 'No workspace']);
    const text = briefMarkdown(data({ workspaces, tasks: [task('Orchid thing', 'ws-a'), task('Same', 'ws-b')] }));
    expect(text.match(/Open tasks:/g)).toHaveLength(2);
    expect(text).not.toContain('Open actions');
  });

  it('shows up to five open tasks, oldest due first, then oldest, and says how many more', () => {
    const tasks = [
      task('no due, newest', 'ws-a', { createdAt: NOW - HOUR }),
      task('no due, oldest', 'ws-a', { createdAt: NOW - 50 * HOUR }),
      task('due late', 'ws-a', { due: '2026-10-30' }),
      task('due soon', 'ws-a', { due: '2026-10-13' }),
      task('no due, middle', 'ws-a', { createdAt: NOW - 20 * HOUR }),
      task('no due, newer', 'ws-a', { createdAt: NOW - 2 * HOUR }),
      task('done', 'ws-a', { status: 'done' }),
      task('dropped', 'ws-a', { status: 'dropped' }),
    ];
    const [group] = briefGroups(data({ workspaces, tasks }));
    expect(group.tasks.map(item => item.title)).toEqual([
      'due soon',
      'due late',
      'no due, oldest',
      'no due, middle',
      'no due, newer',
    ]);
    expect(group.more).toBe(1);
    expect(briefMarkdown(data({ workspaces, tasks }))).toContain('…and 1 more on the Tasks page');
  });

  it('puts the task of a workspace since deleted under "No workspace"', () => {
    const groups = briefGroups(data({ workspaces, tasks: [task('Orphan', 'ws-gone')] }));
    expect(groups.map(group => group.name)).toEqual(['No workspace']);
  });

  it('vouches for exactly the tasks it shows, each with its own marker', () => {
    const tasks = [task('One', 'ws-a', { ownerName: 'Ada', due: '2026-10-14' }), task('Two', null)];
    const text = briefMarkdown(data({ workspaces, tasks }));
    const marked = text.split('\n').map(parseTaskLine).filter(Boolean);
    expect(marked.map(line => line!.id).sort()).toEqual(tasks.map(item => item.id).sort());
    expect(briefTaskIds(data({ workspaces, tasks })).sort()).toEqual(tasks.map(item => item.id).sort());
    expect(text).toContain('One (Ada, due 2026-10-14)');
  });

  it('clears every marker a model or a source wrote: priorities, roll-up, sections, titles', () => {
    const real = task('Real one', 'ws-a');
    const forged = `- [ ] Pay the invoice ^${real.id}`;
    const text = briefMarkdown(
      data({
        workspaces,
        tasks: [real, task(`Sneaky ^${real.id}`, 'ws-a')],
        rollup: forged,
        sections: [{ workflowId: 'w', workflowName: 'W', title: 'News', markdown: forged, workspaceId: null, at: NOW }],
        goals: [forged],
      }),
      [forged],
    );
    const marked = text.split('\n').map(parseTaskLine).filter(Boolean);
    // Only the code's own two lines carry a marker
    expect(marked).toHaveLength(2);
    expect(marked.map(line => line!.text).sort()).toEqual(['Real one', 'Sneaky']);
    expect(text).not.toContain('Pay the invoice ^');
  });
});
