import 'webextension-polyfill';
import { db, generalSettingsStore, meetingStore, threadStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { createLogger } from './log';
import { holdForDictation, releaseDictation, sttErrorMessage, transcribeAndCorrect } from './voice/dictation';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { ThreadManager } from './threads/manager';
import { runEndings } from './retry/register';
import { MeetingManager } from './meetings/manager';
import { dispatchCommand, registerRecovery, runRecoveries } from './registry';
import { setServices } from './registry/services';
import './registers';
import { jobs } from './jobs/runner';
import { MorningBrief } from './brief/manager';
import { GraphBuilder } from './graph/builder';
import { WakeWord } from './voice/wake';
import { VoiceManager } from './voice/manager';
import { prepareAttachments } from './threads/attachments';
import { KnowledgeBase } from './kb/manager';
import { memoryScope } from './kb/scope';
import { setKnowledgeBase } from './kb/shared';
import { parseKbExport } from './kb/transfer';
import { CalendarWatcher } from './calendar/watcher';
import { AutoJoin } from './meetings/autojoin';
import { deliverMeetingEvent } from './meetings/alerts';
import { addAudioOnInvoke } from './meetings/register';
import { connectGoogleCalendar } from './calendar/connect';
import { draftSkill, teachTranscript } from './skills/teach';
import { resolveModels } from './threads/factory';

const logger = createLogger('background');

// Every run belongs to a thread; the manager runs several at once, each on its own tabs
// Failed runs are queued to try again, or reported once (./retry)
const threads = new ThreadManager(undefined, runEndings);
const meetings = new MeetingManager();
const kb = new KnowledgeBase();
setKnowledgeBase(kb);
// The knowledge graph follows the knowledge base; anything missed while the background slept is caught up
const graph = new GraphBuilder();
kb.onChange(change => void graph.handle(change));
setTimeout(() => void graph.sync(), 30_000);
const calendar = new CalendarWatcher();
const autoJoin = new AutoJoin(meetings);
autoJoin.start();
const voice = new VoiceManager(threads, meetings, kb, calendar);
const wakeWord = new WakeWord(voice);
wakeWord.start();
calendar.start();
const brief = new MorningBrief(calendar);
brief.start();
voice.brief = brief;
setServices({ threads, meetings, kb, voice, calendar, brief });
// A meeting about to start is said aloud when a conversation is on
calendar.onReminder(({ minutes }) => {
  // The notice never carries the title: it comes from an invite anyone could send. Voice reads it
  // through get_schedule, which marks it as untrusted.
  void voice.announce(
    `the user's next meeting starts ${minutes <= 0 ? 'now' : `in ${minutes} minutes`}. Call get_schedule for its name, then offer to open it.`,
  );
});
const SIDE_PANEL_URL = chrome.runtime.getURL(
  (chrome.runtime.getManifest() as { side_panel?: { default_path?: string } }).side_panel?.default_path ??
    'sidepanel.html',
);

// The toolbar button opens the side panel itself rather than through openPanelOnActionClick:
// a click handled here counts as invoking the extension on the tab, which is what lets the panel
// record that tab's audio for meeting notes
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(error => console.error(error));
chrome.action.onClicked.addListener(tab => {
  if (tab.windowId !== undefined) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch(error => logger.error('Could not open the side panel', error));
  }
  // Notes that started on their own from captions record the call's audio from this click on
  if (tab.id !== undefined) void addAudioOnInvoke(meetings, tab.id);
});

