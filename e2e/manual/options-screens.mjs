// Screenshots of the full settings page. Run: node e2e/manual/options-screens.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
fs.mkdirSync(out, { recursive: true });
const mock = await startMockLlm({});
const extension = await launchExtension(mock);
const page = await extension.browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
await page.goto(`${extension.origin}/options.html`);
for (const tab of ['Models', 'General', 'Skills']) {
  await page.evaluate(
    label => [...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === label)?.click(),
    tab,
  );
  await sleep(700);
  await page.screenshot({ path: path.join(out, `options-${tab.toLowerCase()}.png`) });
}
await extension.close();
await mock.close();
