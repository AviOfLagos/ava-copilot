import { t } from '@extension/i18n';
import {
  BULK_MAX_ATTACHMENT_BYTES,
  bulkAttachmentKey,
  db,
  localDay,
  parseCsv,
  prepareBatch,
  whatsappBulkDailyStore,
  whatsappBulkSettingsStore,
  workspaceStore,
} from '@extension/storage';
import type { BulkRun } from '@extension/storage';
import { jobs } from '../../jobs/runner';
import { addInboxItem } from '../../inbox/store';
import { createLogger } from '../../log';
import { whatsappSelectors } from '../selectors';
import { findWhatsappTab, probeTab } from '../tab';
import { advanceRun, settleInterrupted } from './runner';
import type { BulkDeps, BulkNote } from './runner';
import { sendToRecipient } from './send';
import type { AttachmentData } from './send';
import { ACTIVE_STATUSES, addRun, getRun, listRuns, removeRuns, updateRun } from './state';

/**
 * Bulk messages from the panel: a batch is created from a pasted or imported list, shown to the user with every
 * recipient and message, and only an explicit answer from the panel (never an agent, a routine or a timer)
 * starts it. The run then moves through jobs (kind BULK_JOB_KIND) so it survives the background stopping.
 */

const logger = createLogger('WhatsAppBulk');

export const BULK_JOB_KIND = 'whatsapp_bulk';
const jobKeyPrefix = (runId: string) => `whatsapp-bulk:${runId}:`;

// Passes started straight from a panel command, so stop can cut their wait short
const controllers = new Map<string, AbortController>();

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function nextLocalMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 1, 0, 0);
  return next.getTime();
}

async function readAttachment(runId: string): Promise<AttachmentData | null> {
  const key = bulkAttachmentKey(runId);
  const stored = (await chrome.storage.local.get(key))[key] as AttachmentData | undefined;
  return stored?.base64 ? stored : null;
}

async function note(run: BulkRun, kind: BulkNote): Promise<void> {
  const sent = run.recipients.filter(recipient => recipient.status === 'sent').length;
  const total = run.recipients.length;
  const texts: Record<BulkNote, [string, string, 'normal' | 'high']> = {
    tab_closed: [t('inbox_wa_note_tabClosed_title'), t('inbox_wa_note_tabClosed_body'), 'high'],
    logged_out: [t('inbox_wa_note_loggedOut_title'), t('inbox_wa_note_loggedOut_body'), 'high'],
    daily_cap: [
      t('inbox_wa_note_dailyCap_title'),
      t('inbox_wa_note_dailyCap_body', [String(run.settings.dailyCap)]),
      'normal',
    ],
    done: [t('inbox_wa_note_done_title'), t('inbox_wa_note_done_body', [String(sent), String(total)]), 'normal'],
    unknown_outcome: [t('inbox_wa_note_unknown_title'), t('inbox_wa_note_unknown_body'), 'high'],
  };
  const [title, body, priority] = texts[kind];
  await addInboxItem({
    source: 'whatsapp-bulk',
    externalId: `${run.id}:${kind}:${Date.now()}`,
    kind: kind === 'done' ? 'result' : 'alert',
    title,
    body,
    priority,
    workspaceId: run.workspaceId,
    runId: run.id,
  }).catch(error => logger.warning('Could not add the bulk note to the Inbox', error));
}

export const bulkDeps: BulkDeps = {
  now: () => Date.now(),
  sleep: abortableSleep,
  random: () => Math.random(),
  today: () => localDay(),
  nextDayAt: () => nextLocalMidnight(),
  async checkTab() {
    const tab = await findWhatsappTab();
    if (!tab?.id) return { ok: false, reason: 'tab_closed' };
    const probe = await probeTab(tab.id, await whatsappSelectors());
    if (probe.state === 'logged_out') return { ok: false, reason: 'logged_out' };
    return { ok: true, tabId: tab.id };
  },
  async send(tabId, recipient, run, signal) {
    const attachment = run.attachment ? await readAttachment(run.id) : null;
    if (run.attachment && !attachment) return { status: 'failed', reason: 'send_failed' };
    return sendToRecipient(tabId, recipient, await whatsappSelectors(), attachment, signal);
  },
  async scheduleAt(runId, at) {
    await jobs.schedule({ kind: BULK_JOB_KIND, key: `${jobKeyPrefix(runId)}${at}`, runAt: at, payload: { runId } });
  },
  note,
  async getDaily() {
    return (await whatsappBulkDailyStore.get()) ?? { day: '', sent: 0 };
  },
  async setDaily(count) {
    await whatsappBulkDailyStore.set(count);
  },
};

/** Runs a pass now, outside the job alarm, keeping the background awake while it works. */
function kick(runId: string): void {
  const controller = new AbortController();
  controllers.set(runId, controller);
  const keepAlive = setInterval(() => void chrome.runtime?.getPlatformInfo?.(), 20_000);
  void advanceRun(runId, bulkDeps, controller.signal)
    .catch(error => logger.error('A bulk pass failed', error))
    .finally(() => {
      clearInterval(keepAlive);
      if (controllers.get(runId) === controller) controllers.delete(runId);
    });
}

/** Starts or continues a run: a job for durability, and a pass straight away. */
async function start(runId: string): Promise<void> {
  await bulkDeps.scheduleAt(runId, Date.now());
  kick(runId);
}

