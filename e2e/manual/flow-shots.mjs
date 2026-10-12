// Screenshots of the Workflows place at side-panel width, for a visual check (not a test).
// Run after `pnpm build`: CHROME_PATH=… node e2e/manual/flow-shots.mjs <out-dir>
import http from 'node:http';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, sleep } from '../harness.mjs';

const out = process.argv[2] ?? '.';
const SUMMARY_MARKER = "You are one step of the user's routine";

const mock = await startMockLlm({});
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/hn/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hits: [{ title: 'A story', url: 'https://example.com', points: 10 }] }));
  }
  if (req.method === 'GET' && req.url.startsWith('/hf/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([{ paper: { id: '1', title: 'A paper' } }]));
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = body ? JSON.parse(body) : {};
  const system = (request.messages ?? [])
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n');
  if (system.includes(SUMMARY_MARKER)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '- **[A story](https://example.com)** matters because it is scripted',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
      }),
    );
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const extension = await launchExtension({ ...mock, baseUrl: `${origin}/v1` });
await extension.setStorage({
  'workflow-settings': {
    urlOverrides: { 'https://hn.algolia.com/': `${origin}/hn/`, 'https://huggingface.co/': `${origin}/hf/` },
  },
});

const panel = await extension.browser.newPage();
await panel.setViewport({ width: 400, height: 1000 });
await panel.goto(`${extension.origin}/sidepanel.html`);
await panel.waitForSelector('textarea');
const click = label =>
  panel.evaluate(label => {
    const button = [...document.querySelectorAll('button')].find(
      b => b.innerText.trim() === label || b.getAttribute('aria-label') === label,
    );
    if (!button) throw new Error(`No button ${label}`);
    button.click();
  }, label);

await click('Menu');
await click('Workflows');
await sleep(800);
await panel.screenshot({ path: path.join(out, 'flow-empty.png') });
await click('Draft Morning tech news from the template');
await panel.waitForSelector('[data-flow-node]');
await sleep(1200);
await panel.screenshot({ path: path.join(out, 'flow-draft.png') });
await click('Create');
await sleep(800);
await click('Run now');
await panel.waitForFunction(
  () => [...document.querySelectorAll('[data-flow-node]')].every(node => node.dataset.status === 'succeeded'),
  { polling: 300, timeout: 30000 },
);
await panel.evaluate(() => document.querySelector('[data-flow-node="pick"]').click());
await sleep(1000);
await panel.screenshot({ path: path.join(out, 'flow-run.png'), fullPage: true });
await panel.evaluate(() => {
  document.documentElement.dataset.theme = 'light';
});
await sleep(600);
await panel.screenshot({ path: path.join(out, 'flow-run-light.png'), fullPage: true });

await extension.close();
await mock.close();
server.close();
console.log('shots written to', out);
