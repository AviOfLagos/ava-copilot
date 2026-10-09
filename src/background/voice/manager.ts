import { t } from '@extension/i18n';
import {
  db,
  generalSettingsStore,
  llmProviderStore,
  localDay,
  meetingSettingsStore,
  meetingStore,
  threadStore,
  usageStore,
} from '@extension/storage';
import type { ThreadRecord } from '@extension/storage';
import { createLogger } from '../log';
import { isOverCap } from '../usage/budget';
import { LIVE_AUDIO_USD_PER_MINUTE, LIVE_AUDIO_OUT_USD_PER_MINUTE } from '../usage/pricing';
import { closeOffscreenIfIdle, ensureOffscreen, toOffscreen } from '../offscreen';
import type { ThreadManager } from '../threads/manager';
import type { MeetingManager } from '../meetings/manager';
import type { KnowledgeBase } from '../kb/manager';
import type { CalendarWatcher } from '../calendar/watcher';
import { noticeFor, VOICE_INSTRUCTIONS, VOICE_TOOLS } from './prompt';
import { listFrequentSites, listTabs, openTab, readPage, switchTab } from './browser-tools';
import { THINK_INSTRUCTIONS } from './prompt';
import { generatePlainText } from '../llm/generate';
import { systemMessage, userMessage } from '../llm/messages';
import { resolveModels } from '../threads/factory';

const logger = createLogger('Voice');

const WATCH_MS = 2000;
const KEEP_ALIVE_MS = 20_000;

export type VoiceStatus = 'connecting' | 'listening' | 'speaking' | 'off';

/**
 * Runs the spoken conversation: starts and stops the session in the offscreen document, runs the
 * tools it calls, keeps the conversation in a thread, and tells the user out loud when something
 * they started finishes or waits for their click.
 */
// Turns of the user's speech an address may come from
const RECENT_TURNS = 4;

export class VoiceManager {
  private threadId: string | null = null;
  private windowId: number | undefined;
  // What the user said in the last few turns, to check where an address came from
  private recentHeard: string[] = [];
  // What has been said about each thread, so nothing is announced twice
  private announced = new Map<string, string>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  status: VoiceStatus = 'off';

  constructor(
    private readonly threads: ThreadManager,
    private readonly meetings: MeetingManager,
    private readonly kb: KnowledgeBase | null = null,
    private readonly calendar: CalendarWatcher | null = null,
  ) {}

  /** Says something to the user when a conversation is on, e.g. a meeting about to start. */
  async announce(text: string): Promise<void> {
    if (!this.running) return;
    await toOffscreen({ type: 'voice_say', text: `System notice: ${text}` }).catch(() => {});
  }

  get running(): boolean {
    return this.threadId !== null;
  }

  /**
   * Starts listening.
   *
   * @returns micDenied when the microphone has not been allowed yet
   */
  async start(windowId?: number): Promise<{ ok: boolean; micDenied?: boolean; error?: string }> {
    if (this.running) return { ok: true };
    const providers = await llmProviderStore.getAllProviders();
    const gemini = Object.entries(providers).find(([id, p]) => (p.type ?? id) === 'gemini' && p.apiKey);
    if (!gemini) throw new Error(t('voice_needsGemini'));
    if (await this.overCap()) throw new Error(t('usage_capReached_short'));

    const settings = await meetingSettingsStore.getSettings();
    const { stylePrompt } = await generalSettingsStore.getSettings();
    const thread = await threadStore.create({ title: t('voice_threadTitle'), tags: ['voice'] });

    await ensureOffscreen();
    const response = await toOffscreen<{ ok?: boolean; error?: string; micDenied?: boolean }>({
      type: 'voice_start',
      options: {
        endpoint: settings.liveEndpoint,
        apiKey: gemini[1].apiKey,
        model: settings.liveModel,
        instructions: [VOICE_INSTRUCTIONS, stylePrompt && `How the user likes answers: ${stylePrompt}`]
          .filter(Boolean)
          .join('\n\n'),
        tools: VOICE_TOOLS,
      },
    });
    if (!response?.ok) {
      await threadStore.remove(thread.id);
      await closeOffscreenIfIdle();
      return { ok: false, micDenied: response?.micDenied, error: response?.error };
    }

    this.threadId = thread.id;
    this.windowId = windowId;
    // Threads already waiting or finished are not news
    for (const existing of await db.threads.toArray()) this.announced.set(existing.id, stateKey(existing));
    this.watchTimer = setInterval(() => void this.watch(), WATCH_MS);
    this.keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.watchTimer = null;
    this.keepAlive = null;
    this.threadId = null;
    this.status = 'off';
    await toOffscreen({ type: 'voice_stop' }).catch(() => {});
    await closeOffscreenIfIdle();
  }

