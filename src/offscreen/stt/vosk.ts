/**
 * Dictation with Vosk, the recogniser "Hey Ava" already uses: the same worker and English model (from
 * `node scripts/wake-word-setup.mjs`), but a recogniser with no grammar, so it writes down any words. A second
 * worker of its own, so the wake word listener is never disturbed. Smaller and faster than Moonshine, less
 * accurate.
 */

const RATE = 16_000;
// Same rationale as the wake word listener (src/offscreen/wake.ts): suppresses the "LOG
// (VoskAPI:…)" startup chatter this worker otherwise prints as console warnings.
const VOSK_WORKER_LOG_LEVEL = -1;

type VoskMessage = {
  event?: string;
  result?: { text?: string; partial?: string };
  recognizerId?: string;
  error?: string;
};

export class VoskDictation {
  private worker: Worker | null = null;
  private readonly recognizerId = crypto.randomUUID();
  // Replies for this recogniser, in the order the worker sends them (it answers every message, in order)
  private waiting: ((message: VoskMessage) => void)[] = [];
  private loading: Promise<void> | null = null;

  constructor(
    private readonly workerUrl = chrome.runtime.getURL('wake/vosk-worker.js'),
    private readonly modelUrl = chrome.runtime.getURL('wake/model.tar.gz'),
  ) {}

  load(): Promise<void> {
    this.loading ??= this.start().catch(error => {
      this.dispose();
      throw error;
    });
    return this.loading;
  }

  /** The words in one utterance. */
  async transcribe(audio: Float32Array): Promise<string> {
    await this.load();
    const worker = this.worker!;
    // Kaldi takes 16-bit sample values as floats
    const data = audio.map(value => value * 0x8000);
    const first = this.next();
    worker.postMessage({ action: 'audioChunk', recognizerId: this.recognizerId, sampleRate: RATE, data }, [
      data.buffer,
    ]);
    const final = this.next();
    worker.postMessage({ action: 'retrieveFinalResult', recognizerId: this.recognizerId });
    const parts = [await first, await final].map(message =>
      message.event === 'result' ? (message.result?.text ?? '') : '',
    );
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  dispose(): void {
    this.worker?.postMessage({ action: 'terminate' });
    this.worker?.terminate();
    this.worker = null;
    this.loading = null;
    for (const resolve of this.waiting.splice(0)) resolve({ event: 'error', error: 'Stopped' });
  }

  private next(): Promise<VoskMessage> {
    return new Promise(resolve => this.waiting.push(resolve));
  }

  private async start(): Promise<void> {
    const worker = new Worker(this.workerUrl);
    this.worker = worker;
    worker.postMessage({ action: 'set', key: 'logLevel', value: VOSK_WORKER_LOG_LEVEL });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The Vosk model did not load')), 60_000);
      worker.addEventListener('message', function loaded(event: MessageEvent<VoskMessage>) {
        if (event.data?.event === 'error') {
          clearTimeout(timer);
          reject(new Error(event.data.error || 'The Vosk model did not load'));
        } else if (event.data?.event === 'load') {
          clearTimeout(timer);
          worker.removeEventListener('message', loaded);
          if (event.data.result) resolve();
          else reject(new Error('The Vosk model did not load'));
        }
      });
      worker.addEventListener('error', event => reject(new Error(event.message || 'The Vosk worker failed')));
      worker.postMessage({ action: 'load', modelUrl: this.modelUrl });
    });
    worker.addEventListener('message', (event: MessageEvent<VoskMessage>) => {
      if (event.data?.recognizerId !== this.recognizerId) return;
      this.waiting.shift()?.(event.data);
    });
    // No grammar: any words of the model's vocabulary
    worker.postMessage({ action: 'create', recognizerId: this.recognizerId, sampleRate: RATE });
  }
}
