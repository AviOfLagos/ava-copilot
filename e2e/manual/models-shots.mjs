// Screenshots of the Models page in a 400 px panel and the settings page's Models tab, against a mock
// OpenRouter and Ollama. Run: node e2e/manual/models-shots.mjs <out-dir> [prefix]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, sleep } from '../harness.mjs';

const out = process.argv[2] ?? 'screens';
const prefix = process.argv[3] ?? 'models';
fs.mkdirSync(out, { recursive: true });

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.url === '/api/v1/models') {
    const model = (id, name, prompt, completion, input = ['text']) => ({
      id,
      name,
      context_length: 128000,
      architecture: { input_modalities: input, output_modalities: ['text'] },
      pricing: { prompt, completion },
      supported_parameters: ['tools'],
    });
    return json(res, 200, {
      data: [
        model('anthropic/claude-opus-5-5', 'Claude Opus 5.5', '0.000003', '0.000015', ['text', 'image']),
        model('openai/gpt-5-mini', 'GPT-5 mini', '0.00000025', '0.000002', ['text', 'image']),
        model('google/gemini-3-flash', 'Gemini 3 Flash', '0.0000003', '0.0000025', ['text', 'image', 'audio']),
        model('meta-llama/llama-4-scout:free', 'Llama 4 Scout (free)', '0', '0'),
        model('deepseek/deepseek-v4', 'DeepSeek V4', '0.0000003', '0.0000012'),
      ],
    });
  }
  if (req.url === '/api/tags') {
    return json(res, 200, {
      models: [
        { name: 'qwen3:8b', size: 5_200_000_000 },
        { name: 'nomic-embed-text:latest', size: 274_000_000 },
      ],
    });
  }
  if (req.url === '/api/show') {
    const { model } = JSON.parse(body || '{}');
    return json(res, 200, {
      capabilities: model.startsWith('nomic') ? ['embedding'] : ['completion', 'tools'],
      model_info: { 'qwen3.context_length': 40960 },
    });
  }
  if (req.url === '/v1/chat/completions') {
    return json(res, 200, {
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

const mock = await startMockLlm({});
const extension = await launchExtension(mock);
const current = await extension.getStorage('llm-api-keys');
await extension.setStorage({
  'llm-api-keys': {
    providers: {
      ...current.providers,
      openrouter: {
        name: 'OpenRouter',
        type: 'openrouter',
        apiKey: 'sk-or-shots-0000',
        baseUrl: `${url}/api/v1`,
        modelNames: ['anthropic/claude-opus-5-5'],
        createdAt: Date.now(),
      },
      ollama: {
        name: 'Ollama',
        type: 'ollama',
        apiKey: 'ollama',
        baseUrl: `${url}/v1`,
        modelNames: [],
        createdAt: Date.now(),
      },
    },
  },
});

const panel = await extension.browser.newPage();
await panel.setViewport({ width: 400, height: 2600 });
await panel.goto(`${extension.origin}/sidepanel.html`);
await panel.waitForSelector('textarea');
await panel.bringToFront();
await panel.evaluate(
  () =>
    new Promise(resolve => {
      const port = chrome.runtime.connect({ name: 'models-settings' });
      port.onMessage.addListener(() => resolve(port.disconnect()));
      port.postMessage({ type: 'models_refresh', requestId: 'shots' });
    }),
);
await sleep(4000);

const clickByName = name =>
  panel.evaluate(name => {
    const button = [...document.querySelectorAll('button, [role="menuitem"]')].find(
      el => el.innerText?.trim() === name || el.getAttribute('aria-label') === name,
    );
    button?.click();
    return Boolean(button);
  }, name);
await clickByName('Menu');
await sleep(300);
if (!(await clickByName('Models & usage')) && !(await clickByName('Models'))) {
  await panel.evaluate(() => {
    const button = document.querySelector('[aria-label="Account menu"]');
    button?.focus();
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await sleep(300);
  if (!(await clickByName('Models & usage'))) await clickByName('Models');
}
await panel.waitForSelector('[data-place="models"]', { timeout: 10000 });
await sleep(1500);
await panel.screenshot({ path: path.join(out, `${prefix}-panel.png`) });
// The page has tabs since the rework: one picture each
for (const tab of ['Roles', 'Local', 'Usage']) {
  const found = await panel.evaluate(tab => {
    const button = [...document.querySelectorAll('[role="tab"]')].find(el => el.innerText.trim() === tab);
    button?.click();
    return Boolean(button);
  }, tab);
  if (!found) continue;
  await sleep(1500);
  await panel.screenshot({ path: path.join(out, `${prefix}-panel-${tab.toLowerCase()}.png`) });
}

const options = await extension.browser.newPage();
await options.setViewport({ width: 1200, height: 1800 });
await options.goto(`${extension.origin}/options.html`);
await sleep(1500);
await options.screenshot({ path: path.join(out, `${prefix}-options.png`) });

await extension.close();
await mock.close();
server.close();
