import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm } from './mock-llm.mjs';
import { launchExtension, openSession, sleep, waitForThread } from './harness.mjs';

/**
 * The typing box: the words on a row of their own across the whole width, the sparkle and the buttons on a row
 * beneath; it grows to the smaller of 40% of the panel and 320 px and then scrolls; past three lines an expand
 * control takes it to 70% of the panel, and Escape or sending shrinks it again; while dictating the listening strip
 * takes the words' row. E2E_SHOTS=<dir> keeps the screenshots (empty, five lines, long text, expanded, dictating).
 */

process.env.E2E_FAKE_MIC = '1';
process.env.E2E_FAKE_AUDIO_FILE = path.resolve(import.meta.dirname, 'hey-ava.wav');

const scenarios = { typed: [() => [{ done: { text: 'Scripted steps complete.', success: true } }]] };
const SHOTS = process.env.E2E_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'typing-box-'));
fs.mkdirSync(SHOTS, { recursive: true });

let mock;
let extension;
let session;
const panel = () => session.panel;

before(async () => {
  mock = await startMockLlm(scenarios);
  extension = await launchExtension(mock);
  const keys = await extension.getStorage('llm-api-keys');
  keys.providers.gemini = {
    name: 'Gemini',
    type: 'gemini',
    apiKey: 'test',
    baseUrl: mock.baseUrl.replace(/\/v1$/, '/v1beta'),
    modelNames: ['gemini-3.8-flash'],
    createdAt: Date.now(),
  };
  await extension.setStorage({
    'llm-api-keys': keys,
    'speech-to-text-model': { speechToTextModel: { provider: 'gemini', modelName: 'gemini-3.8-flash' } },
  });
  await extension.browser.defaultBrowserContext().overridePermissions(extension.origin, ['microphone']);
  session = await openSession(extension, mock);
  await panel().bringToFront();
});

after(async () => {
  await extension?.close();
  await mock?.close();
});

