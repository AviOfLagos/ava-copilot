import { t } from '@extension/i18n';
import type { ConfirmRequest, MeetingRecord, ThreadMessage, ThreadRecord } from '@extension/storage';
import type { WhatsAppMessage, WhatsAppNoticeKind, WhatsAppStatus } from '@src/shared/lib/protocol/companion';
import type { Notice } from '../notices';
import { describeRequest, toWhatsAppText } from './format';
import { mayNotify } from './notices';
import type { WhatsAppRemoteSettings, WhatsAppRemoteState } from './state';

/**
 * Ava on WhatsApp, in the background: pulls the owner's messages from Nex Brain into the day's WhatsApp chat
 * (origin 'whatsapp'), sends the chat's answer back when a turn ends, says on WhatsApp when the chat waits for
 * his click in the browser (it never approves anything from there), and passes on the moments he asked to hear
 * about. Everything it touches comes in as deps, so it is tested without Chrome or Nex Brain.
 */

export interface BridgeDeps {
  inbox: () => Promise<{ messages: WhatsAppMessage[]; status: WhatsAppStatus }>;
  ack: (ids: string[]) => Promise<void>;
  send: (request: { text: string; kind: WhatsAppNoticeKind; replyTo?: string }) => Promise<void>;
  getThread: (id: string) => Promise<ThreadRecord | undefined>;
  createThread: (fields: Partial<ThreadRecord>) => Promise<ThreadRecord>;
  messages: (threadId: string) => Promise<ThreadMessage[]>;
  // Gives the chat a background tab of its own when it has none, so it never takes the tab the user is on
  ensureTab: (thread: ThreadRecord) => Promise<void>;
  // Starts a turn in the chat with the owner's words
  startTurn: (threadId: string, text: string) => Promise<void>;
  getState: () => Promise<WhatsAppRemoteState>;
  updateState: (changes: Partial<WhatsAppRemoteState>) => Promise<unknown>;
  settings: () => Promise<WhatsAppRemoteSettings>;
  now: () => number;
  warn: (message: string, error?: unknown) => void;
}

const dayOf = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/** The answer a finished turn gave: its last planner message after the user's, else what the system said. */
export function answerOf(messages: ThreadMessage[]): ThreadMessage | null {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.actor === 'user') lastUser = index;
  });
  const turn = messages.slice(lastUser + 1).filter(message => message.content.trim());
  return (
    [...turn].reverse().find(message => message.actor === 'planner') ??
    [...turn].reverse().find(message => message.actor === 'system') ??
    null
  );
}

export class WhatsAppBridge {
  private polling: Promise<void> | null = null;
  // Notices already sent this run of the background (a key is sent once)
  private readonly sentKeys = new Set<string>();

  constructor(private readonly deps: BridgeDeps) {}

