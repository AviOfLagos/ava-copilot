/**
 * Listens for "Hey Ava" on the device, with the Vosk recogniser in a worker and a grammar of that one
 * phrase: nothing leaves the machine until it is heard. The worker and model come from
 * scripts/wake-word-setup.mjs. When the phrase is heard, the moment of the phrase and what is said after
 * it are kept for the conversation, so a request said in the same breath ("Hey Ava, what's on my
 * calendar") is not lost while it connects. Nothing said before the phrase is kept.
 */

const RATE = 16000;
export const WAKE_PHRASE = 'hey ava';
// Audio kept from before the phrase was recognised: only the phrase itself, which ends a moment
// before the recogniser reports it; anything older is never sent
const PHRASE_SECONDS = 1.2;
// Audio kept after the phrase, while the conversation connects
const CAPTURE_SECONDS = 12;
const CAPTURE_EXPIRES_MS = 15_000;
// One wake at a time, however long the phrase echoes in the partial results
const COOLDOWN_MS = 4000;

/** Whether a recogniser result contains the phrase. Grammar mode gives "hey ava" or "[unk]". */
export function heardWake(text: string | undefined): boolean {
  return !!text && text.toLowerCase().includes(WAKE_PHRASE);
}

/** The last seconds of audio, in arrival order. */
export class AudioRing {
  private chunks: Float32Array[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.limit) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  take(): Float32Array[] {
    const chunks = this.chunks;
    this.chunks = [];
    this.size = 0;
    return chunks;
  }
}

type WorkerMessage = { event?: string; result?: unknown; recognizerId?: string; error?: string };

export class WakeListener {
  private worker: Worker | null = null;
  private mic: MediaStream | null = null;
  private input: AudioContext | null = null;
  private readonly recognizerId = crypto.randomUUID();
  private readonly ring = new AudioRing(RATE * PHRASE_SECONDS);
  private paused = false;
  private lastWake = 0;
  // After the phrase: what the user goes on to say, kept for the conversation it starts
  private capture: Float32Array[] | null = null;
  private captured = 0;

  constructor(private readonly onWake: () => void) {}

  get running(): boolean {
    return this.worker !== null;
  }

  async start(): Promise<void> {
    if (this.worker) return;
    const worker = new Worker(chrome.runtime.getURL('wake/vosk-worker.js'));
    this.worker = worker;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The wake word model did not load')), 60_000);
        worker.addEventListener('message', function loaded(event: MessageEvent<WorkerMessage>) {
          if (event.data?.event === 'error') {
            clearTimeout(timer);
            reject(new Error(event.data.error || 'The wake word model did not load'));
            return;
          }
          if (event.data?.event !== 'load') return;
          clearTimeout(timer);
          worker.removeEventListener('message', loaded);
          if (event.data.result) resolve();
          else reject(new Error('The wake word model did not load'));
        });
        worker.addEventListener('error', event => reject(new Error(event.message || 'The wake word worker failed')));
        worker.postMessage({ action: 'load', modelUrl: chrome.runtime.getURL('wake/model.tar.gz') });
      });
      worker.postMessage({
        action: 'create',
        recognizerId: this.recognizerId,
        sampleRate: RATE,
        grammar: JSON.stringify([WAKE_PHRASE, '[unk]']),
      });
      worker.addEventListener('message', event => this.handle(event.data as WorkerMessage));

      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.input = new AudioContext({ sampleRate: RATE });
      await this.input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
      const node = new AudioWorkletNode(this.input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = event => this.feed(event.data as Float32Array);
      this.input.createMediaStreamSource(this.mic).connect(node);
      const mute = this.input.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(this.input.destination);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.worker?.postMessage({ action: 'terminate' });
    this.worker?.terminate();
    this.worker = null;
    this.mic?.getTracks().forEach(track => track.stop());
    this.mic = null;
    void this.input?.close().catch(() => {});
    this.input = null;
  }

  /** While the copilot is talking with the user, the phrase means nothing. */
  pause(): void {
    this.paused = true;
    this.capture = null;
    this.ring.take();
  }

  resume(): void {
    this.paused = false;
    this.capture = null;
  }

  /** The phrase and what followed it, once, for the conversation starting now; then listening pauses. */
  takeCapture(): Float32Array[] | undefined {
    const capture = this.capture && Date.now() - this.lastWake < CAPTURE_EXPIRES_MS ? this.capture : undefined;
    this.pause();
    return capture;
  }

  private feed(samples: Float32Array): void {
    if (!this.worker) return;
    if (this.capture) {
      // A wake no conversation took up is dropped, and listening goes on
      if (Date.now() - this.lastWake > CAPTURE_EXPIRES_MS) {
        this.resume();
      } else {
        if (this.captured < RATE * CAPTURE_SECONDS) {
          this.capture.push(samples.slice());
          this.captured += samples.length;
        }
        return;
      }
    }
    if (this.paused) return;
    this.ring.push(samples.slice());
    // Kaldi takes 16-bit sample values as floats
    const data = samples.map(value => value * 0x8000);
    this.worker.postMessage(
      { action: 'audioChunk', recognizerId: this.recognizerId, sampleRate: RATE, data },
      { transfer: [data.buffer] },
    );
  }

  private handle(message: WorkerMessage): void {
    if (message.recognizerId !== this.recognizerId || this.paused || this.capture) return;
    const result = message.result as { partial?: string; text?: string } | undefined;
    const text = message.event === 'partialresult' ? result?.partial : message.event === 'result' ? result?.text : '';
    if (!heardWake(text) || Date.now() - this.lastWake < COOLDOWN_MS) return;
    this.lastWake = Date.now();
    this.capture = this.ring.take();
    this.captured = this.capture.reduce((sum, chunk) => sum + chunk.length, 0);
    this.onWake();
  }
}
