import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, createThreadStore } from '@extension/storage';
import type { ThreadStore } from '@extension/storage';
import { Actors, AgentEvent, ExecutionState } from '../../agent/event/types';
import type { EventCallback } from '../../agent/event/types';
import type * as StorageModule from '@extension/storage';

// --- fakes -------------------------------------------------------------------------------------

const settings = { maxConcurrentThreads: 2 };
vi.mock('@extension/storage', async original => ({
  ...(await original<typeof StorageModule>()),
  generalSettingsStore: { getSettings: async () => settings },
}));

class FakeExecutor {
  static created: FakeExecutor[] = [];
  listeners: EventCallback[] = [];
  tasks: string[];
  answers: [string, boolean][] = [];
  cancelled = false;
  private finish!: () => void;
  private running: Promise<void> | null = null;

  constructor(public options: { threadId: string; task: string; messageContext?: string }) {
    this.tasks = [options.task];
    FakeExecutor.created.push(this);
  }
  get currentTask() {
    return this.tasks[this.tasks.length - 1];
  }
  subscribeExecutionEvents(callback: EventCallback) {
    this.listeners.push(callback);
  }
  clearExecutionEvents() {
    this.listeners = [];
  }
  async emit(actor: Actors, state: ExecutionState, details = '') {
    const event = new AgentEvent(actor, state, { taskId: this.options.threadId, step: 0, maxSteps: 10, details });
    for (const listener of this.listeners) await listener(event);
  }
  execute() {
    this.running = new Promise<void>(resolve => (this.finish = resolve));
    return this.running;
  }
  /** Ends the run the way a successful task does. */
  async complete(answer = 'All done.') {
    await this.emit(Actors.PLANNER, ExecutionState.STEP_OK, answer);
    await this.emit(Actors.SYSTEM, ExecutionState.TASK_OK, answer);
    this.finish();
  }
  async cancel() {
    this.cancelled = true;
    await this.emit(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled');
    this.finish();
  }
  answerConfirmation(requestId: string, approved: boolean) {
    this.answers.push([requestId, approved]);
    return true;
  }
  addFollowUpTask(task: string) {
    this.tasks.push(task);
  }
  notify() {}
  async cleanup() {}
}

vi.mock('../factory', () => ({
  resolveModels: vi.fn(async () => ({ navigator: {}, planner: {} })),
  createBrowserContext: vi.fn(async () => ({ removeAttachedPage: vi.fn(), setBinding: vi.fn() })),
  createExecutor: vi.fn(
    async (options: { threadId: string; task: string; messageContext?: string }) => new FakeExecutor(options),
  ),
}));

// A browser with one window; tests open tabs and pick the active one
const browser = {
  tabs: new Map<number, { id: number; url: string; title: string; active: boolean; groupId: number }>(),
  nextId: 1,
  open(url: string) {
    const id = this.nextId++;
    for (const tab of this.tabs.values()) tab.active = false;
    this.tabs.set(id, { id, url, title: url, active: true, groupId: -1 });
    return id;
  },
  activate(id: number) {
    for (const tab of this.tabs.values()) tab.active = tab.id === id;
  },
};

function installChrome() {
  const tabs = browser.tabs;
  vi.stubGlobal('chrome', {
    i18n: { getMessage: (key: string, subs?: string | string[]) => [key, ...[subs ?? []].flat()].join(':') },
    runtime: { getPlatformInfo: async () => ({}) },
    tabGroups: { TAB_GROUP_ID_NONE: -1, update: async () => ({}) },
    windows: {
      get: async (id: number) => ({ id, type: 'normal' }),
      getLastFocused: async () => ({ id: 1, type: 'normal' }),
    },
    tabs: {
      get: async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return tab;
      },
      query: async (q: { active?: boolean; highlighted?: boolean; groupId?: number }) =>
        [...tabs.values()].filter(tab =>
          q.active || q.highlighted ? tab.active : q.groupId === undefined || tab.groupId === q.groupId,
        ),
      group: async () => 9,
      create: async ({ url }: { url: string }) => tabs.get(browser.open(url)),
    },
  });
}

