// Screenshots of the Connectors place at panel width: the list with the catalogue, the Slack form, a connector's
// tools (new, chosen, changed). Run: CHROME_PATH=... node e2e/manual/connectors-shots.mjs <dir>
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { startMockMcp } from '../mock-mcp.mjs';
import { launchExtension, sleep } from '../harness.mjs';

const dir = process.argv[2] ?? '.';
const mock = await startMockLlm({});
const mcp = await startMockMcp();
const extension = await launchExtension(mock);
const panel = await extension.browser.newPage();
await panel.setViewport({ width: 400, height: 900 });
await panel.goto(`${extension.origin}/sidepanel.html`);
await panel.waitForSelector('textarea');
await panel.bringToFront();

const click = label =>
  panel.evaluate(label => {
    const element = [...document.querySelectorAll('button, [role="menuitem"]')].find(
      el => el.innerText?.trim() === label || el.getAttribute('aria-label') === label,
    );
    element?.click();
    return Boolean(element);
  }, label);
const fill = (selector, value) =>
  panel.evaluate(
    (selector, value) => {
      const input = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value,
  );
const shot = async name => {
  await sleep(400);
  await panel.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
};

await click('Menu');
await sleep(300);
await panel.evaluate(() => {
  const button = document.querySelector('[aria-label="Account menu"]');
  button.focus();
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
});
await sleep(400);
await click('Connectors');
await panel.waitForSelector('[data-place="connectors"]');
await shot('1-list');

await panel.evaluate(() => document.querySelector('[aria-label="Add Slack"]').click());
await sleep(300);
await shot('2-slack-form');
await click('Back to connectors');
await sleep(300);

await click('Add custom server');
await panel.waitForSelector('#conn-url');
await fill('#conn-name', 'Mock tools');
await fill('#conn-url', mcp.url);
await panel.evaluate(() =>
  [...document.querySelectorAll('[role="checkbox"]')].find(el => el.innerText.trim() === 'Nexprove')?.click(),
);
await shot('3-custom-form');
await click('Add connector');
await panel.waitForSelector('[data-connector="Mock tools"]', { timeout: 30000 });
await panel.waitForFunction(() => document.querySelectorAll('[data-tool]').length === 6, { polling: 300 });
await shot('4-tools-new');

const choose = (tool, policy) =>
  panel.evaluate(
    (tool, policy) => document.querySelector(`[data-tool="${tool}"] [data-policy="${policy}"]`).click(),
    tool,
    policy,
  );
await choose('lookup_order', 'read');
await choose('get_forecast', 'read');
await choose('send_message', 'approve');
await sleep(300);
await choose('fetch_notes', 'read');
await sleep(300);
await shot('5-choices-and-confirm');
mcp.changeDescription();
await click('Check tools');
await panel.waitForFunction(
  () => document.querySelector('[data-tool="get_forecast"]')?.getAttribute('data-tool-state') === 'changed',
  { polling: 300 },
);
await shot('6-drift');

await extension.close();
await mcp.close();
await mock.close();
console.log(`Screens in ${dir}`);
