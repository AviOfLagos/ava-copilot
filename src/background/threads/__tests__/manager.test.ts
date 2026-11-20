import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AviCopilotDb, createThreadStore, onceStore } from '@extension/storage';
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

  constructor(public options: { threadId: string; task: string; messageContext?: string; browserContext?: unknown }) {
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
    // Like the real gate: a refusal stops the task, which ends at once and reports without waiting
    if (!approved && this.stopOnDecline) {
      this.cancelled = true;
      void this.emit(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled');
      this.finish();
    }
    return true;
  }
  stopOnDecline = false;
  // Ends the run without reporting first, the way the real executor returns while its last event is still recorded
  endAbruptly() {
    void this.emit(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled');
    this.finish();
  }
  addFollowUpTask(task: string) {
    this.tasks.push(task);
  }
  // What the executor knows about why it failed (src/background/retry/classify.ts)
  failureCode: string | null = null;
  /** Ends the run the way a failed task does. */
  async fail(message: string, code: string | null = 'max_failures') {
    this.failureCode = code;
    await this.emit(Actors.SYSTEM, ExecutionState.TASK_FAIL, message);
    this.finish();
  }
  // Whether the task typed into a field or clicked a submit in its last steps, and what the model is told next
  midForm = false;
  notes: string[] = [];
  paused = false;
  // Every hold and release, in order
  holds: string[] = [];
  isMidForm() {
    return this.midForm;
  }
  async pause() {
    this.paused = true;
    this.holds.push('pause');
  }
  async resume() {
    this.paused = false;
    this.holds.push('resume');
  }
  resumeOnFreshPage(note: string) {
    this.notes.push(note);
    this.paused = false;
    this.holds.push('fresh');
  }
  notify() {}
  async cleanup() {}
}

vi.mock('../factory', () => ({
  resolveModels: vi.fn(async () => ({ navigator: {}, planner: {} })),
  createBrowserContext: vi.fn(async (binding: unknown) => {
    const context = {
      // The run's own binding, so a test can let a tab join it the way the agent does
      binding: binding as { add(tabId: number): void },
      currentTabId: null as number | null,
      // Tabs the task closed itself, and the sites it may not open
      closed: new Set<number>(),
      denied: [] as string[],
      closedByTask: (tabId: number) => context.closed.has(tabId),
      getConfig: () => ({ allowedUrls: [], deniedUrls: context.denied }),
      removeAttachedPage: vi.fn(),
      setBinding: vi.fn(),
      updateCurrentTabId: vi.fn((tabId: number) => {
        context.currentTabId = tabId;
      }),
    };
    return context;
  }),
  createExecutor: vi.fn(
    async (options: { threadId: string; task: string; messageContext?: string; browserContext?: unknown }) =>
      new FakeExecutor(options),
  ),
}));

// A browser with one window; tests open tabs and pick the active one
const browser = {
  tabs: new Map<
    number,
    { id: number; url: string; title: string; active: boolean; groupId: number; windowId: number; status: string }
  >(),
  // New tabs stay "loading" until a test says otherwise
  slowLoad: false,
  // The windows that are open; a tab opens in window 1 unless told otherwise
  windows: new Set<number>([1]),
  nextId: 1,
  open(url: string, windowId = 1, active = true) {
    const id = this.nextId++;
    if (active) for (const tab of this.tabs.values()) tab.active = false;
    this.tabs.set(id, {
      id,
      url,
      title: url,
      active,
      groupId: -1,
      windowId,
      status: this.slowLoad ? 'loading' : 'complete',
    });
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
      get: async (id: number) => {
        if (!browser.windows.has(id)) throw new Error(`No window with id: ${id}`);
        return { id, type: 'normal' };
      },
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
      create: async ({ url, windowId, active }: { url: string; windowId?: number; active?: boolean }) =>
        tabs.get(browser.open(url, windowId ?? 1, active ?? true)),
      remove: async (id: number) => {
        tabs.delete(id);
      },
    },
  });
}

// --- tests -------------------------------------------------------------------------------------

const { ThreadManager } = await import('../manager');
const { RunEndings, retryJobKey } = await import('../../retry/endings');
import type { RetryPayload } from '../../retry/endings';
import type { InboxItem } from '@extension/storage';

let db: AviCopilotDb;
let store: ThreadStore;
let manager: InstanceType<typeof ThreadManager>;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
// The fake browser context a run was given (see the factory mock above)
const contextOf = (executor: FakeExecutor) =>
  (
    executor.options as unknown as {
      browserContext: { closed: Set<number>; denied: string[]; binding: { add(tabId: number): void } };
    }
  ).browserContext;