async function cancelJobs(runId: string): Promise<void> {
  const keys = (await db.jobs.where('key').startsWith(jobKeyPrefix(runId)).toArray()).map(job => job.key);
  for (const key of keys) await jobs.cancel(key);
}

export interface CreateBatchInput {
  csv: string;
  template: string;
  attachment?: { name: string; type: string; base64: string } | null;
}

/**
 * Makes a batch from the list and the template, waiting for the user's approval. Only one batch may be open at a
 * time, so two runs never share the tab.
 *
 * @throws When the list cannot be used, the attachment is too big, or another batch is still open
 */
export async function createBatch(input: CreateBatchInput): Promise<BulkRun> {
  const open = (await listRuns()).find(run => [...ACTIVE_STATUSES, 'awaiting_approval'].includes(run.status));
  if (open) throw new Error(t('inbox_wa_error_batchOpen'));
  if (!input.template.trim()) throw new Error(t('inbox_wa_error_noTemplate'));
  let prepared;
  try {
    prepared = prepareBatch(parseCsv(input.csv), input.template);
  } catch {
    throw new Error(t('inbox_wa_error_noPhoneColumn'));
  }
  if (!prepared.recipients.some(recipient => recipient.status === 'pending')) {
    throw new Error(t('inbox_wa_error_noRecipients'));
  }
  const attachment = input.attachment ?? null;
  const size = attachment ? Math.floor((attachment.base64.length * 3) / 4) : 0;
  if (size > BULK_MAX_ATTACHMENT_BYTES) throw new Error(t('inbox_wa_error_attachmentTooBig'));

  const now = Date.now();
  const run: BulkRun = {
    id: crypto.randomUUID(),
    workspaceId: await workspaceStore.getDefaultWorkspaceId().catch(() => null),
    template: input.template,
    attachment: attachment ? { name: attachment.name.slice(0, 200), type: attachment.type.slice(0, 100), size } : null,
    settings: await whatsappBulkSettingsStore.getSettings(),
    recipients: prepared.recipients,
    status: 'awaiting_approval',
    approvalId: crypto.randomUUID(),
    approvedAt: null,
    sinceCooldown: 0,
    nextAt: null,
    note: prepared.unknownPlaceholders.length ? `unknown:${prepared.unknownPlaceholders.join(',')}` : '',
    createdAt: now,
    updatedAt: now,
  };
  if (attachment) await chrome.storage.local.set({ [bulkAttachmentKey(run.id)]: attachment });
  return addRun(run);
}

/**
 * The user's answer to a batch. Only the panel sends it, with the approval id it was shown; a stale or wrong id
 * changes nothing.
 */
export async function answerBatch(runId: string, approvalId: string, approved: boolean): Promise<BulkRun> {
  const run = await updateRun(runId, current => {
    if (current.status !== 'awaiting_approval' || current.approvalId !== approvalId) return null;
    return approved
      ? { ...current, status: 'running', approvedAt: Date.now(), nextAt: null, note: '' }
      : { ...current, status: 'declined', note: '' };
  });
  if (!run || run.approvalId !== approvalId) throw new Error(t('inbox_wa_error_notWaiting'));
  if (approved && run.status === 'running') await start(runId);
  if (!approved) await chrome.storage.local.remove(bulkAttachmentKey(runId));
  return run;
}

export async function pauseBatch(runId: string): Promise<void> {
  await updateRun(runId, current =>
    current.status === 'running' || current.status === 'waiting_tab'
      ? { ...current, status: 'paused', note: 'user' }
      : null,
  );
}

export async function resumeBatch(runId: string): Promise<void> {
  const run = await updateRun(runId, current =>
    current.status === 'paused' || current.status === 'waiting_tab'
      ? {
          ...current,
          status: current.note === 'daily_cap' ? 'paused' : 'running',
          note: current.note === 'daily_cap' ? 'daily_cap' : '',
        }
      : null,
  );
  if (run && (run.status === 'running' || run.note === 'daily_cap')) await start(runId);
}

export async function stopBatch(runId: string): Promise<void> {
  await updateRun(runId, current => {
    if (!([...ACTIVE_STATUSES, 'awaiting_approval'] as string[]).includes(current.status)) return null;
    for (const recipient of current.recipients) {
      if (recipient.status === 'pending') {
        recipient.status = 'skipped';
        recipient.reason = 'stopped';
      }
    }
    return { ...current, status: current.status === 'awaiting_approval' ? 'declined' : 'stopped', nextAt: null };
  });
  controllers.get(runId)?.abort();
  await cancelJobs(runId);
  await chrome.storage.local.remove(bulkAttachmentKey(runId));
}

export async function deleteBatch(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run || !['done', 'stopped', 'declined'].includes(run.status)) throw new Error(t('inbox_wa_error_stillOpen'));
  await removeRuns([runId]);
  await chrome.storage.local.remove(bulkAttachmentKey(runId));
}

/** The job's handler: one pass of the run named in the payload. */
export async function runBulkJob(payload: unknown, signal: AbortSignal): Promise<void> {
  const runId = (payload as { runId?: string } | null)?.runId;
  if (runId) await advanceRun(runId, bulkDeps, signal);
}

/** After a restart: a message cut off mid-send is settled, and every running batch gets a pass. */
export async function recoverBatches(): Promise<void> {
  for (const run of await listRuns()) {
    if (run.status !== 'running') continue;
    await settleInterrupted(run.id, bulkDeps);
    await bulkDeps.scheduleAt(run.id, Date.now());
  }
}
