import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import type { WhatsAppStatus } from '@src/shared/lib/protocol/companion';
import type { NoticeKind } from '../notices';

/**
 * Ava on WhatsApp, in the extension: what the user chose (which moments Ava messages him about, quiet hours) and
 * where the conversation stands (the day's chat, what was answered). Nothing secret: the code to scan is never
 * stored, and the messages themselves live in the chat like any other.
 */

export interface WhatsAppRemoteSettings {
  // Which moments she messages him about first
  notify: Record<NoticeKind, boolean>;
  // No messages first in this window ("HH:MM", may wrap past midnight); approvals still go
  quietStart: string;
  quietEnd: string;
}

export const DEFAULT_WHATSAPP_REMOTE_SETTINGS: WhatsAppRemoteSettings = {
  notify: { approval: true, meeting: true, brief: true, routine: true },
  quietStart: '22:00',
  quietEnd: '07:00',
};

export interface WhatsAppRemoteState {
  // The last status Nex Brain gave, without the code to scan
  status: WhatsAppStatus | null;
  checkedAt: number | null;
  // The chat WhatsApp messages go to: one a day
  threadId: string | null;
  threadDay: string | null;
  // The owner message the running turn answers, so the answer goes back to his chat
  replyTo: string | null;
  // The newest message of each chat already sent back
  repliedSeq: Record<string, number>;
  // The pending request he was already told about while a new message waited
  waitingTold: string | null;
}

export const DEFAULT_WHATSAPP_REMOTE_STATE: WhatsAppRemoteState = {
  status: null,
  checkedAt: null,
  threadId: null,
  threadDay: null,
  replyTo: null,
  repliedSeq: {},
  waitingTold: null,
};

const settingsStorage = createStorage<WhatsAppRemoteSettings>(
  'whatsapp-remote-settings',
  DEFAULT_WHATSAPP_REMOTE_SETTINGS,
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

const stateStorage = createStorage<WhatsAppRemoteState>('whatsapp-remote-state', DEFAULT_WHATSAPP_REMOTE_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const whatsappRemoteSettingsStore = {
  ...settingsStorage,
  async getSettings(): Promise<WhatsAppRemoteSettings> {
    const saved = (await settingsStorage.get()) ?? DEFAULT_WHATSAPP_REMOTE_SETTINGS;
    return {
      ...DEFAULT_WHATSAPP_REMOTE_SETTINGS,
      ...saved,
      notify: { ...DEFAULT_WHATSAPP_REMOTE_SETTINGS.notify, ...saved.notify },
    };
  },
  async update(changes: Partial<WhatsAppRemoteSettings>): Promise<WhatsAppRemoteSettings> {
    const next = { ...(await whatsappRemoteSettingsStore.getSettings()), ...changes };
    await settingsStorage.set(next);
    return next;
  },
};

export const whatsappRemoteStateStore = {
  ...stateStorage,
  async getState(): Promise<WhatsAppRemoteState> {
    return { ...DEFAULT_WHATSAPP_REMOTE_STATE, ...(await stateStorage.get()) };
  },
  async update(changes: Partial<WhatsAppRemoteState>): Promise<WhatsAppRemoteState> {
    const next = { ...(await whatsappRemoteStateStore.getState()), ...changes };
    await stateStorage.set(next);
    return next;
  },
};

export const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
