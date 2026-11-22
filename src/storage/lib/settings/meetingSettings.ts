import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface MeetingSettingsConfig {
  // Mix the user's microphone in, so their own voice is in the notes
  includeMic: boolean;
  // Keep the audio after it is transcribed; off by default
  keepAudio: boolean;
  // The reminder to tell participants has been shown and dismissed
  consentShown: boolean;
  chunkSeconds: number;
  firstChunkSeconds: number;
  overlapSeconds: number;
  // How often the rolling summary is refreshed while recording
  summaryEverySeconds: number;
  // How long without sound before the user is warned
  silenceWarnSeconds: number;
  // Instant captions from the Gemini Live API, on top of the transcript
  liveCaptions: boolean;
  // Start notes by themselves when the user joins a call on Meet, Zoom or Teams
  autoNotes: boolean;
  // Notes that have caught nothing after this long, with captions not confirmed on, raise an alert
  nothingCapturedSeconds: number;
  // Listen on the device for "Hey Ava", which starts a voice conversation; off until the user turns it on
  wakeWord: boolean;
  liveModel: string;
  // How long a pause may be before the voice conversation counts the user as finished (Live voice only)
  turnPatience: 'quick' | 'normal' | 'patient';
  // The Live API address; tests point it at a local server
  liveEndpoint: string;
}

export const DEFAULT_MEETING_SETTINGS: MeetingSettingsConfig = {
  includeMic: true,
  keepAudio: false,
  consentShown: false,
  chunkSeconds: 30,
  firstChunkSeconds: 8,
  overlapSeconds: 2,
  summaryEverySeconds: 150,
  silenceWarnSeconds: 300,
  liveCaptions: true,
  autoNotes: true,
  nothingCapturedSeconds: 45,
  wakeWord: false,
  liveModel: 'gemini-3.8-live',
  turnPatience: 'normal',
  liveEndpoint:
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
};

export type MeetingSettingsStorage = BaseStorage<MeetingSettingsConfig> & {
  getSettings: () => Promise<MeetingSettingsConfig>;
  updateSettings: (changes: Partial<MeetingSettingsConfig>) => Promise<void>;
};

const storage = createStorage<MeetingSettingsConfig>('meeting-settings', DEFAULT_MEETING_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const meetingSettingsStore: MeetingSettingsStorage = {
  ...storage,
  async getSettings() {
    return { ...DEFAULT_MEETING_SETTINGS, ...(await storage.get()) };
  },
  async updateSettings(changes) {
    await storage.set({ ...(await meetingSettingsStore.getSettings()), ...changes });
  },
};
