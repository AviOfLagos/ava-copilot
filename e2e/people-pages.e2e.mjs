import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './harness.mjs';
// Node runs these TypeScript files as they are (type stripping): the page code is the code the extension ships
import { CALL_DOM, readRoster } from '../src/background/meetings/captions.ts';

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