const setText = value =>
  panel().evaluate(text => {
    const input = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);

const lines = n => Array.from({ length: n }, (_, i) => `Line ${i + 1} of the message`).join('\n');
// About 400 words, as a person would write them
const FOUR_HUNDRED_WORDS = Array.from(
  { length: 40 },
  (_, i) => `Item ${i + 1}: please check the figures for the north office and tell me what changed since last week.`,
).join(' ');

const resize = async (width, height = 800) => {
  await panel().setViewport({ width, height });
  // The panel hears about its new size a moment later
  await sleep(150);
};
const shot = name => panel().screenshot({ path: path.join(SHOTS, `${name}.png`) });

/** Where things are, in the panel. */
const measure = () =>
  panel().evaluate(() => {
    const box = element => {
      const r = element?.getBoundingClientRect();
      return r
        ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
        : null;
    };
    const area = document.querySelector('textarea');
    const pill = document.querySelector('.mo-pill');
    const expand = document.querySelector(
      'button[aria-label="Expand the text box"], button[aria-label="Shrink the text box"]',
    );
    const buttons = [...document.querySelectorAll('form button')]
      .filter(b => b !== expand && !b.closest('.stt-strip'))
      .map(box);
    return {
      viewportHeight: window.innerHeight,
      area: box(area),
      areaPaddingRight: area ? parseFloat(getComputedStyle(area).paddingRight) : 0,
      areaOverflows: area ? area.scrollHeight > area.clientHeight + 1 : false,
      pill: box(pill),
      expand: box(expand),
      expandLabel: expand?.getAttribute('aria-label') ?? null,
      buttons,
    };
  });

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('the words have a row of their own across the full width and the buttons sit beneath', async () => {
  await resize(380);
  await setText('');
  await shot('1-empty');
  const m = await measure();
  assert.ok(m.area.width > m.pill.width - 24, `the text box spans the pill (${m.area.width} of ${m.pill.width})`);
  assert.ok(m.buttons.length >= 2, 'attach and send are there');
  for (const button of m.buttons) {
    assert.ok(button.top >= m.area.bottom - 1, 'every button is below the text box');
    assert.equal(overlaps(button, m.area), false);
  }
  assert.equal(m.expand, null, 'no expand control for an empty box');
});

test('a message of five lines grows the box, shows the expand control and keeps the text clear of it', async () => {
  await resize(380);
  await setText(lines(3));
  assert.equal((await measure()).expand, null, 'three lines: no expand control yet');
  await setText(lines(5));
  const m = await measure();
  assert.ok(m.expand, 'past three lines the expand control shows');
  assert.equal(m.expandLabel, 'Expand the text box');
  assert.ok(m.area.height >= 110 && m.area.height <= 125, `five lines are about 116 px tall (${m.area.height})`);
  assert.equal(m.areaOverflows, false, 'five lines fit without scrolling');
  assert.ok(m.area.right - m.expand.left <= m.areaPaddingRight, 'the control sits in the padding, not over the words');
  await shot('2-five-lines');
});

test('a 400-word message grows to the smaller of 40% of the panel and 320 px, then scrolls', async () => {
  for (const [width, height] of [
    [380, 800],
    [380, 500],
  ]) {
    await resize(width, height);
    await setText(FOUR_HUNDRED_WORDS);
    const m = await measure();
    const limit = Math.min(height * 0.4, 320);
    assert.ok(Math.abs(m.area.height - limit) <= 1, `${height} px panel: box is ${m.area.height}, expected ${limit}`);
    assert.equal(m.areaOverflows, true, 'the rest scrolls');
    assert.ok(m.expand);
  }
  await resize(380, 800);
  await setText(FOUR_HUNDRED_WORDS);
  await shot('3-long-text');
});

test('the layout holds at 320, 380 and 520 px: no button over the text or over another button', async () => {
  for (const width of [320, 380, 520]) {
    await resize(width, 800);
    for (const value of ['', 'Short', lines(5), FOUR_HUNDRED_WORDS]) {
      await setText(value);
      const m = await measure();
      assert.ok(m.pill.right <= width && m.pill.left >= 0, `${width}px: the pill is inside the panel`);
      for (const button of m.buttons) {
        assert.equal(overlaps(button, m.area), false, `${width}px: a button covers the text box`);
        assert.ok(
          button.right <= m.pill.right && button.left >= m.pill.left,
          `${width}px: a button is outside the pill`,
        );
      }
      m.buttons.forEach((a, i) =>
        m.buttons.slice(i + 1).forEach(b => assert.equal(overlaps(a, b), false, `${width}px: two buttons overlap`)),
      );
      if (m.expand) assert.equal(overlaps(m.expand, m.buttons[0]), false);
    }
  }
});

test('expanded the box takes 70% of the panel; the same control, Escape and sending all shrink it', async () => {
  await resize(380, 800);
  await setText(lines(5));
  await panel().click('button[aria-label="Expand the text box"]');
  let m = await measure();
  assert.ok(Math.abs(m.area.height - 800 * 0.7) <= 1, `expanded to 70% (${m.area.height})`);
  assert.equal(m.expandLabel, 'Shrink the text box');
  await shot('4-expanded');

  // The same control shrinks it
  await panel().click('button[aria-label="Shrink the text box"]');
  m = await measure();
  assert.ok(m.area.height < 130, `shrunk (${m.area.height})`);

  // Escape shrinks it too, with the focus in the box and with it on a button elsewhere
  await panel().click('button[aria-label="Expand the text box"]');
  await panel().focus('textarea');
  await panel().keyboard.press('Escape');
  m = await measure();
  assert.ok(m.area.height < 130, `Escape shrinks it (${m.area.height})`);
  await panel().click('button[aria-label="Expand the text box"]');
  await panel().evaluate(() => document.querySelector('button[aria-label="Attach a text file"]').focus());
  await panel().keyboard.press('Escape');
  m = await measure();
  assert.ok(m.area.height < 130, `Escape with the focus on a button shrinks it (${m.area.height})`);

  // Taking the text down to three lines drops the control, and the box with it
  await panel().click('button[aria-label="Expand the text box"]');
  await setText(lines(2));
  m = await measure();
  assert.equal(m.expand, null);
  assert.ok(m.area.height < 80, `two lines are short again (${m.area.height})`);
});

test('while dictating the listening strip takes the words row at full width', async () => {
  await resize(380, 800);
  await panel().bringToFront();
  await setText('A note before');
  const before = await measure();
  await panel().evaluate(() => document.querySelector('button[aria-label="Start voice input"]').click());
  await panel()
    .waitForSelector('.stt-strip[data-status="listening"]', { timeout: 8000 })
    .catch(async error => {
      throw new Error(`${error.message}. Panel: ${(await session.panelText()).slice(0, 500)}`);
    });
  const strip = await panel().evaluate(() => {
    const r = document.querySelector('.stt-strip').getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
  const m = await measure();
  assert.ok(strip.width >= before.area.width - 4, `the strip is as wide as the text box was (${strip.width})`);
  for (const button of m.buttons) assert.equal(overlaps(button, strip), false, 'no button covers the strip');
  await sleep(600);
  await shot('5-dictating');
  // Esc drops the recording; the box comes back with what was typed
  await panel().keyboard.press('Escape');
  await panel().waitForSelector('textarea', { timeout: 10000 });
  assert.equal(await panel().evaluate(() => document.querySelector('textarea').value), 'A note before');
});

test('Enter sends and shrinks an expanded box; Shift+Enter adds a line', async () => {
  await resize(380, 800);
  await setText('');
  await panel().focus('textarea');
  await panel().keyboard.type('first');
  await panel().keyboard.down('Shift');
  await panel().keyboard.press('Enter');
  await panel().keyboard.up('Shift');
  await panel().keyboard.type('second');
  assert.equal(await panel().evaluate(() => document.querySelector('textarea').value), 'first\nsecond');

  await setText(lines(6));
  await panel().click('button[aria-label="Expand the text box"]');
  assert.ok((await measure()).area.height > 500);
  mock.start('typed');
  await session.web.bringToFront();
  await panel().evaluate(() => document.querySelector('textarea').focus());
  await panel().bringToFront();
  await panel().keyboard.press('Enter');
  await waitForThread(panel(), 'Line 1 of the message', thread => thread.status === 'idle', 30000);
  await sleep(300);
  const m = await measure();
  assert.equal(await panel().evaluate(() => document.querySelector('textarea').value), '', 'sending empties the box');
  assert.ok(m.area.height < 60, `sending shrinks it (${m.area.height})`);
  assert.equal(m.expand, null);
});

test('the screenshots exist', () => {
  for (const name of ['1-empty', '2-five-lines', '3-long-text', '4-expanded', '5-dictating']) {
    assert.ok(fs.statSync(path.join(SHOTS, `${name}.png`)).size > 3000, `${name}.png has content`);
  }
});
