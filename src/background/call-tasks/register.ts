// "Ava, note a task for Ada" on a call (docs/pm-desk.md, Part 6): hearing it, the after-call list's commands, and the
// seams for the follow-ups part (#111). Imported once from ../registers.ts.
import { z } from 'zod';
import { t } from '@extension/i18n';
import { AppError, toAppError } from '@extension/shared';
import {
  localSttChoice,
  meetingStore,
  peopleStore,
  recordTask,
  taskStore,
  voiceEngineSettingsStore,
} from '@extension/storage';
import type { CallListRow, CallTasksState, MeetingRecord } from '@extension/storage';
import { createLogger } from '../log';
import { answerOneOff, registerCommand, registerOffscreenBusy } from '../registry';
import { ensureOffscreen } from '../offscreen';
import { CALL_DOM } from '../meetings/captions';
import { people } from '../people/people';
import { correctedText } from '../voice/vocabulary';
import { installedVoiceModels } from '../voice/engines/models';
import { shareRecordingsFor } from '../recordings/share';
import { shareDeps } from '../recordings/service';
import { sendPersonTaskList, taskDesk } from '../whatsapp-remote/register';
import { findWhatsappTab, probeTab, runInTab } from '../whatsapp/tab';
import { whatsappSelectors } from '../whatsapp/selectors';
import { openChatByName, typeInComposer } from '../whatsapp/page';
import { CallCommandEngine } from './engine';
import { decideSignal, labelledAsSelf } from './signal';
import { callState } from './state';
import {
  addCallListRows as addRows,
  callTasksOf,
  confirmCallTasks,
  groupByPerson,
  onCallTasksConfirmed,
  onCallListRowAction,
  personMessage,
  runCallListRowAction,
} from './after';
import type { ConfirmDeps } from './after';
import { OFFSCREEN_CALL_MIC_TARGET } from './wire';

const logger = createLogger('CallTasks');

// Caption lines this recent mean the call shows captions (audio notes read them for speaker names)
const CAPTIONS_LATELY_MS = 60_000;
const RECONCILE_EVERY_MS = 3_000;
const ALARM = 'call-tasks-check';

const engine = new CallCommandEngine({
  now: Date.now,
  meeting: async id => {
    const meeting = await meetingStore.get(id);
    return meeting
      ? { workspaceId: meeting.workspaceId ?? null, recording: meeting.status === 'recording' }
      : undefined;
  },
  state: callState,
  tasks: {
    record: candidate => recordTask(candidate),
    add: candidate =>
      taskStore.add({
        title: candidate.title,
        workspaceId: candidate.workspaceId ?? null,
        workspaceSetBy: 'rule',
        ownerId: candidate.ownerId ?? null,
        ownerName: candidate.ownerName ?? null,
        source: candidate.source,
      }),
    get: id => taskStore.get(id),
    update: (id, changes) => taskStore.update(id, changes),
  },
  people: {
    resolve: (text, options) => people.resolve(text, options),
    observe: input => people.observe(input),
  },
  correct: (text, options) => correctedText(text, options),
});

// ---- Which signal counts, and the microphone stream for commands ------------------------------------------------

const lastCaptionAt = new Map<string, number>();
let micFor: string | null = null;

async function localStt() {
  return localSttChoice(await voiceEngineSettingsStore.getSettings(), await installedVoiceModels());
}

