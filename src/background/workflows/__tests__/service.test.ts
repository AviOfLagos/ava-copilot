import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb } from '@extension/storage';
import type { JobRecord, WorkflowRecord } from '@extension/storage';
import { JobRunner } from '../../jobs/runner';
import { setServices } from '../../registry/services';
import type { Services } from '../../registry/services';
import { briefSectionsPending, sectionMarkdown, todaysBriefSections } from '../brief';
import { conditionFreeSpec } from './fixtures';
import { briefSectionExecutor } from '../executors';
import { WorkflowService } from '../service';
import type { StepExecutor } from '../engine';
import { meetingLinks, morningTechNews } from '../templates';
import { briefMarkdown } from '../../brief/brief';

// The model setup reaches the browser automation, which loads the extension polyfill
vi.mock('webextension-polyfill', () => ({ default: {} }));

let db: AviCopilotDb;
let runner: JobRunner;
let service: WorkflowService;
let executors: Record<string, StepExecutor>;
let briefCalls: string[];

beforeEach(() => {
  db = new AviCopilotDb(`workflow-service-${crypto.randomUUID()}`);
  runner = new JobRunner(db);
  briefCalls = [];
  executors = {
    'step.http_get': { retry: null, taints: true, execute: async () => ({ kind: 'done', output: { hits: ['a'] } }) },
    'step.llm': {
      retry: null,
      taints: false,
      usesModel: true,
      execute: async () => ({ kind: 'done', output: '- **Story** — why' }),
    },
    'out.brief_section': briefSectionExecutor(),
  };
  service = new WorkflowService(db, runner, type => executors[type]);
  setServices({
    brief: {
      addSection: async (section: { title: string }) => {
        briefCalls.push(`add:${section.title}`);
        return false;
      },
      check: async () => void briefCalls.push('check'),
    },
  } as unknown as Services);
});

