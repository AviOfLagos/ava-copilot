import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession } from './harness.mjs';

/**
 * End-to-end test of meeting reminders: the calendar's iCal feed is read, and the next meeting shows
 * on the home screen with its link.
 */

let mock;
let extension;

before(async () => {
  mock = await startMockLlm({});
  extension = await launchExtension(mock);
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const stamp = ms =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

test('the next meeting from the calendar shows on the home screen with its link', async () => {
  const start = Date.now() + 3 * 60_000;
  mock.calendar.ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:sync-1',
    'SUMMARY:Stage 2 sync',
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(start + 30 * 60_000)}`,
    'DESCRIPTION:Join https://meet.google.com/abc-defg-hij',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  await extension.setStorage({
    'calendar-settings': {
      icsUrl: `${mock.baseUrl.replace(/\/v1$/, '')}/calendar.ics`,
      remindMinutes: 5,
      reminders: true,
    },
  });

  const session = await openSession(extension, mock);
  const reply = await session.panel.evaluate(() => chrome.runtime.sendMessage({ type: 'kb_calendar_refresh' }));
  assert.deepEqual(reply, { ok: true });

  await session.panel.reload();
  const card = await session.panel.waitForSelector('section[aria-label="Next on your calendar"]', { timeout: 10000 });
  const text = (await card.evaluate(el => el.innerText)).replace(/\s+/g, ' ');
  assert.match(text, /Stage 2 sync/);
  assert.match(text, /in [23] min/);
  assert.ok(await card.$('button'), 'the meeting has a Join button');

  // A feed that is not a calendar address is refused, and says so
  await extension.setStorage({
    'calendar-settings': { icsUrl: 'ftp://example.com/cal.ics', remindMinutes: 5, reminders: true },
  });
  const refused = await session.panel.evaluate(() => chrome.runtime.sendMessage({ type: 'kb_calendar_refresh' }));
  assert.equal(refused.ok, false);
  await session.close();
});
