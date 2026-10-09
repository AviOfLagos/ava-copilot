/**
 * The one offscreen document, shared by the meeting recorder and the voice session. It closes only
 * when neither is using it.
 */

const OFFSCREEN_URL = 'offscreen.html';

export async function ensureOffscreen(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (open.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Records meetings and holds the voice conversation with the copilot',
    });
  }
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
  if (!recorder.recording && !voice.running && !wake.running) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}
