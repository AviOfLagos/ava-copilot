import { audioDeviceSettingsStore } from '@extension/storage';
import { offscreenBusyAnywhere } from './registry';
/**
 * The one offscreen document, shared by the meeting recorder and the voice session. It closes only
 * when neither is using it.
 */

const OFFSCREEN_URL = 'offscreen.html';

// One creation at a time: two callers at once (the wake word turned on while a voice session starts) would both
// see no document and both create one, and Chrome refuses the second ("Only a single offscreen document…")
let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  if (!creating) {
    creating = createOffscreen().finally(() => {
      creating = null;
    });
  }
  return creating;
}

async function createOffscreen(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (open.length === 0) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Records meetings and holds the voice conversation with the copilot',
      });
    } catch (error) {
      // Another context of this extension opened it meanwhile: the document is there, which is all that was asked
      if (!/single offscreen document/i.test(error instanceof Error ? error.message : String(error))) throw error;
      return;
    }
    // The chosen microphone/speaker (Settings › Voice devices): read here, not in the offscreen
    // document itself, which must stay free of @extension/storage imports (see src/offscreen/index.ts
    // for why) — pushed once right after creation, before anything else is asked to start.
    void pushAudioDeviceSettings();
  }
}

/** Tells the offscreen document which microphone/speaker to use; a no-op if it never answers. */
export async function pushAudioDeviceSettings(): Promise<void> {
  const settings = await audioDeviceSettingsStore.getSettings();
  await toOffscreen({
    type: 'audio_devices_apply',
    micDeviceId: settings.mic?.deviceId ?? null,
    speakerDeviceId: settings.speaker?.deviceId ?? null,
  }).catch(() => {});
}

export async function toOffscreen<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

export async function closeOffscreenIfIdle(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (open.length === 0) return;
  const [recorder, voice, wake] = await Promise.all([
    toOffscreen<{ recording?: boolean }>({ type: 'recorder_status' }).catch(() => ({ recording: false })),
    toOffscreen<{ running?: boolean }>({ type: 'voice_running' }).catch(() => ({ running: false })),
    toOffscreen<{ running?: boolean }>({ type: 'wake_running' }).catch(() => ({ running: false })),
  ]);
  if (!recorder.recording && !voice.running && !wake.running && !(await offscreenBusyAnywhere())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}
