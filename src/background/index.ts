import 'webextension-polyfill';
import { llmProviderStore } from '@extension/storage';
import { t } from '@extension/i18n';
import { createLogger } from './log';
import { SpeechToTextService } from './services/speechToText';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { ThreadManager } from './threads/manager';

const logger = createLogger('background');

// Every run belongs to a thread; the manager runs several at once, each on its own tabs
const threads = new ThreadManager();
const SIDE_PANEL_URL = chrome.runtime.getURL(
  (chrome.runtime.getManifest() as { side_panel?: { default_path?: string } }).side_panel?.default_path ??
    'sidepanel.html',
);

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// The user dismissed Chrome's debugging bar on a tab: stop only the thread working there
chrome.debugger.onDetach.addListener(async (source, reason) => {
  logger.info('Debugger detached', source, reason);
  if (reason === 'canceled_by_user' && source.tabId) {
    await threads.onDebuggerDetached(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  void threads.onTabRemoved(tabId);
});

// A restarted service worker picks up the threads that were running
void threads.recover().catch(error => logger.error('Failed to recover threads', error));

logger.info('background loaded');

// A panel is the side panel page, opened in the side panel or popped out into its own window
function isPanel(port: chrome.runtime.Port): boolean {
  const senderUrl = port.sender?.url;
  if (!senderUrl || port.sender?.id !== chrome.runtime.id) {
    return false;
  }
  const url = new URL(senderUrl);
  return `${url.origin}${url.pathname}` === SIDE_PANEL_URL;
}

async function transcribe(audio: string): Promise<string> {
  const providers = await llmProviderStore.getAllProviders();
  const speechToTextService = await SpeechToTextService.create(providers);
  // Remove the data URL prefix if present
  return speechToTextService.transcribeAudio(audio.startsWith('data:') ? audio.split(',')[1] : audio);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'side-panel-connection') {
    return;
  }
  if (!isPanel(port)) {
    logger.warning('Blocked unauthorized side-panel-connection', port.sender?.id, port.sender?.url);
    port.disconnect();
    return;
  }

  port.onMessage.addListener(async message => {
    const threadId = typeof message?.threadId === 'string' ? message.threadId : null;
    try {
      switch (message?.type) {
        case 'heartbeat':
          return port.postMessage({ type: 'heartbeat_ack' });

        case 'thread_send': {
          const id = await threads.send({ threadId, text: String(message.text ?? ''), windowId: message.windowId });
          return port.postMessage({ type: 'thread_started', clientId: message.clientId, threadId: id });
        }

        case 'thread_cancel':
          if (threadId) await threads.cancel(threadId);
          return;

        case 'thread_cancel_all':
          return threads.cancelAll();

        case 'confirm_action':
          // Only an explicit true approves. Anything else declines.
          if (threadId) await threads.answer(threadId, String(message.requestId), message.approved === true);
          return;

        case 'thread_rebind':
          if (threadId) await threads.rebind(threadId, message.windowId);
          return;

        case 'thread_continue':
          if (threadId) await threads.continueThread(threadId, message.windowId);
          return;

        case 'thread_delete':
          if (threadId) await threads.remove(threadId);
          return;

        case 'speech_to_text': {
          if (!message.audio) {
            return port.postMessage({ type: 'speech_to_text_error', error: t('bg_cmd_stt_noAudioData') });
          }
          try {
            return port.postMessage({ type: 'speech_to_text_result', text: await transcribe(message.audio) });
          } catch (error) {
            logger.error('Speech-to-text failed:', error);
            return port.postMessage({
              type: 'speech_to_text_error',
              error: error instanceof Error ? error.message : t('bg_cmd_stt_failed'),
            });
          }
        }

        default:
          return port.postMessage({ type: 'error', threadId, error: t('errors_cmd_unknown', [String(message?.type)]) });
      }
    } catch (error) {
      logger.error('Error handling panel message:', error);
      port.postMessage({
        type: 'error',
        threadId,
        clientId: message?.clientId,
        error: error instanceof Error ? error.message : t('errors_unknown'),
      });
    }
  });
});
