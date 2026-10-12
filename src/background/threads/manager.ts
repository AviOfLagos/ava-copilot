import { t } from '@extension/i18n';
import { generalSettingsStore, routeWorkspace, threadStore, workspaceStore } from '@extension/storage';
import type { ThreadErrorKind, ThreadRecord, ThreadStore } from '@extension/storage';
import type BrowserContext from '../browser/context';
import type { Executor } from '../agent/executor';
import { ExecutionState } from '../agent/event/types';
import type { AgentEvent } from '../agent/event/types';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import type { UsageScope } from '../usage/meter';
import { groupTabs, TabBinding, tabsToBind } from './binding';
import { createBrowserContext, createExecutor, resolveModels } from './factory';
import { buildRunContext, splitForSummary, SUMMARY_INSTRUCTIONS, transcriptOf } from './memory';
import { effectOf } from './transcript';

const logger = createLogger('ThreadManager');

// A run interrupted longer ago than this is not resumed by itself; the user continues it
export const RESUME_WINDOW_MS = 10 * 60 * 1000;
// Finished runs kept in memory, so a follow-up continues with the full model history
const MAX_PARKED = 5;
// Calling an extension API this often keeps the service worker alive while threads run
const KEEP_ALIVE_MS = 20_000;

const RESUME_NOTE =
  'This task was interrupted and is now resumed. The page may have changed, so read it again before acting. Any action that was waiting for confirmation did not happen.';
const CONTINUE_TASK = 'Continue the task where you left off.';

type StopReason = { kind: ThreadErrorKind; message: string };

interface Runner {
  threadId: string;
  executor: Executor;
  browserContext: BrowserContext;
  binding: TabBinding;
  modelKey: string;
  done: Promise<void>;
  // Set when the run is stopped from outside, e.g. its tab closed; becomes the thread's error
  stopReason: StopReason | null;
  cancelled: boolean;
  failure: string | null;
}

type Parked = Pick<Runner, 'executor' | 'browserContext' | 'binding' | 'modelKey'>;

const modelKeyOf = (thread: ThreadRecord) => (thread.model ? `${thread.model.provider}>${thread.model.modelName}` : '');

async function existingTabs(tabIds: number[]): Promise<number[]> {
  const found = await Promise.all(
    tabIds.map(id =>
      chrome.tabs.get(id).then(
        () => id,
        () => null,
      ),
    ),
  );
  return found.filter((id): id is number => id !== null);
}

/**
 * Runs threads: several at once, each bound to its own tabs, each recorded in the thread store as it
 * goes, so a panel can open, close or pop out at any time and a restarted background can pick up.
 */