const lastExecutor = () => FakeExecutor.created[FakeExecutor.created.length - 1];

beforeEach(() => {
  browser.tabs.clear();
  browser.windows = new Set([1]);
  browser.slowLoad = false;
  browser.nextId = 1;
  FakeExecutor.created = [];
  settings.maxConcurrentThreads = 2;
  installChrome();
  db = new AviCopilotDb(`test-${crypto.randomUUID()}`);
  store = createThreadStore(db);
  manager = new ThreadManager(store);
  // This suite names the seeded default workspace ("Nexprove") below; everyone else's build seeds a
  // single neutral workspace instead (src/storage/lib/workspaces/workspaces.ts), so pin the profile
  // this suite was written against rather than coupling the assertion to whichever is the default.
  vi.stubEnv('VITE_SEED_PROFILE', 'avi');
});

afterEach(async () => {
  await manager.cancelAll();
  await settle();
  await db.delete();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it('puts a chat whose picked workspace was deleted in the default one', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'Check the inbox', windowId: 1, workspaceId: 'deleted-ws' });
    await settle();
    expect((await store.messages(threadId)).map(m => [m.actor, m.content])).toContainEqual([
      'system',
      'workspace_placed:Nexprove',
    ]);
    await lastExecutor().complete('Done.');
    await settle();
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

  it('stops a run whose tab closes in the middle of a form, and keeps where it was', async () => {
    const tabId = browser.open('https://form.example/quote');
    const threadId = await manager.send({ text: 'Fill the form' });
    // A field was typed into in the last steps: a fresh page would not hold it
    lastExecutor().midForm = true;
    browser.tabs.delete(tabId);
    await manager.onTabRemoved(tabId);
    await settle();

    const thread = await store.get(threadId);
    expect(thread?.status).toBe('error');
    expect(thread?.error?.kind).toBe('tab_closed');
    expect(thread?.boundUrl).toBe('https://form.example/quote');
    expect(thread?.activeTask).toBe('Fill the form');
    // Nothing was opened again: the retry starts by checking what already happened
    expect(browser.tabs.size).toBe(0);
    expect(lastExecutor().notes).toEqual([]);
  });

  it('reopens the page of a closed tab and continues', async () => {
    const tabId = browser.open('https://form.example/quote');
    const threadId = await manager.send({ text: 'Fill the form' });
    lastExecutor().midForm = true;
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

  describe('a closed tab does not end the task (#65)', () => {
    const close = async (tabId: number) => {
      browser.tabs.delete(tabId);
      await manager.onTabRemoved(tabId);
      await settle();
    };

    it('reopens the tab on its last page while the task is reading, tells the model, and finishes', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      const executor = lastExecutor();
      // The task moved on from the page it started on
      browser.tabs.get(tabId)!.url = 'https://news.example/story/42';
      await manager.onTabUpdated(tabId, browser.tabs.get(tabId)!);
      expect((await store.get(threadId))?.boundUrl).toBe('https://news.example/story/42');

      await close(tabId);

      const thread = await store.get(threadId);
      expect(thread?.status).toBe('running');
      expect(thread?.error).toBeNull();
      expect(thread?.boundTabIds).toHaveLength(1);
      const reopened = browser.tabs.get(thread!.boundTabIds[0]);
      expect(reopened?.url).toBe('https://news.example/story/42');
      expect(reopened?.windowId).toBe(1);
      expect(executor.cancelled).toBe(false);
      // The task was held while its page came back, so no step ran (and failed) on the dead tab
      expect(executor.holds[0]).toBe('pause');
      expect(executor.holds).toContain('fresh');
      expect(executor.paused).toBe(false);
      expect(executor.notes).toEqual([
        'The tab was closed and reopened at https://news.example/story/42. It is a fresh page: check you are signed in and where you are before continuing.',
      ]);
      expect((await store.messages(threadId)).at(-1)?.content).toBe('threads_tabReopened:news.example');

      // The same executor carries on in the new tab and the task finishes
      await executor.complete('The top story is about tabs.');
      await settle();
      expect(FakeExecutor.created).toHaveLength(1);
      expect((await store.get(threadId))?.status).toBe('idle');
    });

    it('handles one closed tab once, whichever of the two reports comes first', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      browser.tabs.delete(tabId);
      // Chrome says it twice: the debugger lost its target, and the tab was removed
      await Promise.all([manager.onDebuggerDetached(tabId, 'target_closed'), manager.onTabRemoved(tabId)]);
      await manager.onTabRemoved(tabId);
      await settle();

      expect(browser.tabs.size).toBe(1);
      expect(lastExecutor().notes).toHaveLength(1);
      expect((await store.get(threadId))?.status).toBe('running');
      const notes = (await store.messages(threadId)).filter(message => message.content.startsWith('threads_tab'));
      expect(notes).toHaveLength(1);
    });

    it('leaves a tab alone when the debugger lost its target but the tab is still there', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      await manager.onDebuggerDetached(tabId, 'target_closed');
      await settle();
      expect(browser.tabs.size).toBe(1);
      expect((await store.get(threadId))?.boundTabIds).toEqual([tabId]);
      expect(lastExecutor().notes).toEqual([]);
      // It can still be closed for real later
      await close(tabId);
      expect(lastExecutor().notes).toHaveLength(1);
    });

    it('reopens once per run: a second close ends the run as tab_closed', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      await close(tabId);
      const second = (await store.get(threadId))!.boundTabIds[0];
      await close(second);

      const thread = await store.get(threadId);
      expect(thread?.status).toBe('error');
      expect(thread?.error?.kind).toBe('tab_closed');
      expect(browser.tabs.size).toBe(0);
    });

    it('does not reopen while a send waits for the click: the page held what the card shows', async () => {
      const tabId = browser.open('https://mail.example/compose');
      const threadId = await manager.send({ text: 'Send the reply' });
      const request = { id: 'r1', taskId: threadId, mode: 'commit', kind: 'send', target: 'Send', intent: '' };
      await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(request));
      expect((await store.get(threadId))?.status).toBe('waiting_confirm');
      await close(tabId);
      expect((await store.get(threadId))?.error?.kind).toBe('tab_closed');
      expect(browser.tabs.size).toBe(0);
    });

    it('opens the tab in the last focused window, in the background, when its window closed too', async () => {
      browser.windows.add(7);
      browser.open('https://other.example/');
      const tabId = browser.open('https://news.example/', 7);
      const threadId = await manager.send({ text: 'Summarise the top story' });
      expect((await store.get(threadId))?.boundTabIds).toEqual([tabId]);
      browser.windows.delete(7);
      await close(tabId);

      const reopened = browser.tabs.get((await store.get(threadId))!.boundTabIds[0]);
      expect(reopened).toMatchObject({ url: 'https://news.example/', windowId: 1, active: false });
    });

    it('leaves a tab closed that the task closed itself', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Read it, then close the tab' });
      contextOf(lastExecutor()).closed.add(tabId);
      await close(tabId);
      expect(browser.tabs.size).toBe(0);
      expect((await store.get(threadId))?.error?.kind).toBe('tab_closed');
    });

    it('does not bring back a page the task may not open', async () => {
      const tabId = browser.open('https://blocked.example/page');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      contextOf(lastExecutor()).denied.push('blocked.example');
      await close(tabId);
      expect(browser.tabs.size).toBe(0);
      expect((await store.get(threadId))?.error?.kind).toBe('tab_closed');
    });

    it('brings back the page of a tab that joined the task later, not the page it started on', async () => {
      const first = browser.open('https://a.example/start');
      const threadId = await manager.send({ text: 'Follow the link and read it' });
      // The task opens a second tab, then the first one closes: it goes on in the second
      const second = browser.open('https://b.example/article');
      contextOf(lastExecutor()).binding.add(second);
      await settle();
      await close(first);
      expect((await store.get(threadId))?.status).toBe('running');

      await close(second);
      const thread = await store.get(threadId);
      expect(thread?.status).toBe('running');
      expect(browser.tabs.get(thread!.boundTabIds[0])?.url).toBe('https://b.example/article');
    });

    it('holds the new tab for the task while it loads, and drops it when the task is stopped meanwhile', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      const executor = lastExecutor();
      browser.slowLoad = true;
      browser.tabs.delete(tabId);
      const closing = manager.onTabRemoved(tabId);
      await settle();
      await settle();

      // Still loading: the tab is already the task's, so no other chat can take it
      const reopened = [...browser.tabs.keys()][0];
      expect(reopened).toBeDefined();
      expect(manager.holderOf(reopened)).toBe(threadId);
      expect(executor.paused).toBe(true);
      expect(executor.notes).toEqual([]);

      await manager.cancel(threadId);
      browser.tabs.get(reopened)!.status = 'complete';
      await closing;
      await settle();
      expect(executor.notes).toEqual([]);
      expect(browser.tabs.size).toBe(0);
      expect((await store.get(threadId))?.error).toBeNull();
    });

    it('comes back in another window when the tab went with its whole window', async () => {
      browser.windows.add(7);
      const tabId = browser.open('https://news.example/', 7);
      const threadId = await manager.send({ text: 'Summarise the top story' });
      browser.tabs.delete(tabId);
      // Chrome can still answer for a window that is on its way out
      await manager.onTabRemoved(tabId, { windowClosing: true });
      await settle();
      expect(browser.tabs.get((await store.get(threadId))!.boundTabIds[0])?.windowId).toBe(1);
    });

    it('gives a stopped run no tab back: Stop is the only signal to end a task', async () => {
      const tabId = browser.open('https://news.example/');
      const threadId = await manager.send({ text: 'Summarise the top story' });
      await manager.cancel(threadId);
      await close(tabId);
      expect(browser.tabs.size).toBe(0);
      const thread = await store.get(threadId);
      expect(thread?.status).toBe('idle');
      expect(thread?.error).toBeNull();
    });

    it('keeps going in its other tabs when one of several closes, and opens nothing', async () => {
      const first = browser.open('https://a.example/');
      const second = browser.open('https://b.example/');
      // Both tabs are in one tab group, so the task is bound to both
      browser.tabs.get(first)!.groupId = 5;
      browser.tabs.get(second)!.groupId = 5;
      const threadId = await manager.send({ text: 'Compare the two pages' });
      expect((await store.get(threadId))?.boundTabIds.sort()).toEqual([first, second]);

      await close(second);
      const thread = await store.get(threadId);
      expect(thread?.status).toBe('running');
      expect(browser.tabs.size).toBe(1);
      expect(lastExecutor().notes).toEqual([]);
    });

    it('goes back to the latest page, not the first one, on "Reopen and continue"', async () => {
      const tabId = browser.open('https://shop.example/');
      const threadId = await manager.send({ text: 'Fill the order form' });
      browser.tabs.get(tabId)!.url = 'https://shop.example/checkout';
      await manager.onTabUpdated(tabId, browser.tabs.get(tabId)!);
      lastExecutor().midForm = true;
      await close(tabId);
      expect((await store.get(threadId))?.error?.kind).toBe('tab_closed');

      await manager.continueThread(threadId);
      const thread = await store.get(threadId);
      expect(browser.tabs.get(thread!.boundTabIds[0])?.url).toBe('https://shop.example/checkout');
    });
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

  it('gives every new request its own task id, and keeps it through a retry', async () => {
    browser.open('https://chat.example');
    const threadId = await manager.send({ text: 'Send the standup note' });
    const first = (await store.get(threadId))?.taskRunId;
    expect(first).toBeTruthy();
    await lastExecutor().complete('Sent.');
    await settle();

    // A retry is the same task: what it already sent is found under the same id
    await manager.retry(threadId);
    expect((await store.get(threadId))?.taskRunId).toBe(first);
    await lastExecutor().complete('Sent.');
    await settle();

    // A new request starts clean
    await manager.send({ threadId, text: 'Send it to the other channel too' });
    expect((await store.get(threadId))?.taskRunId).not.toBe(first);
  });

  it('tells a resumed run what its task already sent and what was cut off', async () => {
    const tabId = browser.open('https://chat.example');
    const thread = await store.create({
      status: 'running',
      activeTask: 'Email the three testers',
      runStartedAt: Date.now() - 1000,
      boundTabIds: [tabId],
      taskRunId: `task-${crypto.randomUUID()}`,
    });
    const step = { taskId: thread.taskRunId!, threadId: thread.id, what: 'tool', label: 'Nex Mail › send_email' };
    const sent = await onceStore.begin({ ...step, target: 'first', scope: 'mail:send_email' });
    await onceStore.finish(sent.record.key, 'the tool answered');
    await onceStore.begin({ ...step, target: 'second', scope: 'mail:send_email', label: 'send on mail.example' });

    await manager.recover();

    const context = lastExecutor().options.messageContext ?? '';
    expect(context).toContain('Already done in this task, do not do these again:\n- Nex Mail › send_email');
    expect(context).toMatch(/Started, with no record that they went through[^\n]*\n- send on mail\.example/);
    await onceStore.db.doOnce.where('taskId').equals(thread.taskRunId!).delete();
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
  describe('cancel settles the thread', () => {
    const question = (threadId: string, id = 'q1') => ({
      id,
      taskId: threadId,
      mode: 'needs_user',
      kind: 'questions',
      intent: 'Payment link so clients can pay in one tap',
      target: '',
      questions: ['Which payment link?'],
    });

    const expectIdle = async (threadId: string) => {
      const thread = await store.get(threadId);
      expect(thread?.status).toBe('idle');
      expect(thread?.activity).toBe('');
      expect(thread?.pendingRequest).toBeNull();
      expect(manager.isRunning(threadId)).toBe(false);
    };

    it('goes idle when Cancel on a question card stops the task', async () => {
      browser.open('https://shop.example');
      const threadId = await manager.send({ text: 'Set up payments' });
      const executor = lastExecutor();
      executor.stopOnDecline = true;
      await executor.emit(Actors.NAVIGATOR, ExecutionState.STEP_START);
      await executor.emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(question(threadId)));
      expect((await store.get(threadId))?.status).toBe('waiting_confirm');

      expect(await manager.answer(threadId, 'q1', false)).toBe(true);
      // The run ends by itself after the refusal; nothing may leave it looking busy
      await vi.waitFor(() => expect(manager.isRunning(threadId)).toBe(false));
      await settle();
      await expectIdle(threadId);
      const contents = (await store.messages(threadId)).map(m => m.content);
      expect(contents).toContain('gate_declinedByUser:Payment link so clients can pay in one tap');
      expect(contents).toContain('Task cancelled');
      // The next message runs with a fresh agent: the stopped one would end it at once as cancelled
      await manager.send({ threadId, text: 'Use the Stripe link' });
      expect(FakeExecutor.created).toHaveLength(2);
      expect(lastExecutor().tasks).toEqual(['Use the Stripe link']);
      expect((await store.get(threadId))?.status).toBe('running');
    });

    it('goes idle when Stop is pressed while a question waits', async () => {
      browser.open('https://shop.example');
      const threadId = await manager.send({ text: 'Set up payments' });
      await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.STEP_START);
      await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(question(threadId)));
      await manager.cancel(threadId);
      await settle();
      await expectIdle(threadId);
    });

    it('lets no event recorded late re-open a finished run', async () => {
      browser.open('https://shop.example');
      const threadId = await manager.send({ text: 'Set up payments' });
      const executor = lastExecutor();
      await executor.emit(Actors.NAVIGATOR, ExecutionState.STEP_START);
      executor.endAbruptly();
      // A navigator step that reports after the run ended, and a request shown too late
      void executor.emit(Actors.NAVIGATOR, ExecutionState.STEP_START);
      void executor.emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, JSON.stringify(question(threadId, 'late')));
      await settle();
      await settle();
      await expectIdle(threadId);
    });

    it('is idempotent: cancelling twice, or a stopped thread, leaves it idle', async () => {
      browser.open('https://shop.example');
      const threadId = await manager.send({ text: 'Set up payments' });
      await Promise.all([manager.cancel(threadId), manager.cancel(threadId)]);
      await manager.cancel(threadId);
      await settle();
      await expectIdle(threadId);
      expect((await store.messages(threadId)).filter(m => m.content === 'Task cancelled')).toHaveLength(1);
    });

    it('settles a thread left looking busy with no run behind it', async () => {
      const thread = await store.create({ status: 'waiting_confirm', activity: 'navigating' });
      await store.update(thread.id, { pendingRequest: question(thread.id) as never });
      await manager.cancel(thread.id);
      await expectIdle(thread.id);
    });

    it('takes a new message right after a cancel', async () => {
      browser.open('https://shop.example');
      const threadId = await manager.send({ text: 'Set up payments' });
      const executor = lastExecutor();
      // The run takes a moment to wind down after the stop
      executor.cancel = async () => {
        executor.cancelled = true;
        setTimeout(() => executor.endAbruptly(), 20);
      };
      await manager.cancel(threadId);
      await manager.send({ threadId, text: 'Try again' });
      expect((await store.get(threadId))?.status).toBe('running');
      expect(manager.isRunning(threadId)).toBe(true);
    });
  });
});

