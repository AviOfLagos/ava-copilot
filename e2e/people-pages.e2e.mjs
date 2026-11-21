import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './harness.mjs';
// Node runs these TypeScript files as they are (type stripping): the page code is the code the extension ships
import { CALL_DOM, readRoster } from '../src/background/meetings/captions.ts';
import { probeGmail } from '../src/background/inbox/watchers/gmail.ts';
import { probeSlack } from '../src/background/inbox/watchers/slack.ts';

/**
 * The page readers that learn names (docs/pm-desk.md Part 5), run in a real browser against saved pages with
 * made-up people: never a live call or a live inbox. No extension is needed: each reader runs in the page from its
 * own source text, exactly as chrome.scripting runs it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => fs.readFileSync(path.join(here, 'fixtures/people', name), 'utf8');

let browser;
let page;

before(async () => {
  browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
});

test('Meet: the roster is read from the tiles, without the owner and without a click', async () => {
  await page.setContent(fixture('meet.html'));
  const reading = await page.evaluate(readRoster, CALL_DOM);
  assert.deepEqual(reading, { names: ['Adaeze O.', 'dev.kunle', 'Adaeze O. (Presentation)'], panelOpen: false });
  assert.equal(await page.evaluate(() => window.__clicks), 0);
});

test('Meet: the People panel is read only while the user has it open', async () => {
  await page.setContent(fixture('meet.html'));
  await page.evaluate(() => window.__openPanel());
  const reading = await page.evaluate(readRoster, CALL_DOM);
  assert.equal(reading.panelOpen, true);
  assert.deepEqual(reading.names, ['Adaeze O.', 'dev.kunle', 'Adaeze O. (Presentation)', 'Tolu Bello']);
  assert.equal(await page.evaluate(() => window.__clicks), 0);
});

test('Gmail: an unread sender is read with their address', async () => {
  await page.setContent(fixture('gmail.html'));
  const rows = await page.evaluate(probeGmail);
  assert.deepEqual(
    rows.map(row => [row.externalId, row.sender, row.senderEmail]),
    [
      ['t-101', 'Tolu Bello', 'tolu@example.test'],
      // A service address is read here and left out when names are learned (sources.ts)
      ['t-102', 'Forge', 'no-reply@forge.test'],
    ],
  );
});

test('Slack: a direct message is a person with its id; a channel is not', async () => {
  await page.setContent(fixture('slack.html'));
  const rows = await page.evaluate(probeSlack);
  assert.deepEqual(
    rows.map(row => [row.sender, row.isPerson ?? false, row.senderHandle ?? null]),
    [
      ['Kemi Ade', true, 'D0KEMI'],
      ['general', false, null],
    ],
  );
});
