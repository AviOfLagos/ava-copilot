import { z } from 'zod';
import { audioDeviceSettingsStore } from '@extension/storage';
import type { AudioDeviceOption } from '@extension/shared';
import { registerCommand } from '../registry';
import { ensureOffscreen, toOffscreen, closeOffscreenIfIdle, pushAudioDeviceSettings } from '../offscreen';

/**
 * Settings › Voice's microphone/speaker pickers: the panel has no microphone permission, so it asks
 * the background, which asks the one document that does (the offscreen document — see
 * src/offscreen/devices.ts). Opens the offscreen document only for the moment it takes to ask, then
 * lets the usual idle check close it again if nothing else needs it.
 *
 * A chosen device is applied live: `ensureOffscreen` pushes it once right after creating a fresh
 * document (src/background/offscreen.ts), and this subscription pushes again on every later change,
 * but only to a document that is already open — never opens one just for this.
 */

registerCommand('audio_devices_list', z.object({ type: z.literal('audio_devices_list') }), async (_input, ctx) => {
  await ensureOffscreen();
  try {
    const { devices } = await toOffscreen<{ devices: AudioDeviceOption[] }>({ type: 'audio_devices_list' });
    ctx.reply({ type: 'audio_devices_list', requestId: ctx.requestId, devices });
  } catch (error) {
    ctx.reply({ type: 'audio_devices_list', requestId: ctx.requestId, devices: [], error: String(error) });
  } finally {
    void closeOffscreenIfIdle();
  }
});

audioDeviceSettingsStore.subscribe(() => {
  void (async () => {
    const open = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (open.length > 0) await pushAudioDeviceSettings();
  })();
});
