import { t } from '@extension/i18n';
import { createPortClient } from '../side-panel/models/transport';
import type { PanelApi } from '../side-panel/registry';

/**
 * The PanelApi settings sections get on the full page: commands go over the settings port (the background takes
 * only settings commands there), and "go somewhere" either stays on this page (a settings place) or opens the side
 * panel at that place. The panel opens only from the user's click, so its window is looked up ahead of time.
 */

// The panel reads this when it starts (src/side-panel/capabilities/useAvaNavigation.ts)
const PENDING_PLACE_KEY = 'capabilities-pending-place';

// Places that are pages here
const HERE: Record<string, string> = { settings: 'general', models: 'models', skills: 'privacy/skills' };

export function createSettingsApi(navigate: (hash: string) => void): PanelApi {
  const port = createPortClient({ timeout: t('errors_timeout'), disconnected: t('models_disconnected') });
  let windowId: number | null = null;
  void chrome.windows
    ?.getCurrent()
    .then(current => {
      windowId = current.id ?? null;
    })
    .catch(() => {});

  const showInPanel = (message: { place: string; threadId: string | null }) => {
    const full = { type: 'panel_open_place', label: null, sectionLabel: null, ...message };
    // Called from the click itself: Chrome opens a side panel only then
    if (windowId !== null) void chrome.sidePanel?.open({ windowId }).catch(() => {});
    void chrome.storage.session.set({ [PENDING_PLACE_KEY]: { ...full, at: Date.now() } }).catch(() => {});
    void chrome.runtime
      .sendMessage(full)
      .then(reply => {
        if ((reply as { ok?: boolean } | undefined)?.ok) void chrome.storage.session.remove(PENDING_PLACE_KEY);
      })
      .catch(() => {});
  };

  return {
    request: port.request,
    post: port.post,
    go: place => (HERE[place] ? navigate(`#${HERE[place]}`) : showInPanel({ place, threadId: null })),
    openThread: threadId => showInPanel({ place: 'chat', threadId }),
    startThread: () => showInPanel({ place: 'chat', threadId: null }),
  };
}
