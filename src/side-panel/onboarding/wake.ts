import { t } from '@extension/i18n';
import { meetingSettingsStore } from '@extension/storage';

/**
 * Turns the wake word on or off and, when on, asks the background to start listening. Returns why it
 * did not start, or '' when it did; a denied microphone opens the permission page.
 */
export async function setWakeWord(on: boolean): Promise<string> {
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
