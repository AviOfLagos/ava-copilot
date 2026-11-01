import type { EconomyEngines } from '../../background/voice/engines/wire';
import { acquireStt, releaseStt } from './pool';
import { hasWords, UtteranceCollector } from './utterances';

/**
 * One utterance from the microphone, written down by a local recogniser: Settings' "Test speech-to-text" and the
 * end-to-end tests use it. The microphone opens, waits for speech, closes when the speaker stops.
 */

const RATE = 16_000;

let lastHeard: { text: string; ms: number } | null = null;

/** The last words a local recogniser wrote down here, and how long that took. */
export function recordHeard(text: string, ms: number): void {
  lastHeard = { text, ms };
}

export function heardLately(): { text: string; ms: number } | null {
  return lastHeard;
}

export async function listenOnce(
  config: EconomyEngines['stt'],
  timeoutMs = 15_000,
): Promise<{ text: string; ms: number; loadMs: number }> {
  const loadStarted = performance.now();
  const engine = await acquireStt(config);
  const loadMs = Math.round(performance.now() - loadStarted);
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const input = new AudioContext({ sampleRate: RATE });
  try {
    await input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const collector = new UtteranceCollector({ sampleRate: RATE });
    const utterance = await new Promise<Float32Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No speech was heard')), timeoutMs);
      const node = new AudioWorkletNode(input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = event => {
        const { utterance: done } = collector.push(event.data as Float32Array);
        if (done) {
          clearTimeout(timer);
          resolve(done);
        }
      };
      input.createMediaStreamSource(mic).connect(node);
      const mute = input.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(input.destination);
    });
    const started = performance.now();
    const text = (await engine.transcribe(utterance)).trim();
    const ms = Math.round(performance.now() - started);
    if (hasWords(text)) recordHeard(text, ms);
    return { text, ms, loadMs };
  } finally {
    mic.getTracks().forEach(track => track.stop());
    void input.close().catch(() => {});
    releaseStt(engine);
  }
}
