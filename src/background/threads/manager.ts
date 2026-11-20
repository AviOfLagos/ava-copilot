import { t } from '@extension/i18n';
import {
  agentModelStore,
  AgentNameEnum,
  db,
  generalSettingsStore,
  routeWorkspace,
  threadStore,
  workspaceStore,
} from '@extension/storage';
import type { MessageAttachment, ThreadErrorKind, ThreadRecord, ThreadStore } from '@extension/storage';
import type BrowserContext from '../browser/context';
import type { Executor } from '../agent/executor';
import { Actors, ExecutionState } from '../agent/event/types';
import type { AgentEvent } from '../agent/event/types';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import type { ChatModel } from '../llm/types';
import { createLogger } from '../log';
import { onceNote } from '../once';
import type { UsageScope } from '../usage/meter';
import { groupTabs, TabBinding, tabsToBind } from './binding';
import { createBrowserContext, createExecutor, resolveModels } from './factory';
import { buildRunContext, splitForSummary, SUMMARY_INSTRUCTIONS, transcriptOf } from './memory';
import { effectOf } from './transcript';
import { canSeeImages, mediaOf, withContext } from './attachments';
import type { TaskMedia } from './attachments';

const logger = createLogger('ThreadManager');

// A run interrupted longer ago than this is not resumed by itself; the user continues it
export const RESUME_WINDOW_MS = 10 * 60 * 1000;
// Finished runs kept in memory, so a follow-up continues with the full model history
const MAX_PARKED = 5;
// Calling an extension API this often keeps the service worker alive while threads run
const KEEP_ALIVE_MS = 20_000;
// How long a stopped run gets to wind down before a new message to its thread is refused as busy
const WIND_DOWN_MS = 5_000;
// How long handing the tabs back may take before the run is recorded as ended anyway
const CLEANUP_MS = 5_000;

// Tab ids already handled as closed; Chrome reports one closed tab twice (tabs.onRemoved, debugger.onDetach)
const MAX_CLOSED_REMEMBERED = 500;

// How long a reopened tab gets to load before the task goes on in it anyway
const REOPEN_LOAD_MS = 10_000;

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
  // Set once the executor has returned: from then on only the run's own end writes the thread's state
  ended: boolean;
  // The events still being recorded, in order; the run's end waits for them
  records: Promise<void>;
  // Where each bound tab last was, kept as it navigates: a closed tab can no longer be asked
  tabs: Map<number, TabPlace>;
  // The run's one reopening of a closed tab is used up
  reopened: boolean;
}

interface TabPlace {
  url: string;
  windowId: number | null;
}