async function toCallMic<T>(message: Record<string, unknown>): Promise<T | null> {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage({ ...message, target: OFFSCREEN_CALL_MIC_TARGET })) as T;
    } catch (error) {
      if (attempt >= 10 || !String(error).includes('Receiving end does not exist')) return null;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

async function stopMic(): Promise<void> {
  if (!micFor) return;
  const meetingId = micFor;
  micFor = null;
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (open.length) {
    await chrome.runtime
      .sendMessage({ target: OFFSCREEN_CALL_MIC_TARGET, type: 'call_mic_stop', meetingId })
      .catch(() => {});
  }
}

let reconciling: Promise<void> | null = null;
let reconciledAt = 0;

/** Brings the call's signal (and the microphone stream) in line with how its notes are taken now. */
function reconcile(force = false): Promise<void> {
  if (reconciling) return reconciling;
  if (!force && Date.now() - reconciledAt < RECONCILE_EVERY_MS) return Promise.resolve();
  reconciling = reconcileOnce()
    .catch(error => logger.warning('Could not check how commands are heard on the call', toAppError(error).kind))
    .finally(() => {
      reconciling = null;
      reconciledAt = Date.now();
    });
  return reconciling;
}

async function reconcileOnce(): Promise<void> {
  const recording = (await meetingStore.active()).find(meeting => meeting.status === 'recording');
  if (!recording) {
    // The check runs only while a call is noted: no wake-ups otherwise
    await chrome.alarms.clear(ALARM).catch(() => false);
    await stopMic();
    for (const id of lastCaptionAt.keys()) engine.forget(id);
    lastCaptionAt.clear();
    return;
  }
  if (!(await chrome.alarms.get(ALARM).catch(() => undefined))) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  }
  if (micFor && micFor !== recording.id) await stopMic();
  const state = recording.callTasks;
  const stt = await localStt().catch(() => null);
  const decision = decideSignal({
    source: recording.source,
    captionsOn: recording.captionsOn,
    withMic: recording.withMic,
    localStt: !!stt,
    micFailed: state?.micFailed,
    captionsLately: Date.now() - (lastCaptionAt.get(recording.id) ?? 0) < CAPTIONS_LATELY_MS,
    selfMarkerMissing: state?.selfMarkerMissing,
    selfLineSeen: state?.selfLineSeen,
    selfMarkerOnOthers: state?.selfMarkerOnOthers,
  });
  if (decision.wantMic && micFor !== recording.id && stt) {
    const reply = await toCallMic<{ ok?: boolean; micDenied?: boolean; error?: string }>({
      type: 'call_mic_start',
      meetingId: recording.id,
      stt,
    });
    if (!reply?.ok) {
      logger.info('The microphone for spoken commands did not start', reply?.error ?? '');
      await callState.change(recording.id, current => ({
        ...current,
        micFailed: reply?.micDenied ? 'denied' : 'failed',
      }));
      return reconcileOnce();
    }
    micFor = recording.id;
  }
  if (!decision.wantMic && micFor) await stopMic();
  if (state?.signal !== decision.signal || state?.offReason !== decision.offReason) {
    await callState.change(recording.id, current => {
      const next: CallTasksState = { ...current, signal: decision.signal };
      if (decision.offReason) next.offReason = decision.offReason;
      else delete next.offReason;
      return next;
    });
  }
}

registerOffscreenBusy('call-tasks-mic', async () => {
  if (!micFor) return false;
  return (await meetingStore.get(micFor))?.status === 'recording';
});

// After the background restarts mid-call, and to start the check when a call's notes are already running
void reconcile(true);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void reconcile(true);
});

// ---- Readings --------------------------------------------------------------------------------------------------

const lineSchema = z.object({
  speaker: z.string().max(200).catch(''),
  text: z.string().max(10_000),
  self: z.boolean().optional(),
  key: z.number().int().nonnegative().optional(),
  whole: z.string().max(20_000).optional(),
  settled: z.boolean().optional(),
});

/** Caption lines from the call's own page. Only lines the page marks as the user's own can be a command. */
async function onCaptionLines(meetingId: string, raw: unknown[], tabId: number | undefined): Promise<void> {
  const meeting = await meetingStore.get(meetingId);
  if (!meeting || meeting.status !== 'recording' || tabId === undefined || meeting.tabId !== tabId) return;
  const lines = raw.flatMap(line => {
    const parsed = lineSchema.safeParse(line);
    return parsed.success ? [parsed.data] : [];
  });
  if (!lines.length) return;
  const now = Date.now();
  lastCaptionAt.set(meetingId, now);
  await noteSelfMarks(meeting, lines);
  await reconcile(true);
  for (const line of lines) {
    void engine.heard({
      meetingId,
      // Lines with no block key (other platforms' captions) are never the user's own
      key: line.key !== undefined ? `cap:${line.key}` : 'cap:none',
      text: line.whole ?? line.text,
      at: now,
      settled: line.settled !== false,
      self: ownLine(line),
      signal: 'captions',
    });
  }
}

