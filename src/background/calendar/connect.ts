import { calendarSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('CalendarConnect');

const SETTINGS_URL = 'https://calendar.google.com/calendar/u/0/r/settings';
// How long the user has to bring the secret address on screen
const WAIT_MS = 4 * 60 * 1000;
const POLL_MS = 1500;

export const SECRET_ICS =
  /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/\s"'<>]+\/private-[0-9a-f]{16,}\/basic\.ics$/;

/**
 * Runs in the Google Calendar settings page: finds the secret iCal address if it shows anywhere
 * (text or a field), and otherwise moves one step toward it: opens the first of "My calendars" and
 * presses the button that reveals the secret address. Self-contained, as every function sent to a page
 * must be.
 */
export const findSecretAddress = (): { url: string | null; step: string } => {
  const pattern = /https:\/\/calendar\.google\.com\/calendar\/ical\/[^/\s"'<>]+\/private-[0-9a-f]{16,}\/basic\.ics/;
  const fields = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
  for (const field of fields) {
    const match = pattern.exec(field.value || '');
    if (match) return { url: match[0], step: 'found' };
  }
  const inText = pattern.exec(document.body ? document.body.innerText : '');
  if (inText) return { url: inText[0], step: 'found' };

  // On a calendar's own settings: reveal the secret address
  const reveal = Array.from(document.querySelectorAll('button, [role="button"]')).find(element => {
    const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.toLowerCase();
    return label.includes('secret') && (label.includes('show') || label.includes('reveal') || label.includes('copy'));
  }) as HTMLElement | undefined;
  if (reveal) {
    reveal.click();
    return { url: null, step: 'revealed' };
  }

  // On the settings home: open the first calendar under "My calendars"
  if (!/\/settings\/calendar\//.test(location.pathname)) {
    const link = Array.from(document.querySelectorAll('a[href*="/settings/calendar/"]'))[0] as HTMLElement | undefined;
    if (link) {
      link.click();
      return { url: null, step: 'opened-calendar' };
    }
  }
  return { url: null, step: 'waiting' };
};

/**
 * Connects Google Calendar from the browser, where the user is signed in: opens its settings and
 * picks up the secret iCal address once it is on screen. Nothing else on the page is read or kept.
 *
 * @returns The address saved, or an error to show
 */
export async function connectGoogleCalendar(onSaved: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  const tab = await chrome.tabs.create({ url: SETTINGS_URL, active: true });
  if (tab.id === undefined) return { ok: false, error: 'Could not open Google Calendar.' };
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (!current) return { ok: false, error: 'The Google Calendar tab was closed.' };
    if (!current.url?.startsWith('https://calendar.google.com/')) continue;
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findSecretAddress });
      const found = result?.result as { url: string | null } | undefined;
      if (found?.url && SECRET_ICS.test(found.url)) {
        await calendarSettingsStore.updateSettings({ icsUrl: found.url, reminders: true });
        await onSaved();
        return { ok: true };
      }
    } catch (error) {
      // The page is still loading or redirecting to sign-in
      logger.debug('Calendar page not ready', error);
    }
  }
  return {
    ok: false,
    error:
      'The secret address did not show. Open your calendar’s settings and press “show” next to “Secret address in iCal format”.',
  };
}