const until = async (check: () => Promise<boolean>) => {
  for (let index = 0; index < 100; index++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('It never happened');
};

const jobOf = (workflow: WorkflowRecord) => db.jobs.where('key').equals(`workflow:${workflow.id}`).first();

describe('WorkflowService', () => {
  it('keeps a draft from running until the user creates it, then schedules it', async () => {
    const draft = await service.saveDraft({ spec: morningTechNews('Europe/Lisbon'), request: 'news in my brief' });
    expect(draft.status).toBe('draft');
    expect(draft.spec).toBeNull();
    await expect(service.start(draft.id, { trigger: { type: 'manual', detail: '' }, attended: true })).rejects.toThrow(
      /still a draft/,
    );
    expect(await jobOf(draft)).toBeUndefined();

    const created = await service.confirm(draft.id);
    expect(created).toMatchObject({ status: 'active', version: 1, draft: null });
    const job = await jobOf(created);
    expect(job).toMatchObject({ kind: 'workflow', cron: '30 7 * * *', timezone: 'Europe/Lisbon', status: 'scheduled' });
  });

  it('keeps a change as a draft beside the running version, diffed against it, until applied', async () => {
    const draft = await service.saveDraft({ spec: morningTechNews('UTC'), request: 'news' });
    await service.confirm(draft.id);
    const changed = { ...morningTechNews('UTC'), name: 'Morning news' };
    const pending = await service.saveDraft({ workflowId: draft.id, spec: changed, request: 'rename it' });
    expect(pending.status).toBe('active');
    expect(pending.draft?.baseSpec).toMatchObject({ name: 'Morning tech news' });
    expect((await db.workflows.get(draft.id))?.name).toBe('Morning tech news');
    const applied = await service.confirm(draft.id);
    expect(applied).toMatchObject({ name: 'Morning news', version: 2, draft: null });
  });

  it('feedback on a draft never created is diffed against the draft it replaces', async () => {
    const first = await service.saveDraft({ spec: morningTechNews('UTC'), request: 'news' });
    const second = await service.saveDraft({
      workflowId: first.id,
      spec: { ...morningTechNews('UTC'), description: 'v2' },
      request: 'more',
    });
    expect(second.draft?.baseSpec).toMatchObject({ description: morningTechNews('UTC').description });
    await service.discard(first.id);
    expect(await db.workflows.get(first.id)).toBeUndefined();
  });

  it('pauses and resumes: the schedule goes and comes back', async () => {
    const workflow = await service.confirm(
      (await service.saveDraft({ spec: morningTechNews('UTC'), request: 'x' })).id,
    );
    await service.setPaused(workflow.id, true);
    expect(await jobOf(workflow)).toBeUndefined();
    await service.setPaused(workflow.id, false);
    expect((await jobOf(workflow))?.status).toBe('scheduled');
  });

  it('runs a workflow by hand to the end, and hands its brief section to the brief', async () => {
    const workflow = await service.confirm((await service.saveDraft({ spec: conditionFreeSpec(), request: 'x' })).id);
    const run = await service.start(workflow.id, { trigger: { type: 'manual', detail: 'panel' }, attended: true });
    await until(async () => (await db.runs.get(run.id))?.status === 'succeeded');
    await until(async () => briefCalls.includes('check'));
    expect(briefCalls).toEqual(['add:Tech news', 'check']);
    await expect(
      service.start(workflow.id, { trigger: { type: 'manual', detail: '' }, attended: true }),
    ).resolves.toBeTruthy();

    const sections = await todaysBriefSections(db, Date.now());
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: 'Tech news', workflowName: 'Brief feeder' });
    expect(sectionMarkdown(sections[0])).toBe('**Tech news**\n- **Story** — why');
  });

  it('makes one run per scheduled firing, even when the job runs twice', async () => {
    const workflow = await service.confirm((await service.saveDraft({ spec: conditionFreeSpec(), request: 'x' })).id);
    const job = (await jobOf(workflow)) as JobRecord;
    const signal = new AbortController().signal;
    await Promise.all([service.fire(job, signal), service.fire(job, signal)]);
    await service.fire(job, signal);
    const runs = await db.runs.where('workflowId').equals(workflow.id).toArray();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ attended: false, status: 'succeeded', firingKey: `${workflow.id}@${job.runAt}` });
  });

  it('asks in the Inbox when an unattended run fails, and pauses after three in a row', async () => {
    executors['step.http_get'] = {
      retry: null,
      taints: true,
      execute: async () => {
        throw new Error('boom');
      },
    };
    const workflow = await service.confirm((await service.saveDraft({ spec: conditionFreeSpec(), request: 'x' })).id);
    for (let index = 0; index < 3; index++) {
      const job = (await jobOf(workflow)) ?? ({ runAt: index, payload: { workflowId: workflow.id } } as JobRecord);
      await service.fire({ ...job, runAt: job.runAt + index }, new AbortController().signal);
    }
    expect((await db.workflows.get(workflow.id))?.status).toBe('paused');
    expect(await jobOf(workflow)).toBeUndefined();
    const items = await db.inbox.toArray();
    expect(items.filter(item => item.kind === 'alert' && item.title.startsWith('Paused'))).toHaveLength(1);
    expect(items.filter(item => item.title.endsWith('failed'))).toHaveLength(3);
  });

  it('starts listening workflows on an event, tainted, and never on its own Inbox items', async () => {
    const spec = conditionFreeSpec();
    spec.nodes[0] = { id: 'start', type: 'trigger.event', label: 'Meeting ended', event: 'meeting_ended' };
    const workflow = await service.confirm((await service.saveDraft({ spec, request: 'x' })).id);
    expect(await service.fireEvent('meeting_ended', 'm1')).toBe(1);
    const [run] = await db.runs.where('workflowId').equals(workflow.id).toArray();
    expect(run).toMatchObject({
      tainted: true,
      attended: false,
      trigger: { type: 'event', detail: 'meeting_ended:m1' },
    });
    expect(await service.fireEvent('inbox_item', 'i1', `workflow:${workflow.id}`)).toBe(0);
  });

  it('deletes a workflow with its runs and schedule', async () => {
    const workflow = await service.confirm((await service.saveDraft({ spec: conditionFreeSpec(), request: 'x' })).id);
    const run = await service.start(workflow.id, { trigger: { type: 'manual', detail: '' }, attended: true });
    await until(async () => (await db.runs.get(run.id))?.status === 'succeeded');
    await service.remove(workflow.id);
    expect(await db.workflows.count()).toBe(0);
    expect(await db.runs.count()).toBe(0);
    expect(await db.runSteps.count()).toBe(0);
    expect(await jobOf(workflow)).toBeUndefined();
  });

  it('edits a node by hand: a new schedule is checked and takes effect', async () => {
    const workflow = await service.confirm(
      (await service.saveDraft({ spec: morningTechNews('UTC'), request: 'x' })).id,
    );
    await expect(service.editNode(workflow.id, 'morning', { cron: '* * * * *' })).rejects.toThrow(/too often/);
    const edited = await service.editNode(workflow.id, 'morning', { cron: '0 6 * * 1-5', label: 'Weekday mornings' });
    expect(edited.version).toBe(2);
    expect((await jobOf(workflow))?.cron).toBe('0 6 * * 1-5');
  });
});

