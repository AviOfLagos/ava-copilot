import { MODELS_PORT_NAME } from '@extension/storage';
import { dispatchCommand } from '../registry';
import type { CommandContext } from '../registry';

/**
 * The full-page Settings has no panel port; the settings sections it shows (the same components as anywhere else)
 * reach their commands on a port of their own. Only the commands settings sections send pass (by prefix below),
 * and only from the extension's own pages, never a content script or another extension. Anything else gets an
 * error reply and never reaches a handler.
 */

// The port's name stayed when it grew from Models into all of Settings, so an open page keeps working
export const SETTINGS_PORT_NAME = MODELS_PORT_NAME;

// What settings sections send: models, voice engines and downloads, previews, devices, Nex Brain, identity and
// memory, AI history, the Inbox's watch, and install-before-use checks
export const SETTINGS_COMMAND_PREFIXES = [
  'models_',
  'voice_engine_',
  'voice_models_',
  'voice_preview',
  'audio_devices_',
  'brain_',
  'identity_',
  'memory_',
  'history_',
  'inbox_watch_now',
] as const;

export function allowedOnSettingsPort(type: unknown): boolean {
  return typeof type === 'string' && SETTINGS_COMMAND_PREFIXES.some(prefix => type.startsWith(prefix));
}

/** The extension's own pages only: same id, a URL under the extension, and no tab content script. */
export function fromExtensionPage(
  sender: chrome.runtime.MessageSender | undefined,
  extensionId: string,
  extensionRoot: string,
): boolean {
  if (!sender || sender.id !== extensionId || !sender.url?.startsWith(extensionRoot)) return false;
  // A content script's sender carries the tab's own URL, never the extension's; a frame of an extension page
  // shown inside a web page would carry an extension URL with a tab whose page is not ours
  if (sender.tab?.url && !sender.tab.url.startsWith(extensionRoot)) return false;
  return true;
}

export function handleSettingsPort(port: chrome.runtime.Port, dispatch = dispatchCommand): void {
  port.onMessage.addListener(async message => {
    const type = typeof message?.type === 'string' ? message.type : '';
    const context: CommandContext = {
      reply: reply => {
        try {
          port.postMessage(reply);
        } catch {
          // The page closed before the answer came
        }
      },
      requestId: typeof message?.requestId === 'string' ? message.requestId : null,
    };
    try {
      if (!allowedOnSettingsPort(type) || !(await dispatch(message, context))) {
        context.reply({ type: 'error', requestId: context.requestId, error: 'Unknown request.' });
      }
    } catch (error) {
      // A handler that throws still answers, so the page is not left waiting for its time-out
      context.reply({
        type: 'error',
        requestId: context.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

globalThis.chrome?.runtime?.onConnect?.addListener(port => {
  if (port.name !== SETTINGS_PORT_NAME) return;
  if (!fromExtensionPage(port.sender, chrome.runtime.id, chrome.runtime.getURL(''))) {
    port.disconnect();
    return;
  }
  handleSettingsPort(port);
});