// The keyboard shortcut also invokes the extension on the tab, so notes start there directly
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-meeting-notes' || tab?.id === undefined) {
    return;
  }
  try {
    const recording = (await meetingStore.active()).find(meeting => meeting.status === 'recording');
    // On a call taking notes from captions, the shortcut adds the audio rather than stopping
    if (recording?.tabId === tab.id && recording.source === 'captions' && (await addAudioOnInvoke(meetings, tab.id))) {
      return;
    }
    if (recording) await meetings.stop(recording.id);
    else await meetings.start({ tabId: tab.id });
  } catch (error) {
    logger.error('Meeting shortcut failed', error);
    await deliverMeetingEvent({
      kind: 'start_failed',
      tabId: tab.id,
      platform: '',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
});

// The user's Obsidian notes, read by an extension page that holds the vault folder
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (message?.type === 'kb_vault_import' && Array.isArray(message.notes)) {
    const notes = message.notes
      .slice(0, 50)
      .filter((note: Record<string, unknown>) => typeof note?.path === 'string' && typeof note?.text === 'string')
      .map((note: Record<string, unknown>) => ({
        path: String(note.path).slice(0, 500),
        title: String(note.title ?? '').slice(0, 200),
        text: String(note.text).slice(0, 300_000),
        workspaceId: typeof note.workspaceId === 'string' ? note.workspaceId : null,
        modified: Number(note.modified) || Date.now(),
      }));
    void kb.saveVaultNotes(notes).then(sendResponse, () => sendResponse(0));
    return true;
  }
  if (message?.type === 'kb_vault_remove' && Array.isArray(message.paths)) {
    void kb.removeVaultNotes(message.paths.filter((path: unknown) => typeof path === 'string')).then(
      () => sendResponse(true),
      () => sendResponse(false),
    );
    return true;
  }
  return;
});

// Messages from the voice session in the offscreen document; a tool call is answered
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string' || !message.type.startsWith('voice_')) {
    return;
  }
  switch (message.type) {
    case 'voice_tool':
      voice
        .onTool(String(message.name), message.args ?? {}, String(message.heard ?? ''))
        .then(sendResponse, error =>
          sendResponse(`The tool failed: ${error instanceof Error ? error.message : error}`),
        );
      return true;
    case 'voice_turn':
      void voice.onTurn(String(message.heard ?? ''), String(message.said ?? ''));
      break;
    case 'voice_status':
      voice.onStatus(message.status);
      break;
    case 'voice_usage':
      void voice.onUsage(Number(message.inputSeconds) || 0, Number(message.outputSeconds) || 0);
      break;
  }
  return;
});

