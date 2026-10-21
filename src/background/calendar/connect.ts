import { createLogger } from '../log';

const logger = createLogger('CalendarConnect');

// How long the user has to bring the secret address on screen
const WAIT_MS = 4 * 60 * 1000;
const POLL_MS = 1500;
// Readings of a loaded calendar settings page with no secret address on it before saying it is turned off
const NO_SECRET_READINGS = 4;
export const MAX_GOOGLE_ACCOUNT = 9;

export const SECRET_ICS =
  /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/\s"'<>]+\/private-[0-9a-f]{16,}\/basic\.ics$/;

/**
 * Google Calendar's settings for one signed-in account. Several accounts in one browser are numbered in sign-in
 * order (/u/0, /u/1 …); an email address picks the account by name instead.
 */
export function settingsUrl(account: number | string = 0): string {
  if (typeof account === 'string' && /^[^\s@/?#]+@[^\s@/?#]+$/.test(account.trim())) {
    return `https://calendar.google.com/calendar/r/settings?authuser=${encodeURIComponent(account.trim())}`;
  }
  const index = Number(account);
  const safe = Number.isInteger(index) && index >= 0 && index <= MAX_GOOGLE_ACCOUNT ? index : 0;
  return `https://calendar.google.com/calendar/u/${safe}/r/settings`;
}

export interface PageReading {
  url: string | null;
  // 'found', 'revealed', 'opened-calendar', 'waiting', or 'no_secret': the calendar's settings are on screen with
  // their "Integrate calendar" part, but no secret address (a Google Workspace admin turned them off)
  step: string;
  // The signed-in account the page shows, when it shows one
  account: string | null;
}

/**
 * Runs in the Google Calendar settings page: finds the secret iCal address if it shows anywhere
 * (text or a field), and otherwise moves one step toward it: opens the first of "My calendars" and
 * presses the button that reveals the secret address. Self-contained, as every function sent to a page
 * must be.
 */
export const findSecretAddress = (): PageReading => {
  const pattern = /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/\s"'<>]+\/private-[0-9a-f]{16,}\/basic\.ics$/;
  // The account button's label names the signed-in account: "Google Account: Avi (avi@example.com)"
  let account: string | null = null;
  for (const element of Array.from(document.querySelectorAll('[aria-label*="@"]'))) {
    const match = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(element.getAttribute('aria-label') || '');
    if (match) {
      account = match[0];
      break;
    }
  }
  // Only the field Google labels as the secret address on the calendar settings page that is open;
  // text elsewhere on the page (event details, shared calendars) is never taken
  if (/\/settings\/calendar\//.test(location.pathname)) {
    const fields = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
    const publicLink = /calendar\.google\.com\/calendar\/(ical\/[^/\s"']+\/public\/|embed\?src=)/;
    let integrate = false;
    for (const field of fields) {
      const value = (field.value || '').trim();
      // The public address and the embed code show for every calendar, secret addresses allowed or not
      if (publicLink.test(value)) integrate = true;
      if (!pattern.test(value)) continue;
      let scope: HTMLElement | null = field;
      for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
        if (/secret address/i.test(scope.innerText || '')) return { url: value, step: 'found', account };
      }
    }
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const reveal = buttons.find(element => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`.toLowerCase();
      return label.includes('secret') && (label.includes('show') || label.includes('reveal'));
    }) as HTMLElement | undefined;
    if (reveal && reveal.getAttribute('aria-pressed') !== 'true') {
      reveal.click();
      return { url: null, step: 'revealed', account };
    }
    // Only an English page can be read for the words: in another language "no secret address" is never claimed
    const english = /^en\b/i.test((document.documentElement && document.documentElement.lang) || 'en');
    const text = (document.body && document.body.innerText) || '';
    if (publicLink.test(text)) integrate = true;
    if (english && integrate && !reveal && !/secret address/i.test(text))
      return { url: null, step: 'no_secret', account };
    return { url: null, step: 'waiting', account };
  }

  // On the settings home: open the first of "My calendars", the user's own
  const link = Array.from(document.querySelectorAll('a[href*="/settings/calendar/"]'))[0] as HTMLElement | undefined;
  if (link) {
    link.click();
    return { url: null, step: 'opened-calendar', account };
  }
  return { url: null, step: 'waiting', account };
};

/** The calendar a secret address belongs to, as people read it: usually an email address. */
export function calendarOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/')[3] ?? '');
  } catch {
    return '';
  }
}

export const SECRET_DISABLED_MESSAGE =
  'This Google account has no secret iCal address: its Google Workspace admin turned them off. ' +
  'Pair Nex Brain and read the Mac’s Calendar instead (add the account under System Settings › Internet Accounts), ' +
  'or ask your admin.';

export interface ConnectResult {
  ok: boolean;
  error?: string;
  // Why it did not work, for the panel: 'secret_disabled', 'closed', 'timeout'
  reason?: 'secret_disabled' | 'closed' | 'timeout' | 'open_failed';
  calendar?: string;
  url?: string;
  account?: string | null;
}

/** Turns page readings into an answer once one is clear; null while still waiting. Exported for tests. */
export function judgeReadings(readings: PageReading[]): ConnectResult | null {
  const last = readings.at(-1);
  if (!last) return null;
  if (last.url && SECRET_ICS.test(last.url)) {
    return { ok: true, calendar: calendarOf(last.url), url: last.url, account: last.account };
  }
  const tail = readings.slice(-NO_SECRET_READINGS);
  if (tail.length === NO_SECRET_READINGS && tail.every(reading => reading.step === 'no_secret')) {
    return { ok: false, reason: 'secret_disabled', error: SECRET_DISABLED_MESSAGE, account: last.account };
  }
  return null;
}

/**
 * Connects Google Calendar from the browser, where the user is signed in: opens its settings for the account
 * chosen and picks up the secret iCal address once it is on screen. Nothing else on the page is read or kept.
 * When the calendar's settings show but no secret address does (Workspace admins often turn them off), it says
 * so within seconds instead of waiting out the four minutes.
 *
 * @returns The address found (not saved), or an error to show
 */
export async function connectGoogleCalendar(account: number | string = 0): Promise<ConnectResult> {
  const tab = await chrome.tabs.create({ url: settingsUrl(account), active: true });
  if (tab.id === undefined) return { ok: false, reason: 'open_failed', error: 'Could not open Google Calendar.' };
  const deadline = Date.now() + WAIT_MS;
  const readings: PageReading[] = [];
  let lastAccount: string | null = null;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const current = await chrome.tabs.get(tab.id).catch(() => undefined);
    if (!current) return { ok: false, reason: 'closed', error: 'The Google Calendar tab was closed.' };
    if (!current.url?.startsWith('https://calendar.google.com/')) continue;
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findSecretAddress });
      const reading = result?.result as PageReading | undefined;
      if (!reading) continue;
      lastAccount = reading.account ?? lastAccount;
      readings.push(reading);
      const answer = judgeReadings(readings);
      if (answer) return { ...answer, account: answer.account ?? lastAccount };
    } catch (error) {
      // The page is still loading or redirecting to sign-in
      logger.debug('Calendar page not ready', error);
    }
  }
  return {
    ok: false,
    reason: 'timeout',
    account: lastAccount,
    error:
      'The secret address did not show. Open your calendar’s settings and press “show” next to “Secret address in iCal format”, then paste it here.',
  };
}