describe('a run nobody answered', () => {
  const MEET_1 = 'https://meet.google.com/abc-defg-hij';
  const MEET_2 = 'https://meet.google.com/xyz-abcd-efg';
  const openRuns = async (workflowId: string) =>
    (await db.runs.where('workflowId').equals(workflowId).toArray()).sort((a, b) => a.startedAt - b.startedAt);

  it('gives way to the next meeting link, so an ignored offer never hides later meetings', async () => {
    executors['step.meeting_join'] = {
      retry: null,
      taints: false,
      execute: async () => ({ kind: 'done', output: {} }),
    };
    const workflow = await service.confirm((await service.saveDraft({ spec: meetingLinks(), request: 'x' })).id);
    const now = Date.now();
    expect(await service.fireTab(1, MEET_1, now)).toHaveLength(1);
    await until(async () => (await openRuns(workflow.id))[0]?.status === 'waiting_user');
    const [first] = await openRuns(workflow.id);
    const offer = (await db.inbox.toArray()).find(item => item.kind === 'approval');
    expect(offer?.status).toBe('unread');

    expect(await service.fireTab(2, MEET_2, now + 60_000)).toHaveLength(1);
    await until(async () => (await openRuns(workflow.id)).length === 2);
    await until(async () => (await openRuns(workflow.id))[1].status === 'waiting_user');
    const [replaced, current] = await openRuns(workflow.id);
    expect(replaced.id).toBe(first.id);
    expect(replaced).toMatchObject({ status: 'cancelled', error: { message: expect.stringMatching(/newer run/) } });
    expect(current.trigger.detail).toContain(MEET_2);
    // The old offer leaves the Inbox; the new one waits there
    expect((await db.inbox.get(offer!.id))?.status).toBe('done');
    expect(
      (await db.inbox.toArray()).filter(item => item.kind === 'approval' && item.status === 'unread'),
    ).toHaveLength(1);
  });

  it('gives way to the next scheduled time instead of skipping every time after it', async () => {
    executors['step.sandbox'] = { retry: null, taints: true, execute: async () => ({ kind: 'done', output: 'ok' }) };
    const spec = conditionFreeSpec();
    spec.nodes = [spec.nodes[0], { id: 'code', type: 'step.sandbox', label: 'Run the script', command: 'make' }];
    spec.edges = [{ from: 'start', to: 'code' }];
    const workflow = await service.confirm((await service.saveDraft({ spec, request: 'x' })).id);
    const job = (await jobOf(workflow)) as JobRecord;
    await service.fire(job, new AbortController().signal);
    expect((await openRuns(workflow.id))[0].status).toBe('waiting_user');
    await service.fire({ ...job, runAt: job.runAt + 86_400_000 }, new AbortController().signal);
    expect((await openRuns(workflow.id)).map(run => run.status)).toEqual(['cancelled', 'waiting_user']);
  });

  it('keeps a run whose browser task waits for a click in its chat: that is work under way', async () => {
    const spec = meetingLinks();
    spec.nodes = [
      spec.nodes[0],
      { id: 'look', type: 'step.browse', label: 'Look at the page', task: 'Read the agenda' },
    ];
    spec.edges = [{ from: spec.nodes[0].id, to: 'look' }];
    spec.nodes[0] = { ...spec.nodes[0], urlPattern: 'meet.google.com/*-*-*' } as (typeof spec.nodes)[0];
    executors['step.browse'] = {
      retry: null,
      taints: true,
      resumable: true,
      execute: async ({ saveState }) => {
        await saveState({ threadId: 't1' });
        return { kind: 'park', until: Date.now() + 60_000, waitingUser: true, state: { threadId: 't1' } };
      },
    };
    const workflow = await service.confirm((await service.saveDraft({ spec, request: 'x' })).id);
    await service.fireTab(1, MEET_1, Date.now());
    await until(async () => (await openRuns(workflow.id))[0]?.status === 'waiting_user');
    expect(await service.fireTab(2, MEET_2, Date.now() + 60_000)).toHaveLength(0);
    expect((await openRuns(workflow.id)).map(run => run.status)).toEqual(['waiting_user']);
  });
});

describe('the brief and workflows', () => {
  it('shows workflow sections in the brief, and waits for one that is running', async () => {
    const workflow = await service.confirm((await service.saveDraft({ spec: conditionFreeSpec(), request: 'x' })).id);
    expect(await briefSectionsPending(db, Date.now())).toBe(false);
    await db.runs.add({
      id: 'r-live',
      kind: 'workflow',
      workflowId: workflow.id,
      agentId: null,
      workspaceId: null,
      trigger: { type: 'schedule', detail: '' },
      status: 'running',
      tainted: false,
      startedAt: Date.now(),
      endedAt: null,
      leaseUntil: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: null,
    });
    expect(await briefSectionsPending(db, Date.now())).toBe(true);

    const markdown = briefMarkdown({
      now: Date.now(),
      events: [],
      actions: [],
      decisions: [],
      waiting: [],
      stopped: [],
      workspaces: [],
      sections: [
        {
          workflowId: workflow.id,
          workflowName: 'Brief feeder',
          title: 'Tech **news**',
          markdown: 'Read [this](https://example.com) ![pixel](https://evil.example/p.png) <img src=x>',
          workspaceId: null,
          at: Date.now(),
        },
      ],
    });
    expect(markdown).toContain('**Tech news**\nRead [this](https://example.com)');
    expect(markdown).not.toContain('evil.example');
    expect(markdown).not.toContain('<img');
  });
});
