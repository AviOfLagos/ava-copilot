/**
 * Listens for "Hey Ava" on the device, with the Vosk recogniser in a worker and a grammar of that one
 * phrase: nothing leaves the machine until it is heard. The worker and model come from
 * scripts/wake-word-setup.mjs. A one-phrase grammar forces the decoder to fit almost anything that
 * starts like "hey..." into "hey ava" ("hey", "hey there", "hey everyone" all used to wake it), so a
 * candidate from that grammar is not trusted on its own: it is checked by decoding the phrase window
 * once more, as a single final result, on a second recogniser in the same worker whose grammar also
 * offers plain "hey" and "ava" (`VERIFY_GRAMMAR`) — so the decoder has somewhere accurate to land when
 * only "hey" was said, instead of forcing the full phrase. Verification never leaves the device either,
 * and only adds the short wait for `VERIFY_TAIL_SECONDS` of trailing audio plus the second decode
 * (measured: ~260ms average, ~425ms worst case over 91 synthesized clips across 7 voices/accents — see
 * docs/task.md). When the phrase is confirmed, the moment of the phrase and what is said after it are
 * kept for the conversation, so a request said in the same breath ("Hey Ava, what's on my calendar") is
 * not lost while it connects. Nothing said before the phrase is kept, and a rejected candidate resumes
 * listening at once.
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

// Verification: a candidate still needs the device-only decode below to agree before it wakes.
// "ava" is a plain grammar option here (not free-form dictation): the small model often fails to
// say the name "Ava" at all when it has to recognise it freely, even on clean audio, but reliably
// manages it when the grammar can simply offer the word. There is no "eva"/"ever" entry to weigh:
// those words are not in this grammar's vocabulary, so the verifier cannot land on them by mistake.
const VERIFY_GRAMMAR = ['hey ava', 'hey', 'ava', '[unk]'];
// Extra audio collected after a candidate before verifying, so a trailing "ava" is complete; a
// verification window can run a little past it into the next word, which the verifier's grammar
// then tags as trailing "[unk]" — heyAvaPrefix only looks at the first two words for that reason.
const VERIFY_TAIL_SECONDS = 0.25;
// After a rejected candidate, how long to wait before trying again: an ordinary sentence that
// starts with "hey" (or just sounds like it) can otherwise re-trigger the one-phrase grammar on
// almost every following chunk while it keeps talking.
const VERIFY_RETRY_MS = 500;

/** Whether a recogniser result contains the phrase. Grammar mode gives "hey ava" or "[unk]". */
export function heardWake(text: string | undefined): boolean {
  return !!text && text.toLowerCase().includes(WAKE_PHRASE);
}

/**
 * Whether a VERIFY_GRAMMAR transcript starts with "hey" then "ava". Only the first two words are
 * checked: the verified window can carry a little audio past "ava" into whatever comes next, which
 * the grammar's own loop then renders as more words after it (see VERIFY_TAIL_SECONDS).
 */