  /** After a restart of the background the conversation's state is gone, so the session ends cleanly. */
  async recover(): Promise<void> {
    const voice = await toOffscreen<{ running?: boolean }>({ type: 'voice_running' }).catch(() => null);
    if (voice?.running) await this.stop();
  }

  onStatus(status: VoiceStatus): void {
    this.status = status;
    if (status === 'off' && this.running) void this.stop();
  }

  /** One exchange of the conversation, kept in its thread. */
  async onTurn(heard: string, said: string): Promise<void> {
    if (heard) this.recentHeard = [...this.recentHeard, heard].slice(-RECENT_TURNS);
    if (!this.threadId) return;
    if (heard) await threadStore.addMessage(this.threadId, 'user', heard);
    if (said) await threadStore.addMessage(this.threadId, 'planner', said);
  }

  /** Runs a tool the copilot called and returns what it should know. */
  async onTool(name: string, args: Record<string, unknown>, heard = ''): Promise<string> {
    switch (name) {
      case 'run_browser_task': {
        const task = String(args.task ?? '').trim();
        if (!task) return 'No task was given.';
        const threadId = await this.threads.send({ text: task, windowId: this.windowId });
        this.announced.set(threadId, 'running');
        return 'Started in the browser. The user will hear when it finishes or needs their click.';
      }
      case 'ask_meeting': {
        const meeting = (await meetingStore.list()).find(m => m.status !== 'failed');
        if (!meeting) return 'No meeting has been recorded yet.';
        return this.meetings.ask(meeting.id, String(args.question ?? ''));
      }
      case 'ask_knowledge': {
        if (!this.kb) return 'The knowledge base is not available.';
        const { answer, citations } = await this.kb.ask(String(args.question ?? ''));
        const sources = citations.map(c => `[${c.n}] ${c.title}, ${c.label}`).join('; ');
        return sources ? `${answer}\nSources: ${sources}` : answer;
      }
      case 'get_schedule': {
        if (!this.calendar) return 'No calendar is connected.';
        const events = await this.calendar.upcoming(Number(args.hours) > 0 ? Number(args.hours) : 24);
        if (events.length === 0)
          return 'Nothing on the calendar in that time, or no calendar is connected in settings.';
        return events
          .map(event => {
            const at = new Date(event.start).toLocaleString(undefined, {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
            });
            return `${at}: ${event.title}${event.joinUrl ? ' (has a meeting link)' : ''}`;
          })
          .join('\n');
      }
      case 'join_next_meeting': {
        const next = (await this.calendar?.upcoming(2))?.find(event => event.joinUrl);
        if (!next?.joinUrl) return 'No meeting with a link in the next two hours.';
        await chrome.tabs.create({ url: next.joinUrl, active: true });
        return `Opened ${next.title}. Pressing Alt+Shift+M on the call starts notes.`;
      }
      case 'list_frequent_sites':
        return listFrequentSites();
      case 'remember_this': {
        if (!this.kb) return 'The knowledge base is not available.';
        const note = String(args.note ?? '').trim();
        if (note) {
          const item = await this.kb.saveNote(note, String(args.title ?? ''));
          return `Saved the note "${item.title}".`;
        }
        const [tab] = await chrome.tabs.query(
          this.windowId !== undefined
            ? { windowId: this.windowId, active: true }
            : { active: true, lastFocusedWindow: true },
        );
        if (!tab?.id) return 'There is no page in front to save.';
        const item = await this.kb.savePage(tab.id);
        return `Saved the page "${item.title}".`;
      }
      case 'think':
        return this.think(String(args.question ?? ''), args.use_page === true);
      case 'list_tabs':
        return listTabs(this.windowId);
      case 'read_page':
        return readPage(
          this.windowId,
          typeof args.tab_id === 'number' ? args.tab_id : undefined,
          tabId => this.threads.holderOf(tabId) !== null,
        );
      case 'open_tab':
        // Only a site the user named, or one already open: never one a read page suggested
        return openTab(String(args.target ?? ''), this.windowId, [...this.recentHeard, heard].join(' '));
      case 'switch_tab':
        return typeof args.tab_id === 'number' ? switchTab(args.tab_id, this.windowId) : 'No tab id was given.';
      case 'get_status':
        return this.describeStatus();
      case 'stop_tasks':
        await this.threads.cancelAll();
        return 'Every running task was stopped.';
      default:
        return `There is no tool called ${name}.`;
    }
  }