// --- tests -------------------------------------------------------------------------------------

const { ThreadManager } = await import('../manager');

let db: AviCopilotDb;
let store: ThreadStore;
let manager: InstanceType<typeof ThreadManager>;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const lastExecutor = () => FakeExecutor.created[FakeExecutor.created.length - 1];

beforeEach(() => {
  browser.tabs.clear();
  browser.nextId = 1;
  FakeExecutor.created = [];
  settings.maxConcurrentThreads = 2;
  installChrome();
  db = new AviCopilotDb(`test-${crypto.randomUUID()}`);
  store = createThreadStore(db);
  manager = new ThreadManager(store);
});

afterEach(async () => {
  await manager.cancelAll();
  await settle();
  await db.delete();
  vi.unstubAllGlobals();
});

describe('ThreadManager', () => {
  it('starts a thread on the active tab and records the run', async () => {
    const tabId = browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'Post the standup note', windowId: 1 });

    let thread = await store.get(threadId);
    expect(thread?.status).toBe('running');
    expect(thread?.boundTabIds).toEqual([tabId]);
    expect(thread?.title).toBe('Post the standup note');
    expect(thread?.activeTask).toBe('Post the standup note');

    await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.STEP_START);
    expect((await store.get(threadId))?.activity).toBe('navigating');

    await lastExecutor().complete('Posted in #general.');
    await settle();
    thread = await store.get(threadId);
    expect(thread?.status).toBe('idle');
    expect(thread?.activity).toBe('');
    expect(thread?.activeTask).toBeNull();
    expect((await store.messages(threadId)).map(m => [m.actor, m.content])).toEqual([
      ['user', 'Post the standup note'],
      // A chat whose words name no workspace goes to the default one, and says so
      ['system', 'workspace_placed:Nexprove'],
      ['planner', 'Posted in #general.'],
    ]);
  });

  it('runs threads at the same time, up to the limit', async () => {
    browser.open('https://a.example');
    await manager.send({ text: 'task a' });
    browser.open('https://b.example');
    await manager.send({ text: 'task b' });
    expect(manager.runningCount).toBe(2);

    browser.open('https://c.example');
    await expect(manager.send({ text: 'task c' })).rejects.toThrow('threads_tooMany:2');
  });

  it('refuses a tab that another running thread holds', async () => {
    browser.open('https://chat.example');
    const first = await manager.send({ text: 'Post the note' });
    await expect(manager.send({ text: 'Read the chat' })).rejects.toThrow('threads_tabInUse:Post the note');
    expect(manager.holderOf(1)).toBe(first);
  });

  it('refuses a second message while the thread runs', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'one' });
    await expect(manager.send({ threadId, text: 'two' })).rejects.toThrow('threads_busy');
  });

  it('keeps a confirmation request on the thread until the user answers', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'Post it' });
    const request = {
      id: 'r1',
      taskId: threadId,
      mode: 'commit',
      kind: 'send',
      intent: 'Send',
      target: 'Send message',
    };
    await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(request));

    let thread = await store.get(threadId);
    expect(thread?.status).toBe('waiting_confirm');
    expect(thread?.pendingRequest?.id).toBe('r1');

    expect(await manager.answer(threadId, 'other', true)).toBe(false);
    expect(await manager.answer(threadId, 'r1', true)).toBe(true);
    expect(lastExecutor().answers).toEqual([['r1', true]]);
    thread = await store.get(threadId);
    expect(thread?.status).toBe('running');
    expect(thread?.pendingRequest).toBeNull();
    expect((await store.messages(threadId)).map(m => m.content)).toContain('gate_approved:Send message');
  });

  it('stops a run whose tab closes, and keeps where it was', async () => {
    const tabId = browser.open('https://form.example/quote');
    const threadId = await manager.send({ text: 'Fill the form' });
    browser.tabs.delete(tabId);
    await manager.onTabRemoved(tabId);
    await settle();

    const thread = await store.get(threadId);
    expect(thread?.status).toBe('error');
    expect(thread?.error?.kind).toBe('tab_closed');
    expect(thread?.boundUrl).toBe('https://form.example/quote');
    expect(thread?.activeTask).toBe('Fill the form');
  });

  it('reopens the page of a closed tab and continues', async () => {
    const tabId = browser.open('https://form.example/quote');
    const threadId = await manager.send({ text: 'Fill the form' });
    browser.tabs.delete(tabId);
    await manager.onTabRemoved(tabId);
    await settle();

    await manager.continueThread(threadId);
    const thread = await store.get(threadId);
    expect(thread?.status).toBe('running');
    expect(thread?.boundTabIds).toHaveLength(1);
    expect(browser.tabs.get(thread!.boundTabIds[0])?.url).toBe('https://form.example/quote');
    expect(lastExecutor().options.task).toBe('Fill the form');
    expect(lastExecutor().options.messageContext).toContain('interrupted and is now resumed');
  });

  it('continues a finished thread with the executor that still holds its history', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'Find the standup time' });
    await lastExecutor().complete('10am.');
    await settle();

    await manager.send({ threadId, text: 'Now post it' });
    expect(FakeExecutor.created).toHaveLength(1);
    expect(lastExecutor().tasks).toEqual(['Find the standup time', 'Now post it']);
  });

  it('retries the last task from the start with a fresh agent', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'Find the standup time' });
    await lastExecutor().complete('Not found.');
    await settle();

    await manager.retry(threadId);
    expect(FakeExecutor.created).toHaveLength(2);
    expect(lastExecutor().tasks).toEqual(['Find the standup time']);
    const notes = (await store.messages(threadId)).filter(message => message.actor === 'system');
    expect(notes.at(-1)?.content).toContain('threads_retried');
  });

  it('starts an old thread with its conversation as context when nothing is in memory', async () => {
    browser.open('https://chat.example');
    const thread = await store.create({ title: 'Standup' });
    await store.addMessage(thread.id, 'user', 'Find the standup time');
    await store.addMessage(thread.id, 'planner', 'It is at 10am.');

    await manager.send({ threadId: thread.id, text: 'Now post it' });
    const context = lastExecutor().options.messageContext ?? '';
    expect(context).toContain('User: Find the standup time');
    expect(context).toContain('Assistant: It is at 10am.');
    expect(context).not.toContain('Now post it');
  });

  it('resumes a run interrupted a moment ago, and marks an older one interrupted', async () => {
    const tabId = browser.open('https://chat.example');
    const recent = await store.create({
      status: 'running',
      activeTask: 'Post the note',
      runStartedAt: Date.now() - 1000,
      boundTabIds: [tabId],
    });
    const old = await store.create({
      status: 'waiting_confirm',
      activeTask: 'Send the email',
      runStartedAt: Date.now() - 60 * 60 * 1000,
      boundTabIds: [tabId],
    });

    await manager.recover();

    expect((await store.get(recent.id))?.status).toBe('running');
    expect(lastExecutor().options.task).toBe('Post the note');
    expect((await store.messages(recent.id)).map(m => m.content)).toEqual(['threads_resumed']);
    const interrupted = await store.get(old.id);
    expect(interrupted?.status).toBe('error');
    expect(interrupted?.error?.kind).toBe('interrupted');
    expect(interrupted?.pendingRequest).toBeNull();
  });

  it('deletes a running thread after stopping it', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'task' });
    await manager.remove(threadId);
    expect(lastExecutor().cancelled).toBe(true);
    expect(await store.get(threadId)).toBeUndefined();
    expect(manager.isRunning(threadId)).toBe(false);
  });
});
