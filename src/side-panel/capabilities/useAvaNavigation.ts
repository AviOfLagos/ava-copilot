import { useEffect, useRef } from 'react';
import { t } from '@extension/i18n';

/**
 * Lets Ava open a place in this panel (open_place): a place, a Settings section (scrolled into view and focused),
 * or a chat. A request made while no panel was open waits in storage.session and is shown when the panel starts.
 */

const PENDING_PLACE_KEY = 'capabilities-pending-place';
// A request older than this is stale: the user has moved on
const PENDING_MAX_MS = 5 * 60 * 1000;

interface OpenPlaceMessage {
  type: 'panel_open_place';
  place: string;
  label?: string | null;
  sectionLabel: string | null;
  threadId: string | null;
}

export interface AvaNavigationHandlers {
  go: (place: string) => void;
  openThread: (threadId: string) => void;
  // Shown after the place opened, e.g. to put the voice screen away and say what was opened
  onOpened: (text: string) => void;
  assistantName: string;
}

function isOpenPlace(message: unknown): message is OpenPlaceMessage {
  const value = message as Partial<OpenPlaceMessage> | null;
  return value?.type === 'panel_open_place' && typeof value.place === 'string';
}

/** Scrolls Settings to the section with this label once it is drawn, and moves focus there. */
function revealSection(label: string): void {
  let tries = 0;
  const look = () => {
    const section = [...document.querySelectorAll<HTMLElement>('section[aria-label]')].find(
      element => element.getAttribute('aria-label') === label,
    );
    if (section) {
      section.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (!section.hasAttribute('tabindex')) section.setAttribute('tabindex', '-1');
      section.focus({ preventScroll: true });
      return;
    }
    if (++tries < 20) window.setTimeout(look, 100);
  };
  window.setTimeout(look, 50);
}

export function useAvaNavigation(handlers: AvaNavigationHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const open = (message: OpenPlaceMessage) => {
      const { go, openThread, onOpened, assistantName } = ref.current;
      if (message.threadId) openThread(message.threadId);
      else go(message.place);
      if (message.sectionLabel) revealSection(message.sectionLabel);
      const where = message.sectionLabel
        ? t('ava_cap_settingsPath', [message.sectionLabel])
        : message.label || message.place;
      onOpened(message.threadId ? '' : t('ava_cap_opened', [assistantName, where]));
    };
    const listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => {
      if (sender.id !== chrome.runtime.id || !isOpenPlace(message)) return;
      open(message);
      reply({ ok: true });
    };
    chrome.runtime.onMessage.addListener(listener);
    // Asked for while the panel was closed
    void chrome.storage.session
      .get(PENDING_PLACE_KEY)
      .then(stored => {
        const pending = stored?.[PENDING_PLACE_KEY] as (OpenPlaceMessage & { at?: number }) | undefined;
        if (!pending) return;
        void chrome.storage.session.remove(PENDING_PLACE_KEY);
        if (isOpenPlace(pending) && Date.now() - (pending.at ?? 0) < PENDING_MAX_MS) open(pending);
      })
      .catch(() => {});
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);
}
