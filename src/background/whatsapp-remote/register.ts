// Ava on WhatsApp (through Ava Brain) registers its commands, poll job, chat hooks and notice sink here
// (see ../registry and ../jobs/runner). Plan A, Ava inside the user's WhatsApp Web tab, is ../whatsapp.
import { z } from 'zod';
import { t } from '@extension/i18n';
import { db, threadStore } from '@extension/storage';
import type { MeetingRecord, ThreadRecord } from '@extension/storage';
import { toAppError } from '@extension/shared';
import { WHATSAPP_NUMBER } from '@src/shared/lib/protocol/companion';
import type { WhatsAppStatus } from '@src/shared/lib/protocol/companion';
import { companionClient } from '../companion/client';
import { brainSettingsStore } from '../companion/state';
import { jobs, registerJobHandler } from '../jobs/runner';
import { createLogger } from '../log';
import { transcribeLocalFirst } from '../voice/dictation';
import { registerNoticeSink } from '../notices';
import { registerCommand, registerRecovery } from '../registry';
import { services } from '../registry/services';
import { WhatsAppBridge } from './bridge';
import { photoAttachment } from './media';
import { HHMM, whatsappRemoteSettingsStore, whatsappRemoteStateStore } from './state';

const logger = createLogger('WhatsAppRemote');

const POLL_JOB = 'whatsapp_remote_poll';
const POLL_KEY = 'whatsapp-remote:poll';
// Every minute, so a worker that slept picks up what came meanwhile
const POLL_CRON = '* * * * *';
// While the worker runs: every few seconds when linked
const POLL_MS = 5000;
// When not linked, the minute job is enough
const IDLE_RECHECK_MS = 60_000;
// Where a WhatsApp chat's own background tab starts
const START_URL = 'https://www.google.com/';

/** A background tab for the chat when its own is gone: never the tab the user is on, never an incognito window. */
async function ensureTab(thread: ThreadRecord): Promise<void> {
  for (const id of thread.boundTabIds ?? []) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && !tab.incognito) return;
  }
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  let tabId: number | undefined;
  if (window?.id !== undefined && !window.incognito) {
    tabId = (await chrome.tabs.create({ url: START_URL, active: false, windowId: window.id })).id;
  } else {
    const created = await chrome.windows.create({ url: START_URL, focused: false });
    tabId = created?.tabs?.[0]?.id;
  }
  if (tabId === undefined) throw new Error(t('wava_error_noTab'));
  await threadStore.update(thread.id, { boundTabIds: [tabId], boundGroupId: null, boundUrl: START_URL });
}

export const whatsappBridge = new WhatsAppBridge({
  inbox: () => companionClient.whatsappInbox(),
  ack: async ids => {
    if (ids.length) await companionClient.whatsappAck(ids);
  },
  send: async request => {
    await companionClient.whatsappSend({ requestId: crypto.randomUUID(), ...request });
  },
  getThread: id => threadStore.get(id),
  createThread: fields => threadStore.create(fields),
  messages: id => threadStore.messages(id),
  ensureTab,
  startTurn: async (threadId, turn) => {
    await services().threads.send({
      threadId,
      text: turn.text,
      origin: 'whatsapp',
      attachments: turn.attachments,
      context: turn.context,
    });
  },
  media: request => companionClient.whatsappMedia(request),
  transcribe: (base64, mediaType) => transcribeLocalFirst(base64, mediaType),
  toAttachment: photo => photoAttachment(photo),
  saveDocument: async doc => {
    await services().kb.saveDocument(doc);
  },
  getState: () => whatsappRemoteStateStore.getState(),
  updateState: changes => whatsappRemoteStateStore.update(changes),
  settings: () => whatsappRemoteSettingsStore.getSettings(),
  now: Date.now,
  warn: (message, error) => logger.warning(message, toAppError(error).kind),
});

/** Polls Ava Brain when it is paired: always on the minute job, every few seconds while linked. */
async function tick(fromJob: boolean): Promise<void> {
  if (!(await brainSettingsStore.getSettings()).paired) return;
  if (!fromJob) {
    const state = await whatsappRemoteStateStore.getState();
    const linked = state.status?.state === 'linked';
    if (!linked && Date.now() - (state.checkedAt ?? 0) < IDLE_RECHECK_MS) return;
  }
  await whatsappBridge.poll().catch(error => {
    const appError = toAppError(error);
    // Ava Brain closed or not linked: the next tick tries again
    if (appError.kind !== 'network') logger.warning(`WhatsApp poll failed (${appError.kind})`);
  });
}