/** The user's own line: the page marks it as theirs and labels it as theirs ("You"). Never the name alone. */
const ownLine = (line: z.infer<typeof lineSchema>) =>
  line.self === true && line.key !== undefined && labelledAsSelf(line.speaker, CALL_DOM.selfNames);

/**
 * Whether the page's own-line mark works on this call. A marked "You" line proves it does. A "You" line with no
 * mark, before any marked one, means it is missing; a marked line with another speaker's name means it is not
 * about whose line it is (that one is for the whole call). Either way captions cannot make commands on this call.
 */
async function noteSelfMarks(meeting: MeetingRecord, lines: z.infer<typeof lineSchema>[]): Promise<void> {
  const state = meeting.callTasks;
  const own = lines.some(ownLine);
  const unmarkedSelf = lines.some(line => line.self !== true && labelledAsSelf(line.speaker, CALL_DOM.selfNames));
  const markedOther = lines.some(
    line => line.self === true && !!line.speaker.trim() && !labelledAsSelf(line.speaker, CALL_DOM.selfNames),
  );
  if (markedOther && !state?.selfMarkerOnOthers) {
    await callState.change(meeting.id, current => ({ ...current, selfMarkerOnOthers: true }));
  } else if (own && !state?.selfLineSeen) {
    await callState.change(meeting.id, current => ({ ...current, selfLineSeen: true }));
  } else if (unmarkedSelf && !state?.selfLineSeen && !state?.selfMarkerMissing) {
    await callState.change(meeting.id, current => ({ ...current, selfMarkerMissing: true }));
  }
}

const speechSchema = z.object({
  key: z.string().regex(/^mic:\d{1,15}-\d{1,9}$/),
  text: z.string().min(1).max(5000),
  startedAt: z.number(),
  endedAt: z.number(),
});