/**
 * Failed tasks retry, then report (docs/growth-team.md, Part 2, issue #66): the thread manager with the real
 * run endings, over a job list, an Inbox and a list of WhatsApp notices that the tests can read.
 */
describe('failed tasks retry, then report (#66)', () => {
  let queue: Map<string, { runAt: number; payload: RetryPayload }>;
  let inbox: Map<string, InboxItem>;
  let settledItems: string[];
  let whatsapp: string[];
  let endings: InstanceType<typeof RunEndings>;

  beforeEach(() => {
    queue = new Map();
    inbox = new Map();
    settledItems = [];
    whatsapp = [];
    endings = new RunEndings({
      schedule: async request => void queue.set(request.key, request),
      cancelJobs: async prefix => {
        for (const key of [...queue.keys()]) if (key.startsWith(prefix)) queue.delete(key);
      },
      reopenInbox: async () => undefined,
      ownerFollows: async () => true,
      inbox: async draft => {
        const id = `${draft.source}|${draft.externalId}`;
        if (!inbox.has(id)) inbox.set(id, { ...draft, id } as unknown as InboxItem);
      },
      inboxItem: async id => inbox.get(id),
      settleInbox: async id => void settledItems.push(id),
      notice: notice => void whatsapp.push(notice.title),
      note: (threadId, text) => store.addMessage(threadId, 'system', text),
      agent: async () => undefined,
      agentSpentUsd: async () => 0,
      now: Date.now,
    });
    manager = new ThreadManager(store, endings);
  });

  /** The job runner reaching the queued try: runs it the way the registered handler does. */
  const runQueuedTry = async (threadId: string) => {
    const key = [...queue.keys()].find(candidate => candidate.startsWith(`thread-retry:${threadId}:`));
    const job = key ? queue.get(key) : undefined;
    if (!key || !job) throw new Error('no try is queued');
    queue.delete(key);
    await endings.runRetry(
      { payload: job.payload },
      {
        thread: id => store.get(id),
        resume: id => manager.continueThread(id, undefined, { auto: true }),
        postpone: (id, retryAt) => manager.postponeRetry(id, retryAt),
        giveUp: id => manager.giveUpRetry(id),
        drop: id => manager.dropRetry(id),
      },
    );
    await settle();
  };
  const minutesUntil = (at: number) => Math.round((at - Date.now()) / 60_000);
  /** Fails the running task and waits until its end is written. */
  const failRun = async (threadId: string, message: string, code: string | null = 'max_failures') => {
    await lastExecutor().fail(message, code);
    for (let i = 0; i < 200 && manager.isRunning(threadId); i++) await settle();
  };

  it('finishes a task on a later try, with nobody touching it, after the network dropped', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    const task = (await store.get(threadId))!.taskRunId;
    await failRun(threadId, 'net::ERR_INTERNET_DISCONNECTED');

    // Not silent, and not given up: it is queued to try again in a minute
    let thread = await store.get(threadId);
    expect(thread?.status).toBe('error');
    expect(thread?.failure).toMatchObject({ cls: 'temporary', reported: false });
    expect(minutesUntil(thread!.failure!.retryAt!)).toBe(1);
    expect(thread?.autoTries).toBe(1);
    expect((await store.messages(threadId)).at(-1)?.content).toBe('retry_queued:1:1:3');
    expect(inbox.size).toBe(0);

    await runQueuedTry(threadId);

    // The same task, picked up from its transcript by a new run
    thread = await store.get(threadId);
    expect(thread?.status).toBe('running');
    expect(thread?.taskRunId).toBe(task);
    expect(thread?.failure).toBeNull();
    expect(FakeExecutor.created).toHaveLength(2);
    expect(lastExecutor().options.task).toBe('Summarise the top story');
    expect(lastExecutor().options.messageContext).toContain('interrupted and is now resumed');

    await lastExecutor().complete('The top story is about retries.');
    await settle();
    thread = await store.get(threadId);
    expect(thread?.status).toBe('idle');
    expect(thread?.failure).toBeNull();
    expect(inbox.size).toBe(0);
    expect(whatsapp).toEqual([]);
    expect(queue.size).toBe(0);
  });

  it('tries after 1, 5 and 15 minutes, then leaves exactly one Inbox item and one WhatsApp line', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    const waits: number[] = [];
    for (let round = 0; round < 3; round++) {
      await failRun(threadId, 'The page did not load');
      waits.push(minutesUntil((await store.get(threadId))!.failure!.retryAt!));
      expect(inbox.size).toBe(0);
      await runQueuedTry(threadId);
    }
    expect(waits).toEqual([1, 5, 15]);

    await failRun(threadId, 'The page did not load');
    const thread = await store.get(threadId);
    expect(thread?.failure).toEqual({ cls: 'temporary', retryAt: null, reported: true });
    expect(queue.size).toBe(0);
    expect(FakeExecutor.created).toHaveLength(4);
    expect([...inbox.values()].map(item => item.title)).toEqual(['retry_stuck_title:Summarise the top story']);
    expect(whatsapp).toHaveLength(1);
    expect(whatsapp[0]).toContain('retry_stuck_line:Summarise the top story:The page did not load.');
  });

  it('does not retry a task that needs the user: one Inbox item says what to do', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    await failRun(threadId, 'The API key was refused', 'auth');
    expect((await store.get(threadId))?.failure).toEqual({ cls: 'needs_user', retryAt: null, reported: true });
    expect(queue.size).toBe(0);
    expect([...inbox.values()].map(item => item.body)).toEqual(['The API key was refused. retry_need_key']);
    expect(whatsapp).toEqual([]);
  });

  it('produces exactly one Inbox item that says so when a task needs a sign-in, and settles it after', async () => {
    browser.open('https://admin.example/login');
    const threadId = await manager.send({ text: 'Check the waitlist' });
    const signIn = (id: string) =>
      JSON.stringify({
        id,
        taskId: threadId,
        mode: 'needs_user',
        kind: 'login',
        intent: 'Sign in',
        target: 'Password',
        pageTitle: 'Sign in',
        pageUrl: 'https://admin.example/login',
        fields: [],
        context: '',
      });
    await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, signIn('r1'));
    await settle();
    // The page asks again (a second form): still one item
    await lastExecutor().emit(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, signIn('r2'));
    await settle();

    expect([...inbox.values()]).toHaveLength(1);
    expect([...inbox.values()][0]).toMatchObject({
      kind: 'approval',
      title: 'retry_needs_login:Check the waitlist',
      body: 'retry_needs_body:admin.example',
      approval: { requestId: `thread:${threadId}`, action: 'open_thread' },
    });
    expect(queue.size).toBe(0);

    await manager.answer(threadId, 'r2', true);
    await settle();
    expect(settledItems).toContain([...inbox.keys()][0]);
  });

  it('queues a task whose tab closed in the middle of a form, and the try reopens its page without taking the screen', async () => {
    const tabId = browser.open('https://form.example/quote');
    const threadId = await manager.send({ text: 'Fill the form' });
    lastExecutor().midForm = true;
    browser.tabs.delete(tabId);
    await manager.onTabRemoved(tabId);
    for (let i = 0; i < 200 && manager.isRunning(threadId); i++) await settle();
    expect((await store.get(threadId))?.error?.kind).toBe('tab_closed');
    expect((await store.get(threadId))?.failure?.cls).toBe('temporary');
    expect(browser.tabs.size).toBe(0);

    await runQueuedTry(threadId);
    const thread = await store.get(threadId);
    expect(thread?.status).toBe('running');
    expect(browser.tabs.get(thread!.boundTabIds[0])).toMatchObject({
      url: 'https://form.example/quote',
      active: false,
    });
    // The retry starts by checking what already happened
    expect(lastExecutor().options.messageContext).toContain('interrupted and is now resumed');
  });

  it('is not tried again once Stop is pressed while a try is queued', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    await failRun(threadId, 'The page did not load');
    expect(queue.size).toBe(1);

    await manager.cancel(threadId);
    expect(queue.size).toBe(0);
    expect((await store.get(threadId))?.failure).toMatchObject({ retryAt: null, reported: false });
    expect((await store.messages(threadId)).at(-1)?.content).toBe('retry_stopped');
    expect(inbox.size).toBe(0);
  });

  it('drops the queued try and starts counting again when the user sends something new or retries themself', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    await failRun(threadId, 'The page did not load');
    expect((await store.get(threadId))?.autoTries).toBe(1);

    await manager.retry(threadId);
    expect(queue.size).toBe(0);
    expect((await store.get(threadId))?.autoTries).toBe(0);
    await failRun(threadId, 'The page did not load');
    expect(queue.size).toBe(1);

    await manager.send({ threadId, text: 'Never mind, open the sports page' });
    expect(queue.size).toBe(0);
    const thread = await store.get(threadId);
    expect(thread?.autoTries).toBe(0);
    expect(thread?.failure).toBeNull();
  });

  it('does not try, and does not report, a run that its owner stopped and reports itself', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Agent task' });
    await manager.cancel(threadId, { kind: 'failed', message: 'It spent its money for today.', quiet: true });
    await settle();
    const thread = await store.get(threadId);
    expect(thread?.error).toEqual({ kind: 'failed', message: 'It spent its money for today.' });
    expect(thread?.failure ?? null).toBeNull();
    expect(queue.size).toBe(0);
    expect(inbox.size).toBe(0);
  });

  it('reports a second time when the user continues a stuck task and it gets stuck again', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    for (let round = 0; round < 3; round++) {
      await failRun(threadId, 'The page did not load');
      await runQueuedTry(threadId);
    }
    await failRun(threadId, 'The page did not load');
    expect(inbox.size).toBe(1);

    // The user presses Continue: the old item is settled, and a new round begins
    await manager.continueThread(threadId);
    expect(settledItems).toContain([...inbox.keys()][0]);
    expect((await store.get(threadId))?.retryRound).toBe(1);
    for (let round = 0; round < 3; round++) {
      await failRun(threadId, 'The page did not load');
      await runQueuedTry(threadId);
    }
    await failRun(threadId, 'The page did not load');
    expect(inbox.size).toBe(2);
    expect(whatsapp).toHaveLength(2);
  });

  it('leaves a routine’s chat to the routine: no try is queued and nothing is reported from here', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Routine step', origin: 'workflow' });
    await failRun(threadId, 'The page did not load');
    const thread = await store.get(threadId);
    expect(thread?.status).toBe('error');
    expect(thread?.failure ?? null).toBeNull();
    expect(queue.size).toBe(0);
    expect(inbox.size).toBe(0);
  });

  it('closes the tab it opened when a queued try cannot start, so waiting for a slot leaves no tabs behind', async () => {
    const tabId = browser.open('https://form.example/quote');
    const threadId = await manager.send({ text: 'Fill the form' });
    lastExecutor().midForm = true;
    browser.tabs.delete(tabId);
    await manager.onTabRemoved(tabId);
    for (let i = 0; i < 200 && manager.isRunning(threadId); i++) await settle();

    // Every slot is taken when the try comes due
    settings.maxConcurrentThreads = 0;
    await runQueuedTry(threadId);
    expect(browser.tabs.size).toBe(0);
    expect((await store.get(threadId))?.status).toBe('error');
    // It looks again shortly, as a new job
    expect(queue.size).toBe(1);
    settings.maxConcurrentThreads = 2;
    await runQueuedTry(threadId);
    expect((await store.get(threadId))?.status).toBe('running');
    expect(browser.tabs.size).toBe(1);
  });

  it('drops a try that nobody follows without a word', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Agent task' });
    await failRun(threadId, 'The page did not load');
    await manager.dropRetry(threadId);
    expect((await store.get(threadId))?.failure).toMatchObject({ retryAt: null, reported: false });
    expect(inbox.size).toBe(0);
  });

  it('puts a waiting chat’s try back in the job list when the background starts', async () => {
    browser.open('https://news.example/');
    const threadId = await manager.send({ text: 'Summarise the top story' });
    await failRun(threadId, 'The page did not load');
    const retryAt = (await store.get(threadId))!.failure!.retryAt;
    queue.clear();

    await manager.recover();
    expect(queue.get(retryJobKey(threadId, 1))).toMatchObject({ runAt: retryAt });
  });

  it('queues a run the background cut off a moment ago, and only reports one left for hours', async () => {
    const recent = await store.create({
      status: 'running',
      activeTask: 'Post the note',
      runStartedAt: Date.now() - 5000,
    });
    const old = await store.create({
      title: 'Send the report',
      status: 'running',
      activeTask: 'Send the report',
      runStartedAt: Date.now() - 3 * 60 * 60 * 1000,
      updatedAt: Date.now() - 3 * 60 * 60 * 1000,
    });

    await manager.recover();

    expect((await store.get(recent.id))?.failure).toMatchObject({ cls: 'temporary', reported: false });
    expect(queue.has(retryJobKey(recent.id, 1))).toBe(true);
    // Hours later nobody expects it to start by itself: the user is told, once, and continues it when they want
    expect((await store.get(old.id))?.failure).toEqual({ cls: 'needs_user', retryAt: null, reported: true });
    expect(queue.has(retryJobKey(old.id, 1))).toBe(false);
    expect([...inbox.values()].map(item => item.title)).toEqual(['retry_stuck_title:Send the report']);
  });
});
