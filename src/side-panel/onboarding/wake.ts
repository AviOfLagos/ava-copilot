import { t } from '@extension/i18n';
import { meetingSettingsStore } from '@extension/storage';
import type { PanelApi } from '../registry';
import { ensureVoiceModels } from '../voice-models/gate';
import type { CardPlacement } from '../voice-models/gate';

/**
 * Turns the wake word on or off and, when on, asks the background to start listening. Returns why it
 * did not start, or '' when it did; a denied microphone opens the permission page. The first time, its model is
 * downloaded (the card shows where `placement` says); null when the user said not now, and it stays off.
 */
export async function setWakeWord(
  on: boolean,
  request?: PanelApi['request'],
  placement: CardPlacement = 'panel',
): Promise<string | null> {
  if (on && request && !(await ensureVoiceModels('wake', request, placement))) {
    await meetingSettingsStore.updateSettings({ wakeWord: false });
    return null;
  }
  await meetingSettingsStore.updateSettings({ wakeWord: on });
  if (!on) return '';
  const result = (await chrome.runtime.sendMessage({ type: 'wake_sync' }).catch(() => null)) as {
    ok?: boolean;
    error?: string;
    micDenied?: boolean;
  } | null;
  if (result?.micDenied) {
    void chrome.windows.create({
      url: chrome.runtime.getURL('permission/index.html'),
      type: 'popup',
      width: 500,
      height: 600,
    });
    return t('voice_micNeeded');
  }
  if (!result?.ok) return result?.error ?? t('settings_wake_failed');
  return '';
}