const isWebPage = (url: string | undefined | null): url is string => !!url && /^https?:/i.test(url);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Waits for a tab to finish loading, up to a limit; a tab that is gone ends the wait. */
async function loaded(tabId: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.status !== 'loading' || Date.now() >= until) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** What the model is told, with its next look at the page, when its tab was closed and opened again. */
export const reopenedNote = (url: string): string =>
  `The tab was closed and reopened at ${url}. It is a fresh page: check you are signed in and where you are before continuing.`;

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
  // Closed tabs already handled, so the second report of the same tab is ignored
  private readonly closedTabs = new Set<number>();

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
    // Pictures and videos the user attached, already checked (see ./attachments.ts)
    attachments?: MessageAttachment[];
    // Fields set on a new thread, e.g. the voice conversation that started it
    fields?: Partial<Pick<ThreadRecord, 'voiceThreadId'>>;
    // Content the model reads with the words but the chat does not show (a document's text, a link's preview),
    // already marked as content and never instructions
    context?: string;
  }): Promise<string> {
    const attachments = request.attachments ?? [];
    // Pictures alone are a question about them
    const text = request.text.trim() || (attachments.length ? t('chat_attach_lookAt') : '');
    if (!text) {
      throw new Error(t('bg_cmd_newTask_noTask'));
    }
    const thread =
      (request.threadId && (await this.store.get(request.threadId))) ||
      (await this.store.create({
        origin: request.origin ?? 'user',
        agentId: request.agentId ?? null,
        ...request.fields,
      }));
    await this.windDown(thread.id);
    if (this.running.has(thread.id)) {
      throw new Error(t('threads_busy'));
    }
    await this.checkCapacity();
    const binding = await this.bindingFor(thread, request.windowId);

    const message = await this.store.addMessage(thread.id, 'user', text, { attachments });
    // A new request is a new task: its do-once keys start clean. Resuming or retrying keeps the task it has,
    // so what it already sent is found and not sent again (../once).
    await this.store.update(thread.id, { taskRunId: message.id });
    await this.placeInWorkspace(thread, text, request.workspaceId);
    await this.start(
      thread.id,
      text,
      binding,
      false,
      withContext(await this.mediaFor(thread, attachments), request.context),
    );
    return thread.id;
  }

  /**
   * What the agent is shown of a message's attachments. A model that cannot look at images gets none, and the
   * chat says so plainly, so the task still runs on the words.
   */
  private async mediaFor(thread: ThreadRecord, attachments: MessageAttachment[]): Promise<TaskMedia | null> {
    if (!attachments.length) return null;
    const config = thread.model ?? (await agentModelStore.getAgentModel(AgentNameEnum.Navigator));
    if (config && !(await canSeeImages(config))) {
      await this.store.addMessage(thread.id, 'system', t('chat_attach_noVision', [config.modelName]));
      return null;
    }
    return mediaOf(attachments);
  }

  /**
   * Puts a chat in a workspace the first time it has none: the one the user picked, else the one its
   * words name. Says so in the chat, so a wrong guess is seen and changed.
   */
  private async placeInWorkspace(thread: ThreadRecord, text: string, picked?: string | null): Promise<void> {
    if (thread.workspaceId) return;
    // A chat with no workspace still runs: placing it never fails a send
    const workspaces = await workspaceStore.list().catch(() => []);
    // The user's pick, else the one the words name, else the default workspace. A pick since deleted counts as none
    const pick = picked ? workspaces.find(item => item.id === picked) : undefined;
    let workspace = pick ?? routeWorkspace(text, workspaces);
    if (!workspace) {
      const fallback = await workspaceStore.getDefaultWorkspaceId().catch(() => null);
      workspace = workspaces.find(item => item.id === fallback) ?? null;
    }
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
    await this.windDown(threadId);
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
    await this.windDown(threadId);
    const thread = await this.store.get(threadId);
    if (!thread || this.running.has(threadId)) return;
    const lastRequest = (await this.store.messages(threadId)).filter(message => message.actor === 'user').at(-1);
    const task = lastRequest?.content ?? thread.activeTask;
    if (!task) return;
    await this.checkCapacity();
    const tabIds = await existingTabs(thread.boundTabIds);
    const binding = tabIds.length ? new TabBinding(tabIds, null) : await this.bindingFor(thread, windowId);
    this.assertFree(threadId, binding.tabIds);
    // A parked agent would carry on from where it stopped; a retry starts over
    this.parked.delete(threadId);
    await this.store.addMessage(threadId, 'system', t('threads_retried'));
    await this.start(threadId, task, binding, false, await this.mediaFor(thread, lastRequest?.attachments ?? []));
  }

  /**
   * Stops a thread's run. Safe to call any number of times: the first call stops the run, and the run's end
   * settles the thread. A thread that still looks busy with no run behind it is settled here, so Stop
   * always gives the chat back.
   */
  async cancel(threadId: string, reason: StopReason | null = null): Promise<void> {
    const runner = this.running.get(threadId);
    if (!runner) {
      const thread = await this.store.get(threadId);
      if (
        !this.running.has(threadId) &&
        thread &&
        (thread.status === 'running' || thread.status === 'waiting_confirm')
      ) {
        await this.store.update(
          threadId,
          { status: 'idle', activity: '', pendingRequest: null, runStartedAt: null, activeTask: null },
          true,
        );
      }
      return;
    }
    // A later reason, e.g. the tab closing while the stop winds down, does not replace the first
    runner.stopReason ??= reason;
    if (runner.cancelled || runner.ended) {
      return;
    }
    runner.cancelled = true;
    await runner.executor.cancel();
  }

  /**
   * Waits a moment for a run that was told to stop or is writing its end, so a message sent right after Stop
   * is not refused as busy.
   */
  private async windDown(threadId: string): Promise<void> {
    const runner = this.running.get(threadId);
    if (!runner || !(runner.cancelled || runner.ended)) return;
    await Promise.race([runner.done, new Promise(resolve => setTimeout(resolve, WIND_DOWN_MS))]);
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
    // Both writes are issued now, before the agent resumes. A refusal can end the run at once, and the run's
    // end must be the last word on the thread's state: written after it, 'running' would leave the chat stuck
    // busy with the Stop button showing.
    const note = this.store.addMessage(
      threadId,
      'system',
      approved ? t('gate_approved', [subject]) : t('gate_declinedByUser', [subject]),
    );
    const state =
      this.running.get(threadId) === runner && !runner.ended
        ? this.store.update(threadId, { pendingRequest: null, status: 'running' })
        : Promise.resolve(false);
    await Promise.all([note, state]);
    return true;
  }

  /**
   * A bound tab moved to another page: remember where, since a closed tab cannot be asked, and keep the
   * thread's page current so "Reopen and continue" goes to the latest page, not the first one.
   */
  async onTabUpdated(tabId: number, tab: Pick<chrome.tabs.Tab, 'url' | 'windowId'>): Promise<void> {
    if (!isWebPage(tab.url)) return;
    for (const runner of this.running.values()) {
      if (!runner.binding.has(tabId)) continue;
      const before = runner.tabs.get(tabId);
      runner.tabs.set(tabId, { url: tab.url, windowId: tab.windowId ?? before?.windowId ?? null });
      // The page the run is working on, or its only one
      const current = runner.browserContext.currentTabId ?? null;
      if (before?.url !== tab.url && (current === tabId || (current === null && runner.binding.size === 1))) {
        await this.store.update(runner.threadId, { boundUrl: tab.url });
      }
    }
  }

  /**
   * A tab closed: the threads bound to it lose it. A run left with no tab gets its page back once
   * (docs/growth-team.md, Part 1) unless it was in the middle of a form or a send; then it ends as
   * `tab_closed`, which is retried by checking first what already happened.
   *
   * Chrome reports one closed tab twice, as a removed tab and as a detached debugger. Both come here, and
   * only the first report of a tab id is handled.
   */
  async onTabRemoved(tabId: number): Promise<void> {
    if (this.closedTabs.has(tabId)) return;
    this.closedTabs.add(tabId);
    if (this.closedTabs.size > MAX_CLOSED_REMEMBERED) {
      this.closedTabs.delete(this.closedTabs.values().next().value as number);
    }
    for (const parked of this.parked.values()) {
      parked.binding.remove(tabId);
    }
    for (const runner of [...this.running.values()]) {
      if (!runner.binding.has(tabId)) {
        continue;
      }
      const place = runner.tabs.get(tabId);
      runner.tabs.delete(tabId);
      // Other tabs remain: the run goes on in them
      if (runner.binding.size > 1) {
        runner.binding.remove(tabId);
        runner.browserContext.removeAttachedPage(tabId);
        continue;
      }
      const outcome = await this.reopen(runner, tabId, place);
      if (outcome === 'reopened') continue;
      runner.binding.remove(tabId);
      runner.browserContext.removeAttachedPage(tabId);
      if (outcome === 'ended') continue;
      await this.cancel(runner.threadId, { kind: 'tab_closed', message: t('threads_tabClosed') });
    }
  }

  /**
   * Opens a run's closed tab again on its last page and makes it the run's tab.
   *
   * @returns 'reopened'; 'ended' when the run was stopped meanwhile; 'no' when the tab must stay closed: the
   *   run was mid-form or mid-send, already used its one reopening, or has no page to go back to
   */
  private async reopen(runner: Runner, tabId: number, place?: TabPlace): Promise<'reopened' | 'ended' | 'no'> {
    // Stop is the only signal that the user wants the task ended; a stopped run gets no tab back
    if (runner.cancelled || runner.ended) return 'ended';
    if (runner.reopened) return 'no';
    const thread = await this.store.get(runner.threadId);
    // Typed into a field or clicked a submit in the last steps, or a commit is waiting for the click: the page
    // held something a fresh one does not, so it is not reopened blindly
    if (runner.executor.isMidForm() || thread?.status === 'waiting_confirm') return 'no';
    const url = place?.url ?? thread?.boundUrl;
    if (!isWebPage(url)) return 'no';

    runner.reopened = true;
    // The task waits between steps while its page comes back: steps on the dead page would only fail, and
    // three failures in a row end a task
    void runner.executor.pause();
    try {
      // The same window, or the last one the user worked in when the window closed too
      const same =
        place?.windowId != null ? await chrome.windows.get(place.windowId).catch(() => undefined) : undefined;
      const window = same ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }));
      if (window?.id === undefined) return 'no';
      // In its own window the tab comes back where it was; in another window it does not take the user's place
      const tab = await chrome.tabs.create({ url, windowId: window.id, active: same !== undefined });
      if (tab.id === undefined) return 'no';
      await loaded(tab.id, REOPEN_LOAD_MS);
      if (runner.cancelled || runner.ended || this.running.get(runner.threadId) !== runner) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        return 'ended';
      }
      runner.binding.add(tab.id);
      runner.binding.remove(tabId);
      runner.browserContext.removeAttachedPage(tabId);
      runner.browserContext.updateCurrentTabId(tab.id);
      runner.tabs.set(tab.id, { url, windowId: window.id });
      runner.executor.resumeOnFreshPage(reopenedNote(url));
      await this.store.addMessage(runner.threadId, 'system', t('threads_tabReopened', [hostOf(url)]));
      await this.store.update(runner.threadId, { boundTabIds: runner.binding.tabIds, boundUrl: url });
      logger.info('Reopened the closed tab of thread', runner.threadId);
      return 'reopened';
    } catch (error) {
      logger.warning('Could not reopen the closed tab', error);
      return 'no';
    } finally {
      // Whatever happened, the task is not left waiting: it goes on, or it is stopped right after this
      void runner.executor.resume();
    }
  }

  /**
   * The debugger left a tab. When the user dismissed Chrome's debugging bar, the run working there stops.
   * When the tab itself went away ('target_closed'), it is a closed tab like any other.
   */
  async onDebuggerDetached(tabId: number, reason: string = 'canceled_by_user'): Promise<void> {
    if (reason === 'target_closed') {
      // Only a tab that is really gone: the same reason is given when a tab's page is swapped
      const exists = await chrome.tabs.get(tabId).then(
        () => true,
        () => false,
      );
      if (!exists) await this.onTabRemoved(tabId);
      return;
    }
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
    // The task itself is the newest user message; it goes to the executor as the task, not as history.
    // Notes the copilot added after it (the workspace it landed in) do not count as the newest message.
    let lastIndex = messages.length - 1;
    while (lastIndex >= 0 && messages[lastIndex].actor === 'system') lastIndex--;
    const last = messages[lastIndex];
    if (!resumed && last?.actor === 'user' && last.content === task) {
      messages = messages.filter((_, index) => index !== lastIndex);
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
    // A run that picks a task up again is told what the task already sent and what was cut off mid-send
    const note = [resumed ? RESUME_NOTE : '', await onceNote(thread)].filter(Boolean).join('\n\n');
    return buildRunContext({ memory }, recent, note);
  }

  private async start(
    threadId: string,
    task: string,
    binding: TabBinding,
    resumed: boolean,
    media: TaskMedia | null = null,
  ): Promise<void> {
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
      executor.addFollowUpTask(task, media);
    } else {
      const models = await resolveModels(thread.model, scope);
      const messageContext = await this.contextFor(thread, models.planner, resumed, task);
      // An agent's chat stays on the agent's sites
      const agent = thread.agentId ? await db.agents.get(thread.agentId).catch(() => undefined) : undefined;
      browserContext = await createBrowserContext(binding, { onlyDomains: agent?.domains });
      executor = await createExecutor({ threadId, task, browserContext, models, messageContext, media });
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
      ended: false,
      records: Promise.resolve(),
      tabs: new Map(),
      reopened: false,
    };
    for (const tabId of binding.tabIds) {
      const tab = tabId === firstTab?.id ? firstTab : await chrome.tabs.get(tabId).catch(() => undefined);
      if (isWebPage(tab?.url)) runner.tabs.set(tabId, { url: tab.url, windowId: tab.windowId ?? null });
    }
    executor.clearExecutionEvents();
    // One at a time and in order: two events recorded at once could land in the wrong order
    executor.subscribeExecutionEvents(
      event => (runner.records = runner.records.then(() => this.record(runner, event))),
    );
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
      runner.ended = true;
      // The last events (the executor reports its end without waiting) are recorded before the end is written
      await runner.records;
      // Detaching the debugger hands the tab back to the user; a hung detach must not leave the chat busy
      await Promise.race([
        runner.executor.cleanup().catch(error => logger.warning('Cleanup failed', error)),
        new Promise(resolve => setTimeout(resolve, CLEANUP_MS)),
      ]);
      if (!runner.cancelled) {
        this.park(runner);
      }
      const error = runner.stopReason ?? (runner.failure ? { kind: 'failed' as const, message: runner.failure } : null);
      try {
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
      } finally {
        // Only now is the thread free: a message sent while the end was being written waits for it (see send)
        // instead of starting a run that this write would then mark idle
        this.running.delete(runner.threadId);
        this.updateKeepAlive();
      }
    }
  }

  private async record(runner: Runner, event: AgentEvent): Promise<void> {
    try {
      const effect = effectOf(event);
      if (event.state === ExecutionState.TASK_FAIL) {
        runner.failure = event.data.details;
      }
      // The task stopped itself, e.g. the user cancelled a commit on the card: its agent is stopped for good (its
      // requests are aborted), so it is not kept for a follow-up, which would end at once as cancelled
      if (event.actor === Actors.SYSTEM && event.state === ExecutionState.TASK_CANCEL) {
        runner.cancelled = true;
      }
      if (effect.message) {
        await this.store.addMessage(runner.threadId, effect.message.actor, effect.message.content);
      }
      // After the run ended, or once it is told to stop, nothing may make the thread look busy again
      if (runner.ended || this.running.get(runner.threadId) !== runner) return;
      if (runner.cancelled && (effect.request || effect.activity)) return;
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
