import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRET_ICS, calendarOf, findSecretAddress, judgeReadings, settingsUrl } from '../connect';

describe('SECRET_ICS', () => {
  it('accepts only a Google Calendar secret address', () => {
    expect(
      SECRET_ICS.test(
        'https://calendar.google.com/calendar/ical/avi%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics',
      ),
    ).toBe(true);
    expect(SECRET_ICS.test('https://calendar.google.com/calendar/ical/avi%40example.com/public/basic.ics')).toBe(false);
    expect(
      SECRET_ICS.test('https://calendar.google.com.evil.example/calendar/ical/a/private-0123456789abcdef/basic.ics'),
    ).toBe(false);
  });
});

describe('calendarOf', () => {
  it('names the calendar of a secret address', () => {
    expect(
      calendarOf('https://calendar.google.com/calendar/ical/avi%40example.com/private-0123456789abcdef/basic.ics'),
    ).toBe('avi@example.com');
  });
});

describe('settingsUrl', () => {
  it('opens the chosen signed-in account, by number or address', () => {
    expect(settingsUrl()).toBe('https://calendar.google.com/calendar/u/0/r/settings');
    expect(settingsUrl(3)).toBe('https://calendar.google.com/calendar/u/3/r/settings');
    expect(settingsUrl('avi@nexprove.com')).toBe(
      'https://calendar.google.com/calendar/r/settings?authuser=avi%40nexprove.com',
    );
    // Anything else falls back to the first account
    expect(settingsUrl(-1)).toBe('https://calendar.google.com/calendar/u/0/r/settings');
    expect(settingsUrl('../../evil')).toBe('https://calendar.google.com/calendar/u/0/r/settings');
  });
});

describe('judgeReadings', () => {
  const secret =
    'https://calendar.google.com/calendar/ical/avi%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics';
  const reading = (step: string, url: string | null = null) => ({ step, url, account: 'avi@example.com' });

  it('answers as soon as the secret address shows', () => {
    expect(judgeReadings([reading('waiting'), reading('found', secret)])).toMatchObject({
      ok: true,
      calendar: 'avi@example.com',
      url: secret,
    });
  });

  it('says secret addresses are off after a few readings of a loaded page without one', () => {
    expect(judgeReadings([reading('no_secret'), reading('no_secret')])).toBeNull();
    const answer = judgeReadings([reading('waiting'), ...Array.from({ length: 4 }, () => reading('no_secret'))]);
    expect(answer).toMatchObject({ ok: false, reason: 'secret_disabled' });
    expect(answer?.error).toMatch(/Workspace admin/);
    expect(
      judgeReadings([reading('no_secret'), reading('no_secret'), reading('revealed'), reading('no_secret')]),
    ).toBeNull();
  });
});

/** A page made of plain objects, enough for findSecretAddress (which only queries, reads and clicks). */
function fakePage(options: {
  path: string;
  fields?: { value: string; context: string }[];
  buttons?: { label: string }[];
  links?: number;
  text?: string;
  lang?: string;
  accountLabel?: string;
}) {
  const clicked: string[] = [];
  const fields = (options.fields ?? []).map(field => ({
    value: field.value,
    innerText: '',
    parentElement: { innerText: field.context, parentElement: null },
  }));
  const buttons = (options.buttons ?? []).map(button => ({
    getAttribute: (name: string) => (name === 'aria-label' ? button.label : null),
    textContent: '',
    click: () => clicked.push(button.label),
  }));
  const links = Array.from({ length: options.links ?? 0 }, (_, index) => ({
    click: () => clicked.push(`link${index}`),
  }));
  const accounts = options.accountLabel
    ? [{ getAttribute: (name: string) => (name === 'aria-label' ? options.accountLabel! : null) }]
    : [];
  const query = (selector: string) => {
    if (selector.startsWith('[aria-label')) return accounts;
    if (selector.startsWith('input')) return fields;
    if (selector.startsWith('button')) return buttons;
    if (selector.startsWith('a[')) return links;
    return [];
  };
  vi.stubGlobal('document', {
    querySelectorAll: query,
    body: { innerText: options.text ?? '' },
    documentElement: { lang: options.lang ?? 'en' },
  });
  vi.stubGlobal('location', { pathname: options.path });
  return clicked;
}

describe('findSecretAddress', () => {
  afterEach(() => vi.unstubAllGlobals());
  const secret = 'https://calendar.google.com/calendar/ical/a%40b.com/private-0123456789abcdef/basic.ics';
  const publicAddress = 'https://calendar.google.com/calendar/ical/a%40b.com/public/basic.ics';

  it('takes the secret address from its labelled field, with the account', () => {
    fakePage({
      path: '/calendar/u/1/r/settings/calendar/abc',
      fields: [{ value: secret, context: 'Secret address in iCal format' }],
      accountLabel: 'Google Account: Avi (avi@nexprove.com)',
    });
    expect(findSecretAddress()).toEqual({ url: secret, step: 'found', account: 'avi@nexprove.com' });
  });

  it('presses show next to the secret address', () => {
    const clicked = fakePage({ path: '/r/settings/calendar/abc', buttons: [{ label: 'Show secret address' }] });
    expect(findSecretAddress().step).toBe('revealed');
    expect(clicked).toEqual(['Show secret address']);
  });

  it('sees a settings page with the public address but no secret one as turned off', () => {
    fakePage({
      path: '/r/settings/calendar/abc',
      fields: [{ value: publicAddress, context: 'Public address in iCal format' }],
      text: 'Integrate calendar Calendar ID Public address in iCal format',
    });
    expect(findSecretAddress().step).toBe('no_secret');
  });

  it('never claims that on a page in another language', () => {
    fakePage({
      path: '/r/settings/calendar/abc',
      fields: [{ value: publicAddress, context: 'Endereço público' }],
      lang: 'pt-BR',
    });
    expect(findSecretAddress().step).toBe('waiting');
  });

  it('opens the first calendar from the settings home', () => {
    const clicked = fakePage({ path: '/calendar/u/0/r/settings', links: 2 });
    expect(findSecretAddress().step).toBe('opened-calendar');
    expect(clicked).toEqual(['link0']);
  });
});
