import { describe, expect, it, vi } from 'vitest';
import { allowedOnSettingsPort, fromExtensionPage, handleSettingsPort } from '../port';

const ROOT = 'chrome-extension://ext/';

describe('settings port', () => {
  it('lets through only the commands settings sections send', () => {
    for (const type of [
      'models_provider_save',
      'voice_engine_status',
      'voice_models_changed',
      'voice_preview',
      'audio_devices_list',
      'brain_pair',
      'identity_fact_save',
      'memory_set_scope',
      'history_forget',
      'inbox_watch_now',
    ]) {
      expect(allowedOnSettingsPort(type), type).toBe(true);
    }
    for (const type of [
      'thread_send',
      'confirm_action',
      'kb_wipe',
      'inbox_approve',
      'conn_add',
      'voice_start',
      '',
      7,
    ]) {
      expect(allowedOnSettingsPort(type), String(type)).toBe(false);
    }
  });

  it('takes the extension’s own pages only', () => {
    expect(fromExtensionPage({ id: 'ext', url: `${ROOT}options.html#voice` }, 'ext', ROOT)).toBe(true);
    expect(
      fromExtensionPage(
        { id: 'ext', url: `${ROOT}options.html`, tab: { url: `${ROOT}options.html` } as chrome.tabs.Tab },
        'ext',
        ROOT,
      ),
    ).toBe(true);
    // A content script: the extension's id, but the page's URL
    expect(
      fromExtensionPage(
        { id: 'ext', url: 'https://example.com/', tab: { url: 'https://example.com/' } as chrome.tabs.Tab },
        'ext',
        ROOT,
      ),
    ).toBe(false);
    // An extension page framed inside a web page
    expect(
      fromExtensionPage(
        { id: 'ext', url: `${ROOT}options.html`, tab: { url: 'https://evil.test/' } as chrome.tabs.Tab },
        'ext',
        ROOT,
      ),
    ).toBe(false);
    expect(fromExtensionPage({ id: 'other', url: 'chrome-extension://other/options.html' }, 'ext', ROOT)).toBe(false);
    expect(fromExtensionPage(undefined, 'ext', ROOT)).toBe(false);
  });

  it('refuses other commands with an error and never dispatches them', async () => {
    let listener: (message: Record<string, unknown>) => Promise<void> = async () => {};
    const posted: Record<string, unknown>[] = [];
    const port = {
      onMessage: { addListener: (fn: typeof listener) => (listener = fn) },
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    } as unknown as chrome.runtime.Port;
    const dispatch = vi.fn(
      async (
        _message: { type?: unknown },
        context: { reply: (m: Record<string, unknown>) => void; requestId: string | null },
      ) => {
        context.reply({ type: 'ok', requestId: context.requestId });
        return true;
      },
    );
    handleSettingsPort(port, dispatch);

    await listener({ type: 'thread_send', requestId: 'r1', task: 'send it' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(posted.pop()).toEqual({ type: 'error', requestId: 'r1', error: 'Unknown request.' });

    await listener({ type: 'voice_engine_status', requestId: 'r2' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(posted.pop()).toEqual({ type: 'ok', requestId: 'r2' });

    // Allowed by prefix, but no feature registered it
    dispatch.mockResolvedValueOnce(false);
    await listener({ type: 'models_nothing', requestId: 'r3' });
    expect(posted.pop()).toEqual({ type: 'error', requestId: 'r3', error: 'Unknown request.' });
  });
});
