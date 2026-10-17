/**
 * Manual check, not a test (it downloads from the real hosts: Hugging Face and alphacephei.com, about 100 MB):
 * Settings › Voice engines downloads Moonshine tiny, KittenTTS and the Vosk model with the real pinned catalog,
 * each file checked against its pinned SHA-256, in a build with no models packed.
 * Run: pnpm build, then CHROME_PATH=… node e2e/manual/voice-download-real.mjs
 */
import { startMockLlm } from '../mock-llm.mjs';
import { launchExtension, openSession, sleep } from '../harness.mjs';

const mock = await startMockLlm({});
const extension = await launchExtension(mock);
const session = await openSession(extension, mock);
const { panel } = session;
const hosts = new Set();
panel.on('request', request => {
  const url = new URL(request.url());
  if (url.protocol.startsWith('http')) hosts.add(url.host);
});
try {
  await panel.bringToFront();
  await session.click('Menu');
  await session.openAccountMenu();
  await session.click('Settings');
  await panel.waitForSelector('[data-testid="voice-model-kitten-state"]', { timeout: 15_000 });
  const state = id =>
    panel.evaluate(id => document.querySelector(`[data-testid="voice-model-${id}-state"]`)?.textContent, id);
  for (const [id, name] of [
    ['moonshine-tiny', 'Moonshine tiny'],
    ['kitten', 'KittenTTS nano'],
    ['vosk', 'Vosk (the wake word’s model)'],
  ]) {
    const started = Date.now();
    await session.click(`Download ${name}`);
    for (;;) {
      const text = await state(id);
      if (/^Downloaded/.test(text) || /failed/i.test(text)) {
        console.log(`${id}: ${text} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        break;
      }
      await sleep(1000);
    }
  }
  const files = await panel.evaluate(async () => {
    const out = {};
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('voice-models');
    for await (const [id, dir] of root.entries()) {
      out[id] = [];
      for await (const [name] of dir.entries()) out[id].push(name);
    }
    return out;
  });
  console.log('OPFS:', JSON.stringify(files));
  console.log('Hosts the panel fetched from:', [...hosts].join(', '));
} finally {
  await extension.close();
  await mock.close();
}