async function onMicSpeech(meetingId: string, message: unknown): Promise<void> {
  const parsed = speechSchema.safeParse(message);
  if (!parsed.success || micFor !== meetingId) return;
  const now = Date.now();
  await engine.heard({
    meetingId,
    key: parsed.data.key,
    text: parsed.data.text,
    at: Math.min(now, parsed.data.endedAt),
    startedAt: Math.min(now, parsed.data.startedAt),
    settled: true,
    self: true,
    signal: 'mic',
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  const meetingId = typeof message?.meetingId === 'string' ? message.meetingId : null;
  if (!meetingId) return;
  if (message.type === 'meeting_captions' && Array.isArray(message.lines)) {
    void onCaptionLines(meetingId, message.lines, sender.tab?.id).catch(error =>
      logger.warning('Could not read the call for commands', toAppError(error).kind),
    );
  } else if (message.type === 'meeting_call_speech') {
    // From the offscreen document only, never a page
    if (sender.tab || sender.url !== chrome.runtime.getURL('offscreen.html')) return;
    void onMicSpeech(meetingId, message).catch(error =>
      logger.warning('Could not read the microphone for commands', toAppError(error).kind),
    );
  } else if (message.type === 'meeting_chunk') {
    void reconcile();
  }
  return;
});

// ---- After the call --------------------------------------------------------------------------------------------

const confirmDeps: ConfirmDeps = {
  state: callState,
  tasks: { get: id => taskStore.get(id) },
  people: async () => new Map((await peopleStore.list()).map(person => [person.id, person])),
  share: taskIds => shareRecordingsFor(shareDeps, taskIds),
  send: input =>
    input.owner
      ? taskDesk.sendTaskList({
          key: input.key,
          title: input.title,
          taskIds: input.taskIds,
          ...(input.note ? { note: input.note } : {}),
          ...(input.links?.length ? { links: input.links } : {}),
          hint: false,
          owner: true,
        })
      : sendPersonTaskList({
          key: input.key,
          name: input.name,
          taskIds: input.taskIds,
          ...(input.note ? { note: input.note } : {}),
          ...(input.links?.length ? { links: input.links } : {}),
        }),
  text: {
    selfName: t('calltasks_you'),
    allTitle: t('calltasks_wa_allTitle'),
    recordingsNote: t('calltasks_wa_recordings'),
  },
  now: Date.now,
  warn: (message, error) => logger.warning(message, toAppError(error).kind),
};

/**
 * Types one person's tasks into their chat in Avi's WhatsApp Web tab and stops: he presses send. Only after "Looks
 * right". The chat must be the one asked for: the words are typed only once its header says so.
 */
async function draftFor(meetingId: string, personKey: string): Promise<{ chat: string }> {
  const meeting = await meetingStore.get(meetingId);
  const state = meeting?.callTasks;
  if (!meeting || !state) throw new AppError('not_found', t('meeting_notFound'));
  if (!state.confirmedAt) throw new AppError('invalid', t('calltasks_draft_notYet'));
  const tasks = (await callTasksOf(state, id => taskStore.get(id))).filter(task => task.status === 'open');
  const group = groupByPerson(tasks, await confirmDeps.people(), t('calltasks_you')).find(
    candidate => candidate.key === personKey,
  );
  if (!group || group.key === 'me') throw new AppError('not_found', t('calltasks_draft_nobody'));

  const tab = await findWhatsappTab();
  if (!tab?.id) throw new AppError('not_found', t('calltasks_draft_noTab'));
  const sel = await whatsappSelectors();
  const probe = await probeTab(tab.id, sel);
  if (probe.state === 'logged_out') throw new AppError('auth', t('calltasks_draft_loggedOut'));
  const opened = await runInTab(tab.id, openChatByName, { sel, name: group.name });
  if (!opened?.ok) throw new AppError('not_found', t('calltasks_draft_noChat', [group.name]));
  const shown = (await probeTab(tab.id, sel)).header.trim();
  if (!shown || shown.toLowerCase() !== group.name.trim().toLowerCase()) {
    throw new AppError('invalid', t('calltasks_draft_wrongChat', [shown || '?', group.name]));
  }
  const typed = await runInTab(tab.id, typeInComposer, {
    sel,
    text: personMessage(group, t('calltasks_draft_greeting', [group.name])),
  });
  if (!typed?.ok) throw new AppError('not_found', t('calltasks_draft_noBox'));
  await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { chat: shown };
}

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'calltasks_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

const meetingId = z.string().min(1).max(100);
const taskId = z.string().regex(/^tsk_[a-z2-7]{10}$/);

// The card's "Record the screen for this?": No hides the offer; Yes is the panel's own click, which started the
// recording through the recording feature, and only says so here
command('calltasks_record_answer', z.object({ meetingId, taskId, answer: z.enum(['yes', 'no']) }), async input => {
  await callState.change(input.meetingId, state => ({
    ...state,
    tasks: state.tasks.map(entry => (entry.taskId === input.taskId ? { ...entry, recordOffer: input.answer } : entry)),
  }));
});

// "Looks right": the only way anything from the call is sent or shared
command('calltasks_confirm', z.object({ meetingId }), async input => {
  // After the call only: what is said later would not be in the messages
  if ((await meetingStore.get(input.meetingId))?.status === 'recording') {
    throw new AppError('invalid', t('calltasks_confirm_duringCall'));
  }
  const state = await confirmCallTasks(input.meetingId, confirmDeps);
  return { sent: state.sent ?? [] };
});

command('calltasks_draft', z.object({ meetingId, personKey: z.string().min(1).max(200) }), input =>
  draftFor(input.meetingId, input.personKey),
);

// Only pages of the extension send these, never a web page and never an agent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (typeof message?.type !== 'string' || !message.type.startsWith('calltasks_')) return;
  return answerOneOff(message, sendResponse);
});

// ---- Seams for the follow-ups part (#111) ----------------------------------------------------------------------

/** Adds rows (such as "Mark done?") under the people of a call's after-call list. */
export function addCallListRows(meeting: string, rows: CallListRow[], options: { replaceKind?: string } = {}) {
  return addRows(callState, meeting, rows, options);
}

// A row's button: only the meeting and the row id come from the panel (see `onCallListRowAction`)
command('calltasks_row_action', z.object({ meetingId, rowId: z.string().min(1).max(200) }), async input => {
  await runCallListRowAction(callState, input.meetingId, input.rowId);
});

export { onCallListRowAction, onCallTasksConfirmed };
