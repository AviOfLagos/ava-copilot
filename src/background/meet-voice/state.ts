import { createStorage } from '@extension/storage/lib/base/base';
import { StorageEnum } from '@extension/storage/lib/base/enums';
import type { MeetStatus } from '@src/shared/lib/protocol/companion';

/**
 * What the extension knows about Ava in a call, for the background and the meeting panel. Written by the
 * background only (from Ava Brain's answers); the panel reads it live. Nothing secret, nothing the call said.
 */
export interface MeetVoiceState {
  // Ava Brain's last answer about her meeting browser
  status: MeetStatus | null;
  // The user's meeting (its notes) she was brought into: she leaves when those notes end
  meetingId: string | null;
  // Join sessions (call code and when she got in) where she already said who she is; cleared on join and leave
  introduced: string[];
  // The last thing that went wrong, as a plain sentence
  error: string | null;
  checkedAt: number | null;
  // "Ask me": the user's call she offers to join, until they answer (the meeting panel and a notification ask)
  offer: { meetingId: string; at: number } | null;
}

export const DEFAULT_MEET_VOICE_STATE: MeetVoiceState = {
  status: null,
  meetingId: null,
  introduced: [],
  error: null,
  checkedAt: null,
  offer: null,
};

const storage = createStorage<MeetVoiceState>('meet-voice-state', DEFAULT_MEET_VOICE_STATE, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const meetVoiceStore = {
  ...storage,
  async getState(): Promise<MeetVoiceState> {
    return { ...DEFAULT_MEET_VOICE_STATE, ...(await storage.get()) };
  },
  async update(changes: Partial<MeetVoiceState>): Promise<MeetVoiceState> {
    const next = { ...(await meetVoiceStore.getState()), ...changes };
    // Only the most recent calls are remembered
    next.introduced = next.introduced.slice(-20);
    await storage.set(next);
    return next;
  },
};

/** Whether she is on her way into a call or in one. */
export const isInOrJoining = (status: MeetStatus | null | undefined): boolean =>
  status?.state === 'joining' || status?.state === 'waiting_admission' || status?.state === 'in_call';

/**
 * Whether Ava joins the Google Meet calls the user takes notes in: never (the default: she joins only when asked in
 * the call's notes), after asking ("Bring Ava into this call?"), or always. Only ever a call the user is in.
 */
export type MeetAutoJoin = 'never' | 'ask' | 'always';
export const MEET_AUTO_JOIN: MeetAutoJoin[] = ['never', 'ask', 'always'];

export interface MeetVoiceSettings {
  autoJoin: MeetAutoJoin;
}

export const DEFAULT_MEET_VOICE_SETTINGS: MeetVoiceSettings = { autoJoin: 'never' };

const settingsStorage = createStorage<MeetVoiceSettings>('meet-voice-settings', DEFAULT_MEET_VOICE_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const meetVoiceSettingsStore = {
  ...settingsStorage,
  async getSettings(): Promise<MeetVoiceSettings> {
    const saved = { ...DEFAULT_MEET_VOICE_SETTINGS, ...(await settingsStorage.get()) };
    return MEET_AUTO_JOIN.includes(saved.autoJoin) ? saved : DEFAULT_MEET_VOICE_SETTINGS;
  },
  async update(changes: Partial<MeetVoiceSettings>): Promise<MeetVoiceSettings> {
    const next = { ...(await meetVoiceSettingsStore.getSettings()), ...changes };
    await settingsStorage.set(next);
    return next;
  },
};