export function heyAvaPrefix(text: string | undefined): boolean {
  const words = (text ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  return words[0] === 'hey' && words[1] === 'ava';
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
  // Verification: a candidate from the main recogniser, pending a second decode (see module doc).
  // `verifying` covers the whole candidate, from the moment it is seen to the decode's reply;
  // `deciding` is the back half of that (the decode is already running), so feed() knows to stop
  // collecting a tail rather than start a second, overlapping verification.
  private verifying = false;
  private deciding = false;
  private verifyRing: Float32Array[] = [];
  private verifyTail: Float32Array[] = [];
  private verifyTailSize = 0;
  private verifyRecognizerId: string | null = null;
  // Replies for the verify recogniser, in the order the worker sends them (it answers every
  // message, in order), so each one resolves the next pending request.
  private readonly verifyWaiting: ((message: WorkerMessage) => void)[] = [];
  private retryNotBefore = 0;

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
    this.resetVerification();
  }

  resume(): void {
    this.paused = false;
    this.capture = null;
    this.resetVerification();
  }

  /** Drops any candidate that was mid-verification, e.g. a pause landing during its tail window. */
  private resetVerification(): void {
    this.verifying = false;
    this.deciding = false;
    this.verifyRing = [];
    this.verifyTail = [];
    this.verifyTailSize = 0;
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
    if (this.verifying) {
      // Not fed to the main recogniser while a candidate is being checked (see module doc). Once
      // the decode itself has started (`deciding`), later audio is simply dropped rather than
      // collected into a second tail: only one verification runs at a time, so its replies are
      // never mixed up with another's on the shared verifyWaiting queue.
      if (this.deciding) return;
      this.verifyTail.push(samples.slice());
      this.verifyTailSize += samples.length;
      if (this.verifyTailSize >= RATE * VERIFY_TAIL_SECONDS) {
        const ring = this.verifyRing;
        const tail = this.verifyTail;
        this.verifyRing = [];
        this.verifyTail = [];
        this.verifyTailSize = 0;
        this.deciding = true;
        void this.verifyAndDecide(ring, tail);
      }
      return;
    }
    this.ring.push(samples.slice());
    // Kaldi takes 16-bit sample values as floats
    const data = samples.map(value => value * 0x8000);
    this.worker.postMessage(
      { action: 'audioChunk', recognizerId: this.recognizerId, sampleRate: RATE, data },
      { transfer: [data.buffer] },
    );
  }

  private handle(message: WorkerMessage): void {
    // "create" acks with no payload (and so no recognizerId); harmless, but now sent more often
    // (once per verification), so it is skipped explicitly rather than relying on it being ignored.
    if (!message) return;
    if (message.recognizerId === this.verifyRecognizerId) {
      this.verifyWaiting.shift()?.(message);
      return;
    }
    if (message.recognizerId !== this.recognizerId || this.paused || this.capture || this.verifying) return;
    const result = message.result as { partial?: string; text?: string } | undefined;
    const text = message.event === 'partialresult' ? result?.partial : message.event === 'result' ? result?.text : '';
    if (!heardWake(text) || Date.now() - this.lastWake < COOLDOWN_MS || Date.now() < this.retryNotBefore) return;
    // A candidate: hold off waking until a second, richer-grammar decode of the phrase window agrees.
    this.verifying = true;
    this.verifyRing = this.ring.take();
    this.verifyTail = [];
    this.verifyTailSize = 0;
  }

  /** Decodes a candidate's phrase window once more; wakes only if it agrees, and always resumes. */
  private async verifyAndDecide(ring: Float32Array[], tail: Float32Array[]): Promise<void> {
    const accepted = await this.verifyPhrase(ring, tail);
    this.verifying = false;
    this.deciding = false;
    if (!accepted) {
      // Rejected: resume listening at once, but not so eagerly that an ordinary sentence starting
      // with "hey" re-triggers verification on almost every chunk while it keeps going.
      this.retryNotBefore = Date.now() + VERIFY_RETRY_MS;
      return;
    }
    // A pause (or another wake) could have landed while this was decoding; respect it.
    if (this.paused || this.capture || Date.now() - this.lastWake < COOLDOWN_MS) return;
    this.lastWake = Date.now();
    this.capture = [...ring, ...tail];
    this.captured = this.capture.reduce((sum, chunk) => sum + chunk.length, 0);
    this.onWake();
  }

  /**
   * Decodes ring+tail as one final result on a fresh recogniser in the same worker, using
   * VERIFY_GRAMMAR instead of free dictation (the small model often fails to say "Ava" at all when
   * decoding freely, even on clean audio, but reliably manages it when the grammar can just offer
   * the word). Nothing here leaves the device: it is the same worker and model as the main listener.
   */
  private async verifyPhrase(ring: Float32Array[], tail: Float32Array[]): Promise<boolean> {
    const worker = this.worker;
    if (!worker) return false;
    const verifyId = crypto.randomUUID();
    this.verifyRecognizerId = verifyId;
    const chunks = [...ring, ...tail];
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const data = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) data[offset + i] = chunk[i] * 0x8000; // Kaldi wants 16-bit values as floats
      offset += chunk.length;
    }
    worker.postMessage({
      action: 'create',
      recognizerId: verifyId,
      sampleRate: RATE,
      grammar: JSON.stringify(VERIFY_GRAMMAR),
    });
    const first = this.nextVerifyReply();
    worker.postMessage(
      { action: 'audioChunk', recognizerId: verifyId, sampleRate: RATE, data },
      { transfer: [data.buffer] },
    );
    const final = this.nextVerifyReply();
    worker.postMessage({ action: 'retrieveFinalResult', recognizerId: verifyId });
    const replies = await Promise.all([first, final]);
    worker.postMessage({ action: 'remove', recognizerId: verifyId });
    this.verifyRecognizerId = null;
    const text = replies
      .map(message =>
        message.event === 'result' ? ((message.result as { text?: string } | undefined)?.text ?? '') : '',
      )
      .join(' ');
    return heyAvaPrefix(text);
  }

  private nextVerifyReply(): Promise<WorkerMessage> {
    return new Promise(resolve => this.verifyWaiting.push(resolve));
  }
}