setInterval(() => void tick(false), POLL_MS);

registerJobHandler(POLL_JOB, async () => {
  await tick(true);
});

registerRecovery('whatsapp-remote', async () => {
  await jobs.schedule({ kind: POLL_JOB, key: POLL_KEY, cron: POLL_CRON, catchUpMs: 60_000 });
  if ((await brainSettingsStore.getSettings()).paired) void pushQuietHours().catch(() => {});
  void tick(true);
});

// Chats and meetings change inside Dexie transactions: the follow-up runs after the write
db.threads.hook('updating', (changes: Partial<ThreadRecord>, _key, before: ThreadRecord) => {
  if (!changes.status) return;
  setTimeout(() => {
    void whatsappBridge
      .onThreadUpdate(before, changes)
      .then(() => {
        // Messages that came while the chat was busy go in now
        if (before.origin === 'whatsapp' && changes.status === 'idle') void tick(true);
      })
      .catch(error => logger.warning('WhatsApp chat follow-up failed', error));
  });
});
db.meetings.hook('updating', (changes: Partial<MeetingRecord>, _key, before: MeetingRecord) => {
  if (changes.status !== 'done') return;
  setTimeout(() => {
    void whatsappBridge.onMeetingUpdate(before, changes).catch(() => {});
  });
});

registerNoticeSink('whatsapp', notice => whatsappBridge.notice(notice));

// ── Panel commands ──

function command<S extends z.ZodType>(
  type: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<Record<string, unknown> | void>,
): void {
  registerCommand(type, schema, async (input, context) => {
    try {
      const result = (await run(input)) ?? {};
      context.reply({ type: 'wava_ok', requestId: context.requestId, ...result });
    } catch (error) {
      const appError = toAppError(error);
      logger.warning(`${type} failed (${appError.kind})`);
      context.reply({ type: 'error', requestId: context.requestId, error: appError.message });
    }
  });
}

/** The status for the panel: the code to scan goes only in the reply, never in storage. */
async function withStatus(call: Promise<{ status: WhatsAppStatus }>) {
  const { status } = await call;
  await whatsappRemoteStateStore.update({ status: { ...status, qr: null }, checkedAt: Date.now() });
  return { status, settings: await whatsappRemoteSettingsStore.getSettings() };
}

/** Tells Ava Brain the quiet hours, so it holds to them whatever the extension does. */
async function pushQuietHours(): Promise<void> {
  const { quietStart, quietEnd } = await whatsappRemoteSettingsStore.getSettings();
  await companionClient.whatsappSetQuiet({ quietStart, quietEnd });
}

command('wava_status', z.object({}), () => withStatus(companionClient.whatsappStatus()));
command('wava_link', z.object({}), async () => {
  await pushQuietHours().catch(() => {});
  return withStatus(companionClient.whatsappLink());
});
command('wava_unlink', z.object({}), async () => {
  const result = await withStatus(companionClient.whatsappUnlink());
  await whatsappRemoteStateStore.update({ replyTo: null, waitingTold: null });
  return result;
});
command('wava_connect', z.object({}), () => withStatus(companionClient.whatsappConnect()));
command('wava_restart', z.object({}), () => withStatus(companionClient.whatsappRestart()));
command('wava_owner', z.object({ number: z.string().regex(WHATSAPP_NUMBER).nullable() }), ({ number }) =>
  withStatus(companionClient.whatsappSetOwner(number)),
);
command(
  'wava_settings',
  z.object({
    notify: z
      .object({ approval: z.boolean(), meeting: z.boolean(), brief: z.boolean(), routine: z.boolean() })
      .partial()
      .optional(),
    quietStart: z.string().regex(HHMM).optional(),
    quietEnd: z.string().regex(HHMM).optional(),
  }),
  async ({ notify, quietStart, quietEnd }) => {
    const current = await whatsappRemoteSettingsStore.getSettings();
    const settings = await whatsappRemoteSettingsStore.update({
      notify: { ...current.notify, ...notify },
      ...(quietStart ? { quietStart } : {}),
      ...(quietEnd ? { quietEnd } : {}),
    });
    if (quietStart || quietEnd) await pushQuietHours();
    return { settings };
  },
);
command('wava_test', z.object({}), async () => {
  const { status } = await companionClient.whatsappSend({
    requestId: crypto.randomUUID(),
    text: t('wava_test_message'),
    kind: 'reply',
  });
  await whatsappRemoteStateStore.update({ status: { ...status, qr: null }, checkedAt: Date.now() });
});
