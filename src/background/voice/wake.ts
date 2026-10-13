import {
  assistantNameOf,
  chooseWakePhrase,
  generalSettingsStore,
  loadWakeVocabulary,
  meetingSettingsStore,
} from '@extension/storage';
import { createLogger } from '../log';
import { closeOffscreenIfIdle, ensureOffscreen, toOffscreen } from '../offscreen';
import type { VoiceManager } from './manager';
import { soundRecently, watchSound } from './sound';

const logger = createLogger('WakeWord');

export const WAKE_ALARM = 'wake-check';

type StartResult = { ok?: boolean; error?: string; micDenied?: boolean };

/** Asks the offscreen document to listen; a document opened a moment ago may not be taking messages yet. */
async function startListening(words: string[]): Promise<StartResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await toOffscreen<StartResult>({ type: 'wake_start', words });
    } catch (error) {
      if (attempt >= 10 || !String(error).includes('Receiving end does not exist')) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/** The words after "hey" for the user's assistant name, or "ava" when the model does not know them all. */
async function wakeWords(): Promise<string[]> {
  const { assistantName } = await generalSettingsStore.getSettings();
  const choice = chooseWakePhrase(assistantName, await loadWakeVocabulary());
  if (!choice.followsName) logger.info('The wake phrase stays "hey ava"; the model does not know', choice.missing);
  return choice.words;
}

/**
 * Keeps the on-device "Hey Ava" listener running while the setting is on: through restarts of the
 * browser and of the background, and with the side panel closed. Hearing it starts a voice
 * conversation in the window the user is in.
 */
export class WakeWord {
  constructor(private readonly voice: VoiceManager) {}

  start(): void {
    watchSound();
    void chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === WAKE_ALARM) void this.sync();
    });
    chrome.runtime.onStartup.addListener(() => void this.sync());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // A new assistant name can change the phrase: the listener restarts with it
      const general = changes['general-settings'] as
        { oldValue?: { assistantName?: string }; newValue?: { assistantName?: string } } | undefined;
      if (
        changes['meeting-settings'] ||
        (general && general.oldValue?.assistantName !== general.newValue?.assistantName)
      )
        void this.sync();
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message?.type === 'wake_word') void this.heard();
      if (message?.type === 'wake_sync') {
        // Settings asks, to show why listening did not start
        void this.sync().then(sendResponse);
        return true;
      }
      return;
    });
    void this.sync();
  }

  /** Starts or stops the listener to match the setting. */
  async sync(): Promise<{ ok: boolean; error?: string; micDenied?: boolean }> {
    const { wakeWord } = await meetingSettingsStore.getSettings();
    try {
      if (wakeWord) {
        await ensureOffscreen();
        const result = await startListening(await wakeWords());
        if (!result?.ok) logger.warning('The wake word listener did not start', result?.error);
        return { ok: !!result?.ok, error: result?.error, micDenied: result?.micDenied };
      }
      const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
      if (open.length) {
        await toOffscreen({ type: 'wake_stop' }).catch(() => {});
        await closeOffscreenIfIdle();
      }
      return { ok: true };
    } catch (error) {
      logger.error('Wake word sync failed', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async heard(): Promise<void> {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
    // Sound from a tab (a video, a call) can say "Hey Ava" too: then each action needs a click
    const result = await this.voice
      .start(window?.id, { wake: true, guarded: await soundRecently() })
      .catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (!result.ok) {
      logger.warning('Hey Ava was heard but the conversation did not start', result.error);
      // Listen again, and say why nothing answered
      await toOffscreen({ type: 'voice_stop' }).catch(() => {});
      await chrome.notifications
        .create('wake-failed', {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon-128.png'),
          title: `${assistantNameOf((await generalSettingsStore.getSettings()).assistantName)} could not start`,
          message: result.error ?? 'The voice conversation did not start.',
          priority: 1,
        })
        .catch(() => {});
    }
  }
}