  /** Pulls and delivers; one pull at a time. */
  poll(): Promise<void> {
    this.polling ??= this.pullOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pullOnce(): Promise<void> {
    const { messages, status } = await this.deps.inbox();
    await this.deps.updateState({ status: { ...status, qr: null }, checkedAt: this.deps.now() });
    if (status.state !== 'linked' || messages.length === 0) return;

    const thread = await this.todaysThread();
    const last = messages[messages.length - 1];
    if (thread.status === 'running') return;
    if (thread.status === 'waiting_confirm') {
      const state = await this.deps.getState();
      const pending = thread.pendingRequest?.id ?? 'pending';
      if (state.waitingTold !== pending) {
        await this.deps.updateState({ waitingTold: pending });
        await this.say(t('wava_reply_stillWaiting', [describeRequest(thread.pendingRequest)]), 'reply', last.id);
      }
      return;
    }

    const text = messages
      .map(message => message.text.trim())
      .filter(Boolean)
      .join('\n\n');
    const ids = messages.map(message => message.id);
    await this.deps.updateState({ replyTo: last.id, waitingTold: null });
    try {
      await this.deps.ensureTab(thread);
      await this.deps.startTurn(thread.id, text);
    } catch (error) {
      this.deps.warn('A WhatsApp message could not start a turn', error);
      await this.deps.ack(ids);
      await this.say(
        t('wava_reply_failed', [error instanceof Error ? error.message : String(error)]),
        'reply',
        last.id,
      );
      return;
    }
    await this.deps.ack(ids);
  }

  /** The day's WhatsApp chat, made when there is none yet today. */
  private async todaysThread(): Promise<ThreadRecord> {
    const state = await this.deps.getState();
    const today = dayOf(this.deps.now());
    if (state.threadId && state.threadDay === today) {
      const thread = await this.deps.getThread(state.threadId);
      if (thread && !thread.archived) return thread;
    }
    const label = new Date(this.deps.now()).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const thread = await this.deps.createThread({
      origin: 'whatsapp',
      title: t('wava_thread_title', [label]),
      tags: ['whatsapp'],
    });
    await this.deps.updateState({ threadId: thread.id, threadDay: today });
    return thread;
  }

  /** A chat changed: a WhatsApp chat's turn ended or waits for the click; another chat waits for approval. */
  async onThreadUpdate(before: ThreadRecord, changes: Partial<ThreadRecord>): Promise<void> {
    if (!changes.status || changes.status === before.status) return;
    const thread = { ...before, ...changes };
    if (thread.origin === 'whatsapp') {
      await this.answer(thread);
      return;
    }
    if (thread.status === 'waiting_confirm' && thread.pendingRequest) {
      await this.notice({
        kind: 'approval',
        title: t('wava_notice_approval', [
          thread.title || t('wava_notice_untitled'),
          describeRequest(thread.pendingRequest),
        ]),
        key: `approval:${thread.pendingRequest.id}`,
      });
    }
  }

  private async answer(thread: ThreadRecord): Promise<void> {
    const state = await this.deps.getState();
    const replyTo = state.replyTo ?? undefined;
    if (thread.status === 'waiting_confirm') {
      const request: ConfirmRequest | null = thread.pendingRequest;
      await this.say(t('wava_reply_needsClick', [describeRequest(request)]), 'reply', replyTo);
      return;
    }
    if (thread.status === 'error') {
      await this.say(t('wava_reply_stopped', [thread.error?.message ?? '']), 'reply', replyTo);
      return;
    }
    if (thread.status !== 'idle') return;
    const answer = answerOf(await this.deps.messages(thread.id));
    const done = state.repliedSeq[thread.id] ?? 0;
    if (!answer || answer.seq <= done) return;
    await this.deps.updateState({ repliedSeq: { ...state.repliedSeq, [thread.id]: answer.seq } });
    await this.say(toWhatsAppText(answer.content, undefined, t('wava_reply_more')), 'reply', replyTo);
  }

  /** Meeting notes are ready. */
  async onMeetingUpdate(before: MeetingRecord, changes: Partial<MeetingRecord>): Promise<void> {
    if (changes.status !== 'done' || before.status === 'done') return;
    const meeting = { ...before, ...changes };
    const note = meeting.note;
    const lines = [
      ...(note?.tldr ?? []).map(line => `• ${line}`),
      ...(note?.actionItems ?? []).map(item => `☐ ${item.owner ? `${item.owner}: ` : ''}${item.task}`),
    ];
    await this.notice({
      kind: 'meeting',
      title: t('wava_notice_meeting', [note?.title || meeting.title]),
      body: lines.join('\n'),
      key: `meeting:${meeting.id}`,
    });
  }

  /** A moment he asked to hear about: sent once, when it is switched on and not in quiet hours. */
  async notice(notice: Notice): Promise<void> {
    if (this.sentKeys.has(notice.key)) return;
    const state = await this.deps.getState();
    if (state.status?.state !== 'linked') return;
    if (!mayNotify(notice.kind, await this.deps.settings(), new Date(this.deps.now()))) return;
    this.sentKeys.add(notice.key);
    const body = notice.body?.trim() ? `\n\n${notice.body.trim()}` : '';
    await this.say(toWhatsAppText(`**${notice.title}**${body}`, undefined, t('wava_reply_more')), notice.kind);
  }

  private async say(text: string, kind: WhatsAppNoticeKind, replyTo?: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    try {
      await this.deps.send({ text: body, kind, ...(replyTo ? { replyTo } : {}) });
    } catch (error) {
      // Not linked, the hourly limit, Nex Brain closed: the chat in the panel still has it
      this.deps.warn(`A WhatsApp ${kind} was not sent`, error);
    }
  }
}