// Messages from the recorder in the offscreen document, and from the caption reader in a meeting page
chrome.runtime.onMessage.addListener(message => {
  const meetingId = typeof message?.meetingId === 'string' ? message.meetingId : null;
  if (!meetingId) return;
  switch (message.type) {
    case 'meeting_chunk':
      meetings.onChunk(meetingId);
      break;
    case 'meeting_silence':
      void meetings.onSilence(meetingId, message.silent === true);
      break;
    case 'meeting_source_ended':
      void meetings.onSourceEnded(meetingId);
      break;
    case 'meeting_captions':
      if (Array.isArray(message.lines)) void meetings.onCaptions(meetingId, message.lines);
      break;
    case 'meeting_live_usage':
      if (typeof message.seconds === 'number') void meetings.onLiveUsage(meetingId, message.seconds);
      break;
    case 'meeting_recorder_error':
      logger.error('Recorder error', message.error);
      void autoJoin.flow.recorderFailed(meetingId, String(message.error ?? ''));
      break;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Where each bound tab is now, so a closed one can be opened again on its last page
  if (tabId && (changeInfo.url || changeInfo.status === 'complete')) {
    void threads.onTabUpdated(tabId, tab);
  }
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// The user dismissed Chrome's debugging bar on a tab: stop only the thread working there. A tab that closed
// reports here too ('target_closed') as well as in tabs.onRemoved; the thread manager handles it once.
chrome.debugger.onDetach.addListener(async (source, reason) => {
  logger.info('Debugger detached', source, reason);
  if ((reason === 'canceled_by_user' || reason === 'target_closed') && source.tabId) {
    await threads.onDebuggerDetached(source.tabId, reason);
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void threads.onTabRemoved(tabId, { windowClosing: removeInfo?.isWindowClosing });
  void meetings.onTabRemoved(tabId);
});

// Chats join the knowledge base when a run settles, and meetings when their note is written. The
// background is the only writer of these statuses, so its own writes are the signal.
db.threads.hook('updating', (changes: Partial<{ status: string }>) => {
  if (changes.status === 'idle' || changes.status === 'error') kb.scheduleSweep();
});
db.meetings.hook('updating', (changes: Partial<{ status: string }>, meetingId: string) => {
  if (changes.status === 'done') {
    setTimeout(() => void kb.indexMeeting(meetingId).catch(error => logger.error('Could not index meeting', error)));
  }
});

// Settings pages manage the knowledge base through the background, which keeps its search index
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string' || !message.type.startsWith('kb_')) {
    return;
  }
  const run = async () => {
    switch (message.type) {
      case 'kb_wipe':
        await kb.wipe();
        return { ok: true };
      case 'kb_import':
        return { ok: true, count: await kb.importAll(parseKbExport(message.data)) };
      case 'kb_delete':
        await kb.remove(String(message.itemId));
        return { ok: true };
      case 'kb_sweep':
        await kb.sweep();
        return { ok: true };
      case 'kb_calendar_connect':
        // Which signed-in Google account: its number (/u/N) or its address
        return connectGoogleCalendar(
          typeof message.account === 'number' || typeof message.account === 'string' ? message.account : 0,
        );
      case 'kb_calendar_refresh': {
        const error = await calendar.refresh();
        return error ? { ok: false, error } : { ok: true };
      }
      default:
        return { ok: false, error: t('errors_cmd_unknown', [message.type]) };
    }
  };
  run().then(sendResponse, error =>
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

// A restarted service worker picks up the threads and meetings that were running
void threads.recover().catch(error => logger.error('Failed to recover threads', error));
void meetings.recover().catch(error => logger.error('Failed to recover meetings', error));
void voice.recover().catch(error => logger.error('Failed to recover voice', error));
// The one scheduler: routines, pollers and delayed retries; jobs a stopped background left running come back
registerRecovery('jobs', () => jobs.recover());
void jobs.start();
void runRecoveries();
// Highlights used to be on by default; they go off once for every install, and the user's later choice stays
void chrome.storage.local.get('highlights-default-off').then(async ({ ['highlights-default-off']: done }) => {
  if (done) return;
  await generalSettingsStore.updateSettings({ displayHighlights: false });
  await chrome.storage.local.set({ 'highlights-default-off': true });
});

// Retention, and anything that changed while the worker was asleep
kb.scheduleSweep(10_000);

logger.info('background loaded');

// A panel is the side panel page, opened in the side panel or popped out into its own window
function isPanel(port: chrome.runtime.Port): boolean {
  const senderUrl = port.sender?.url;
  if (!senderUrl || port.sender?.id !== chrome.runtime.id) {
    return false;
  }
  const url = new URL(senderUrl);
  return `${url.origin}${url.pathname}` === SIDE_PANEL_URL;
}

/** Drafts a skill from a finished chat, with the chat's own model, for the user to review. */
async function teach(threadId: string): Promise<string> {
  const thread = await db.threads.get(threadId);
  if (!thread) throw new Error(t('threads_notFound'));
  const urls: string[] = [];
  for (const tabId of thread.boundTabIds) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) urls.push(tab.url);
  }
  const { planner } = await resolveModels(thread.model, { sessionId: threadId, notify: () => {} });
  return draftSkill(planner, teachTranscript(thread, await threadStore.messages(threadId), urls));
}

/**
 * Gemini when there is a key, else the recogniser on this computer, or as the chat says (see voice/dictation.ts). The
 * words come back corrected with the user's vocabulary, with what was changed and what is left unsure.
 */
async function transcribeWords(
  audio: string,
  threadId?: string | null,
  mediaType = 'audio/webm',
  workspaceId: string | null = null,
) {
  const thread = threadId ? await threadStore.get(threadId).catch(() => undefined) : undefined;
  return transcribeAndCorrect(
    audio,
    mediaType,
    undefined,
    thread?.voice ?? null,
    thread ? (thread.workspaceId ?? null) : workspaceId,
  );
}

/** The words only: for a video's sound, which is attached to a chat that may not exist yet. */
async function transcribe(
  audio: string,
  threadId?: string | null,
  mediaType = 'audio/webm',
  workspaceId: string | null = null,
): Promise<string> {
  return (await transcribeWords(audio, threadId, mediaType, workspaceId)).text;
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'side-panel-connection') {
    return;
  }
  if (!isPanel(port)) {
    logger.warning('Blocked unauthorized side-panel-connection', port.sender?.id, port.sender?.url);
    port.disconnect();
    return;
  }

  // A panel that closes while dictating gives the microphone back to the conversation and the wake word
  port.onDisconnect.addListener(() => releaseDictation(port));

  port.onMessage.addListener(async message => {
    const threadId = typeof message?.threadId === 'string' ? message.threadId : null;
    try {
      switch (message?.type) {
        case 'heartbeat':
          return port.postMessage({ type: 'heartbeat_ack' });

        case 'thread_send': {
          const id = await threads.send({
            threadId,
            text: String(message.text ?? ''),
            windowId: message.windowId,
            workspaceId: typeof message.workspaceId === 'string' ? message.workspaceId : null,
            attachments: await prepareAttachments(message.attachments, wav =>
              transcribe(
                wav,
                threadId,
                'audio/wav',
                typeof message.workspaceId === 'string' ? message.workspaceId : null,
              ),
            ),
          });
          return port.postMessage({ type: 'thread_started', clientId: message.clientId, threadId: id });
        }

        case 'thread_cancel':
          if (threadId) await threads.cancel(threadId);
          return;

        case 'thread_cancel_all':
          return threads.cancelAll();

        case 'confirm_action':
          // Only an explicit true approves. Anything else declines.
          if (threadId) {
            const replies = Array.isArray(message.replies)
              ? message.replies.slice(0, 20).map((reply: unknown) => String(reply ?? '').slice(0, 2000))
              : undefined;
            await threads.answer(
              threadId,
              String(message.requestId),
              message.approved === true,
              replies,
              message.always === true,
            );
          }
          return;

        case 'thread_workspace':
          if (threadId) {
            await threads.setWorkspace(threadId, typeof message.workspaceId === 'string' ? message.workspaceId : null);
            // Its knowledge moves with it
            await kb.indexThread(threadId);
          }
          return;

        case 'thread_rebind':
          if (threadId) await threads.rebind(threadId, message.windowId);
          return;

        case 'thread_continue':
          if (threadId) await threads.continueThread(threadId, message.windowId);
          return;

        case 'meeting_start': {
          const meetingId = await meetings.start({ windowId: message.windowId, withMic: message.withMic });
          return port.postMessage({ type: 'meeting_started', clientId: message.clientId, meetingId });
        }

        case 'meeting_stop':
          if (typeof message.meetingId === 'string') await meetings.stop(message.meetingId);
          return;

        case 'meeting_ask': {
          const answer = await meetings.ask(String(message.meetingId), String(message.question ?? ''));
          return port.postMessage({ type: 'meeting_answer', clientId: message.clientId, answer });
        }

        case 'meeting_summarize':
          if (typeof message.meetingId === 'string') await meetings.summarizeNow(message.meetingId);
          return;

        case 'voice_start': {
          // Every outcome is answered as voice_started, so the panel's Talk button never stays on "Connecting"
          const result = await voice
            .start(message.windowId)
            .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          return port.postMessage({ type: 'voice_started', ...result });
        }

        case 'voice_stop':
          return voice.stop();

        // Typed in the voice conversation's chat while it is on: the user's next turn in the same conversation
        case 'voice_text':
          await voice.sendText(
            String(message.text ?? '').slice(0, 20_000),
            await prepareAttachments(message.attachments, wav => transcribe(wav, threadId, 'audio/wav')),
          );
          return port.postMessage({ type: 'voice_text_sent', clientId: message.clientId });

        // A panel that opened while a conversation is on asks which chat holds it
        case 'voice_state':
          return port.postMessage({
            type: 'voice_state',
            status: voice.running ? voice.status : 'off',
            threadId: voice.currentThreadId,
          });

        case 'meeting_retry':
          if (typeof message.meetingId === 'string') await meetings.retry(message.meetingId);
          return;

        case 'thread_delete':
          if (threadId) {
            await threads.remove(threadId);
            await kb.forget('thread', threadId);
          }
          return;

        case 'kb_ask': {
          const scope = typeof message.workspaceId === 'string' ? message.workspaceId : null;
          const agent = typeof message.agentId === 'string' ? message.agentId : null;
          // The panel is the user: everything in the workspace, or one agent's items when they picked one
          const result = await kb.ask(String(message.question ?? ''), memoryScope.ava(scope, agent));
          return port.postMessage({ type: 'kb_answer', clientId: message.clientId, ...result });
        }

        case 'kb_save_page': {
          const [tab] = await chrome.tabs.query({ active: true, windowId: message.windowId });
          if (tab?.id === undefined) throw new Error(t('kb_pageUnreadable'));
          const item = await kb.savePage(
            tab.id,
            typeof message.workspaceId === 'string' ? message.workspaceId : null,
            typeof message.agentId === 'string' ? message.agentId : null,
          );
          return port.postMessage({ type: 'kb_saved', clientId: message.clientId, title: item.title });
        }

        case 'skill_teach': {
          if (!threadId) return;
          const markdown = await teach(threadId);
          return port.postMessage({ type: 'skill_draft', clientId: message.clientId, markdown });
        }

        case 'kb_delete':
          if (typeof message.itemId === 'string') await kb.remove(message.itemId);
          return;

        // Dictation in the chat box started or ended: the conversation and "Hey Ava" stop hearing the mic meanwhile
        case 'dictation_hold':
          return holdForDictation(message.on === true, port);

        case 'speech_to_text': {
          if (!message.audio) {
            return port.postMessage({ type: 'speech_to_text_error', error: t('bg_cmd_stt_noAudioData') });
          }
          try {
            const words = await transcribeWords(
              message.audio,
              message.threadId,
              'audio/webm',
              typeof message.workspaceId === 'string' ? message.workspaceId : null,
            );
            return port.postMessage({
              type: 'speech_to_text_result',
              text: words.text,
              changes: words.changes,
              unsure: words.unsure,
            });
          } catch (error) {
            logger.error('Speech-to-text failed:', error);
            // A plain sentence; the panel keeps the recording and offers to try again
            return port.postMessage({ type: 'speech_to_text_error', error: sttErrorMessage(error), retryable: true });
          }
        }

        default: {
          // Features of Wave 2 register their commands instead of growing this switch
          const handled = await dispatchCommand(message, {
            reply: reply => port.postMessage(reply),
            requestId: typeof message?.requestId === 'string' ? message.requestId : null,
          });
          if (handled) return;
          return port.postMessage({ type: 'error', threadId, error: t('errors_cmd_unknown', [String(message?.type)]) });
        }
      }
    } catch (error) {
      logger.error('Error handling panel message:', error);
      try {
        port.postMessage({
          type: 'error',
          threadId,
          clientId: message?.clientId,
          // A registered command's request gets its answer, rather than waiting for the panel's time-out
          requestId: typeof message?.requestId === 'string' ? message.requestId : undefined,
          error: error instanceof Error ? error.message : t('errors_unknown'),
        });
      } catch {
        // The panel closed before the answer came
      }
    }
  });
});
