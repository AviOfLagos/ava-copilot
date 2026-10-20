// Opt-in (AVI_BRAIN_LIVE_BROWSER=<path to Chrome, Brave or Chromium>): proves on a real browser that a clip played
// through the microphone stand-in reaches a page's getUserMedia stream, and that stop() silences it. A local page on
// 127.0.0.1 only; never meet.google.com.
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { launchBrowser } from '../meet/browser';
import { attachToPage, CdpConnection, evaluate } from '../meet/cdp';
import { MIC_SCRIPT, playExpression, STOP_EXPRESSION, UNTRUSTED_REGIONS } from '../meet/page-scripts';
import { tempDir } from './helpers';

function toneWav(seconds: number, rate = 24_000): string {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  return b.toString('base64');
}

const PAGE = `<!doctype html><title>mic</title><script>
window.level = 0;
navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(stream => {
  window.kinds = stream.getTracks().map(t => t.kind).join(',');
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  setInterval(() => { analyser.getFloatTimeDomainData(data); let s = 0; for (const v of data) s += v * v; window.level = Math.sqrt(s / data.length); }, 50);
}).catch(e => { window.err = String(e); });
</script>`;

it.skipIf(!process.env.AVI_BRAIN_LIVE_BROWSER)(
  'a played clip arrives in the page microphone',
  async () => {
    const dir = tempDir();
    const browser = await launchBrowser({
      executable: process.env.AVI_BRAIN_LIVE_BROWSER as string,
      profileDir: `${dir.path}/profile`,
      debug: true,
      url: 'about:blank',
    });
    const cdp = new CdpConnection(browser.transport!);
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(PAGE);
    });
    try {
      const sessionId = await attachToPage(cdp);
      await cdp.send('Page.enable', {}, { sessionId });
      await cdp.send('Runtime.enable', {}, { sessionId });
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MIC_SCRIPT }, { sessionId });
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` }, { sessionId });
      await new Promise(r => setTimeout(r, 1500));
      const before = await evaluate<number>(cdp, sessionId, 'window.level');
      const kinds = await evaluate<string>(cdp, sessionId, 'window.kinds || window.err');
      const duration = await evaluate<number>(cdp, sessionId, playExpression(toneWav(2)));
      await new Promise(r => setTimeout(r, 600));
      const during = await evaluate<number>(cdp, sessionId, 'window.level');
      await evaluate(cdp, sessionId, STOP_EXPRESSION);
      await new Promise(r => setTimeout(r, 400));
      const after = await evaluate<number>(cdp, sessionId, 'window.level');
      // The selector READ_STATE cuts others' words out with is one this browser accepts
      expect(
        await evaluate<number>(
          cdp,
          sessionId,
          `document.querySelectorAll(${JSON.stringify(UNTRUSTED_REGIONS)}).length`,
        ),
      ).toBe(0);
      expect(kinds).toBe('audio,video');
      expect(before).toBeLessThan(0.01);
      expect(during).toBeGreaterThan(0.1);
      expect(after).toBeLessThan(0.01);
      expect(duration).toBe(2000);
    } finally {
      await cdp.send('Browser.close').catch(() => {});
      browser.kill();
      await Promise.race([browser.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
      server.close();
      dir.remove();
    }
  },
  30_000,
);