export class ThreadManager {
  private readonly running = new Map<string, Runner>();
  private readonly parked = new Map<string, Parked>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly store: ThreadStore = threadStore) {}

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** The running thread that holds a tab, if any. */
  holderOf(tabId: number): string | null {
    for (const runner of this.running.values()) {
      if (runner.binding.has(tabId)) {
        return runner.threadId;
      }
    }
    return null;
  }

  /**
   * Sends a message to a thread, creating the thread when there is none, and starts a run.
   *
   * @param windowId - The window the user sent from; its tabs are bound when the thread has none
   * @returns The id of the thread
   */
  async send(request: {
    threadId?: string | null;
    text: string;
    windowId?: number;
    workspaceId?: string | null;
    // Who asked: typed in the panel, said by voice, or a routine or agent; set when the chat is new
    origin?: ThreadRecord['origin'];
    agentId?: string | null;
  }): Promise<string> {
    const text = request.text.trim();
    if (!text) {
      throw new Error(t('bg_cmd_newTask_noTask'));
    }
    const thread =
      (request.threadId && (await this.store.get(request.threadId))) ||
      (await this.store.create({ origin: request.origin ?? 'user', agentId: request.agentId ?? null }));
    if (this.running.has(thread.id)) {
      throw new Error(t('threads_busy'));
    }
    await this.checkCapacity();
    const binding = await this.bindingFor(thread, request.windowId);

    await this.store.addMessage(thread.id, 'user', text);
    await this.placeInWorkspace(thread, text, request.workspaceId);
    await this.start(thread.id, text, binding, false);
    return thread.id;
  }

  /**
   * Puts a chat in a workspace the first time it has none: the one the user picked, else the one its
   * words name. Says so in the chat, so a wrong guess is seen and changed.
   */
  private async placeInWorkspace(thread: ThreadRecord, text: string, picked?: string | null): Promise<void> {
    if (thread.workspaceId) return;
    // A chat with no workspace still runs: placing it never fails a send
    const workspaces = await workspaceStore.list().catch(() => []);
    const workspace = picked ? workspaces.find(item => item.id === picked) : routeWorkspace(text, workspaces);
    if (!workspace) return;
    await this.store.update(thread.id, { workspaceId: workspace.id });
    await this.store.addMessage(thread.id, 'system', t('workspace_placed', [workspace.name]));
  }

  /** Moves a chat to another workspace, or out of any. */
  async setWorkspace(threadId: string, workspaceId: string | null): Promise<void> {
    const workspace = await workspaceStore.get(workspaceId);
    if (workspaceId && !workspace) return;
    await this.store.update(threadId, { workspaceId: workspace?.id ?? null });
    await this.store.addMessage(
      threadId,
      'system',
      workspace ? t('workspace_moved', [workspace.name]) : t('workspace_none'),
    );
  }

  /**
   * Binds an idle thread to the tabs the user is looking at now.
   */
  async rebind(threadId: string, windowId?: number): Promise<void> {
    if (this.running.has(threadId)) {
      throw new Error(t('threads_busy'));
    }
    const picked = await tabsToBind(windowId);
    this.assertFree(threadId, picked.tabIds);
    this.parked.delete(threadId);
    const tab = await chrome.tabs.get(picked.tabIds[0]).catch(() => undefined);
    await this.store.update(threadId, {
      boundTabIds: picked.tabIds,
      boundGroupId: picked.groupId,
      boundUrl: tab?.url ?? null,
    });
  }

  /**
   * Continues a thread that stopped with an error: reopens its page when its tab closed, or picks up
   * an interrupted task.
   */
  async continueThread(threadId: string, windowId?: number): Promise<void> {
    const thread = await this.store.get(threadId);
    if (!thread || this.running.has(threadId)) {
      return;
    }
    await this.checkCapacity();

    let tabIds = await existingTabs(thread.boundTabIds);
    if (tabIds.length === 0 && thread.boundUrl) {
      const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      const tab = await chrome.tabs.create({ url: thread.boundUrl, windowId: window.id, active: true });
      tabIds = tab.id !== undefined ? [tab.id] : [];
    }
    const binding = tabIds.length ? new TabBinding(tabIds, null) : await this.bindingFor(thread, windowId);
    this.assertFree(threadId, binding.tabIds);

    await this.store.addMessage(threadId, 'system', t('threads_resumed'));
    await this.start(threadId, thread.activeTask ?? CONTINUE_TASK, binding, true);
  }

  /**
   * Runs the thread's last task again from the start, with a fresh agent: for a run that failed, stopped
   * or gave a poor answer. What happened before stays in the history, and anything that sends still
   * asks for the click again, so nothing goes out twice without the user.
   */
  async retry(threadId: string, windowId?: number): Promise<void> {
    const thread = await this.store.get(threadId);
    if (!thread || this.running.has(threadId)) return;
    const lastTask = (await this.store.messages(threadId)).filter(message => message.actor === 'user').at(-1)?.content;
    const task = lastTask ?? thread.activeTask;
    if (!task) return;
    await this.checkCapacity();
    const tabIds = await existingTabs(thread.boundTabIds);
    const binding = tabIds.length ? new TabBinding(tabIds, null) : await this.bindingFor(thread, windowId);
    this.assertFree(threadId, binding.tabIds);
    // A parked agent would carry on from where it stopped; a retry starts over
    this.parked.delete(threadId);
    await this.store.addMessage(threadId, 'system', t('threads_retried'));
    await this.start(threadId, task, binding, false);
  }

  /** Stops a thread's run. */
  async cancel(threadId: string, reason: StopReason | null = null): Promise<void> {
    const runner = this.running.get(threadId);
    if (!runner) {
      return;
    }
    runner.cancelled = true;
    runner.stopReason = reason;
    await runner.executor.cancel();
  }

  /** Stops every running thread. */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map(threadId => this.cancel(threadId)));
  }

  /** Deletes a thread, stopping it first. */
  async remove(threadId: string): Promise<void> {
    const runner = this.running.get(threadId);
    if (runner) {
      await this.cancel(threadId);
      await runner.done;
    }
    this.parked.delete(threadId);
    await this.store.remove(threadId);
  }

  /**
   * Passes the user's answer to the request a thread waits on.
   *
   * @returns false when the thread is not waiting on this request
   */
  async answer(threadId: string, requestId: string, approved: boolean, replies?: string[]): Promise<boolean> {
    const runner = this.running.get(threadId);
    const request = (await this.store.get(threadId))?.pendingRequest;
    if (!runner || !request || request.id !== requestId) {
      return false;
    }
    // Answers only for a request that asked questions, one per question
    const answers = request.questions?.length && replies ? replies.slice(0, request.questions.length) : undefined;
    if (!runner.executor.answerConfirmation(requestId, approved, answers)) {
      return false;
    }
    const subject = request.target || request.intent;
    // A note on the run, not a new request: the chat shows it as a step
    await this.store.addMessage(
      threadId,
      'system',
      approved ? t('gate_approved', [subject]) : t('gate_declinedByUser', [subject]),
    );
    await this.store.update(threadId, { pendingRequest: null, status: 'running' });
    return true;
  }

  /** A tab closed: the threads bound to it lose it, and a run left with no tab stops. */
  async onTabRemoved(tabId: number): Promise<void> {
    for (const parked of this.parked.values()) {
      parked.binding.remove(tabId);
    }
    for (const runner of [...this.running.values()]) {
      if (!runner.binding.has(tabId)) {
        continue;
      }
      runner.binding.remove(tabId);
      runner.browserContext.removeAttachedPage(tabId);
      if (runner.binding.size === 0) {
        await this.cancel(runner.threadId, { kind: 'tab_closed', message: t('threads_tabClosed') });
      }
    }
  }

  /** The user closed Chrome's debugging bar on a tab: the run working there stops. */
  async onDebuggerDetached(tabId: number): Promise<void> {
    const threadId = this.holderOf(tabId);
    if (threadId) {
      await this.cancel(threadId, { kind: 'failed', message: t('threads_debuggerClosed') });
    }
  }

  /**
   * Picks up after the background restarted: a run that was going a moment ago resumes on its tabs,
   * an older one is marked interrupted for the user to continue.
   */
  async recover(): Promise<void> {
    for (const thread of await this.store.unfinished()) {
      const recent = thread.runStartedAt !== null && Date.now() - thread.runStartedAt < RESUME_WINDOW_MS;
      const tabIds = await existingTabs(thread.boundTabIds);
      const free = tabIds.every(tabId => this.holderOf(tabId) === null);
      if (recent && thread.activeTask && tabIds.length > 0 && free) {
        logger.info('Resuming thread', thread.id);
        await this.store.addMessage(thread.id, 'system', t('threads_resumed'));
        try {
          await this.start(thread.id, thread.activeTask, new TabBinding(tabIds, thread.boundGroupId), true);
          continue;
        } catch (error) {
          logger.error('Could not resume thread', thread.id, error);
        }
      }
      await this.store.update(thread.id, {
        status: 'error',
        error: { kind: tabIds.length ? 'interrupted' : 'tab_closed', message: t('threads_interrupted') },
        activity: '',
        pendingRequest: null,
      });
    }
  }

  private async checkCapacity(): Promise<void> {
    const { maxConcurrentThreads } = await generalSettingsStore.getSettings();
    if (this.running.size >= maxConcurrentThreads) {
      throw new Error(t('threads_tooMany', [String(maxConcurrentThreads)]));
    }
  }

  private assertFree(threadId: string, tabIds: number[]): void {
    for (const tabId of tabIds) {
      const holder = this.holderOf(tabId);
      if (holder && holder !== threadId) {
        throw new TabInUseError(holder);
      }
    }
  }

  private async bindingFor(thread: ThreadRecord, windowId?: number): Promise<TabBinding> {
    // A thread stays on its own tabs while they exist; a new thread takes the tabs the user is on
    const kept = await existingTabs(thread.boundTabIds);
    const picked = kept.length ? { tabIds: kept, groupId: thread.boundGroupId } : await tabsToBind(windowId);
    try {
      this.assertFree(thread.id, picked.tabIds);
    } catch (error) {
      if (error instanceof TabInUseError) {
        const holder = await this.store.get(error.threadId);
        throw new Error(t('threads_tabInUse', [holder?.title || error.threadId]));
      }
      throw error;
    }
    return new TabBinding(picked.tabIds, picked.groupId);
  }

  /**
   * The conversation a new executor starts with. When the thread is long, the older part is
   * summarized into the thread memory first.
   */
  private async contextFor(thread: ThreadRecord, summarizer: ChatModel, resumed: boolean, task: string) {
    let messages = await this.store.messages(thread.id, thread.memoryUpToSeq);
    // The task itself is the newest user message; it goes to the executor as the task, not as history
    const last = messages[messages.length - 1];
    if (!resumed && last?.actor === 'user' && last.content === task) {
      messages = messages.slice(0, -1);
    }

    let memory = thread.memory;
    const { older, recent } = splitForSummary(messages);
    if (older.length > 0) {
      try {
        const summary = await generatePlainText({
          chatModel: summarizer,
          messages: [
            systemMessage(SUMMARY_INSTRUCTIONS),
            userMessage([memory && `Earlier summary:\n${memory}`, transcriptOf(older)].filter(Boolean).join('\n\n')),
          ],
        });
        memory = summary.trim();
        await this.store.update(thread.id, { memory, memoryUpToSeq: older[older.length - 1].seq });
      } catch (error) {
        // Without a summary the run starts with the recent turns only
        logger.warning('Could not summarize the thread', error);
      }
    }
    return buildRunContext({ memory }, recent, resumed ? RESUME_NOTE : '');
  }

  private async start(threadId: string, task: string, binding: TabBinding, resumed: boolean): Promise<void> {
    // The agent may move to any tab no other running thread is using
    binding.canAdopt = tabId => {
      const holder = this.holderOf(tabId);
      return holder === null || holder === threadId;
    };
    const thread = await this.store.get(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist`);
    }
    const scope: UsageScope = { sessionId: threadId, notify: () => {} };
    const modelKey = modelKeyOf(thread);

    let executor: Executor;
    let browserContext: BrowserContext;
    const parked = this.parked.get(threadId);
    this.parked.delete(threadId);
    if (parked && !resumed && parked.modelKey === modelKey && sameTabs(parked.binding, binding)) {
      // The finished executor still holds the model's full history of this thread
      ({ executor, browserContext } = parked);
      browserContext.setBinding(binding);
      executor.addFollowUpTask(task);
    } else {
      const models = await resolveModels(thread.model, scope);
      const messageContext = await this.contextFor(thread, models.planner, resumed, task);
      browserContext = await createBrowserContext(binding);
      executor = await createExecutor({ threadId, task, browserContext, models, messageContext });
      scope.notify = message => executor.notify(message);
    }

    const groupId = await groupTabs(binding, thread.title || task);
    const firstTab = await chrome.tabs.get(binding.tabIds[0]).catch(() => undefined);
    await this.store.update(
      threadId,
      {
        status: 'running',
        error: null,
        activity: '',
        activeTask: task,
        runStartedAt: Date.now(),
        pendingRequest: null,
        boundTabIds: binding.tabIds,
        boundGroupId: groupId,
        boundUrl: firstTab?.url ?? thread.boundUrl,
      },
      true,
    );

    const runner: Runner = {
      threadId,
      executor,
      browserContext,
      binding,
      modelKey,
      done: Promise.resolve(),
      stopReason: null,
      cancelled: false,
      failure: null,
    };
    executor.clearExecutionEvents();
    executor.subscribeExecutionEvents(event => this.record(runner, event));
    this.running.set(threadId, runner);
    this.updateKeepAlive();
    runner.done = this.drive(runner);
  }

  private async drive(runner: Runner): Promise<void> {
    try {
      await runner.executor.execute();
    } catch (error) {
      runner.failure = error instanceof Error ? error.message : String(error);
      await this.store.addMessage(runner.threadId, 'system', t('exec_task_fail', [runner.failure]));
    } finally {
      // Detaching the debugger hands the tab back to the user
      await runner.executor.cleanup();
      this.running.delete(runner.threadId);
      this.updateKeepAlive();
      if (!runner.cancelled) {
        this.park(runner);
      }
      const error = runner.stopReason ?? (runner.failure ? { kind: 'failed' as const, message: runner.failure } : null);
      await this.store.update(
        runner.threadId,
        {
          status: error ? 'error' : 'idle',
          error,
          activity: '',
          activeTask: error ? runner.executor.currentTask : null,
          runStartedAt: null,
          pendingRequest: null,
          boundTabIds: runner.binding.tabIds,
        },
        true,
      );
    }
  }

  private async record(runner: Runner, event: AgentEvent): Promise<void> {
    try {
      const effect = effectOf(event);
      if (event.state === ExecutionState.TASK_FAIL) {
        runner.failure = event.data.details;
      }
      if (effect.message) {
        await this.store.addMessage(runner.threadId, effect.message.actor, effect.message.content);
      }
      if (effect.request) {
        await this.store.addMessage(
          runner.threadId,
          'navigator',
          t('gate_waiting', [effect.request.target || effect.request.intent]),
        );
        await this.store.update(runner.threadId, { pendingRequest: effect.request, status: 'waiting_confirm' });
      }
      if (effect.activity !== undefined) {
        await this.store.update(runner.threadId, { activity: effect.activity });
      }
    } catch (error) {
      // A lost record must not stop the run
      logger.error('Failed to record an event', error);
    }
  }

  private park(runner: Runner): void {
    this.parked.set(runner.threadId, {
      executor: runner.executor,
      browserContext: runner.browserContext,
      binding: runner.binding,
      modelKey: runner.modelKey,
    });
    // Oldest first: a Map keeps insertion order
    while (this.parked.size > MAX_PARKED) {
      const oldest = this.parked.keys().next().value;
      if (oldest === undefined) break;
      this.parked.delete(oldest);
    }
  }

  private updateKeepAlive(): void {
    if (this.running.size > 0 && this.keepAliveTimer === null) {
      this.keepAliveTimer = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
    } else if (this.running.size === 0 && this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}

class TabInUseError extends Error {
  constructor(public readonly threadId: string) {
    super(`Tab is in use by thread ${threadId}`);
  }
}

function sameTabs(a: TabBinding, b: TabBinding): boolean {
  return a.size === b.size && a.tabIds.every(tabId => b.has(tabId));
}