  /** Answers a hard question with the planner model, optionally with the page in front. */
  private async think(question: string, usePage: boolean): Promise<string> {
    if (!question.trim()) return 'No question was given.';
    if (await this.overCap()) return t('usage_capReached_short');
    const page = usePage ? await readPage(this.windowId, undefined, id => this.threads.holderOf(id) !== null) : '';
    const { planner } = await resolveModels(null, { sessionId: this.threadId ?? 'voice', notify: () => {} });
    const answer = await generatePlainText({
      chatModel: planner,
      messages: [
        systemMessage(THINK_INSTRUCTIONS),
        userMessage(page ? `${page}\n\nQuestion: ${question}` : `Question: ${question}`),
      ],
    });
    return answer.trim() || 'No answer came back.';
  }

  /** Voice minutes count toward cost; past the daily cap the conversation ends. */
  async onUsage(inputSeconds: number, outputSeconds: number): Promise<void> {
    await usageStore.add(this.threadId ?? 'voice', localDay(), {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: (inputSeconds / 60) * LIVE_AUDIO_USD_PER_MINUTE + (outputSeconds / 60) * LIVE_AUDIO_OUT_USD_PER_MINUTE,
      calls: 1,
      unpricedCalls: 0,
    });
    if (await this.overCap()) await this.stop();
  }

  private async overCap(): Promise<boolean> {
    const { dailyCostCapUsd } = await generalSettingsStore.getSettings();
    return isOverCap((await usageStore.getDay(localDay())).costUsd, dailyCostCapUsd);
  }

  private async describeStatus(): Promise<string> {
    const active = (await db.threads.toArray()).filter(t => t.status === 'running' || t.status === 'waiting_confirm');
    const recording = (await meetingStore.active()).find(m => m.status === 'recording');
    const lines = active.map(thread =>
      thread.status === 'waiting_confirm'
        ? `"${thread.title}" waits for the user's Confirm click: ${thread.pendingRequest?.target ?? ''}`
        : `"${thread.title}" is running`,
    );
    if (recording) lines.push(`Notes are being taken on "${recording.title}"`);
    return lines.length ? lines.join('. ') : 'Nothing is running.';
  }

  /** Tells the user about threads that finished, failed, or wait for a click, once each. */
  private async watch(): Promise<void> {
    if (!this.running) return;
    try {
      for (const thread of await db.threads.toArray()) {
        if (thread.id === this.threadId) continue;
        const key = stateKey(thread);
        const before = this.announced.get(thread.id);
        if (key === before) continue;
        this.announced.set(thread.id, key);
        if (before === undefined && thread.status === 'idle') continue;
        const last = thread.status === 'idle' ? (await threadStore.messages(thread.id)).pop()?.content : undefined;
        const notice = noticeFor(thread, last);
        if (notice) await toOffscreen({ type: 'voice_say', text: notice });
      }
      for (const meeting of await meetingStore.list()) {
        const key = `meeting:${meeting.status}`;
        if (this.announced.get(meeting.id) === key) continue;
        const known = this.announced.has(meeting.id);
        this.announced.set(meeting.id, key);
        if (known && meeting.status === 'done') {
          await toOffscreen({
            type: 'voice_say',
            text: `The notes for "${meeting.note?.title ?? meeting.title}" are ready.`,
          });
        }
      }
    } catch (error) {
      logger.warning('Voice watch failed', error);
    }
  }
}

function stateKey(thread: Pick<ThreadRecord, 'status' | 'pendingRequest'>): string {
  return thread.status === 'waiting_confirm' ? `waiting:${thread.pendingRequest?.id}` : thread.status;
}
