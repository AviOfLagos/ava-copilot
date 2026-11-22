import { PcmPlayer } from './player';
import type { FromTtsWorker, LocalVoiceEngine, ToTtsWorker } from './protocol';
import type { SpokenReport } from '../../background/voice/engines/wire';
import { splitSentences } from './text';

/**
 * The local voices in the offscreen document: starts the worker on first use, keeps the model loaded while it is
 * used, and ends the worker (freeing the model's memory) after a few idle minutes. One request speaks at a time; a
 * new one, or `stop()`, cuts off the one before.
 */

// The model stays loaded this long after it last spoke
export const IDLE_UNLOAD_MS = 5 * 60 * 1000;

export interface LocalTtsStats {
  engine: LocalVoiceEngine | null;
  // Requests spoken since the document opened; the figures below are the last one's
  requests: number;
  // How long the last model load took, and the first sentence of the last request after it was asked for
  loadMs: number | null;
  firstAudioMs: number | null;
  // Seconds of speech made per second of work, for the last request (above 1 is faster than real time)
  speedFactor: number | null;
  peakRms: number;
  playedSeconds: number;
  // What the listener heard of the last request: pauses where the voice had run dry waiting for the next sentence
  gaps: { count: number; totalMs: number; longestMs: number };
  // Per sentence of the last request: where the time went
  chunks: ChunkTiming[];
}

export interface ChunkTiming {
  chars: number;
  tokens: number;
  // Turning the text into phonemes (eSpeak) and the model making speech from them, in milliseconds
  phonemeMs: number;
  modelMs: number;
  // The whole sentence (both, and trimming), and the seconds of speech it made
  workMs: number;
  audioSeconds: number;
  // When it reached the player, counted from the request
  arrivedMs: number;
}

// The longest head start held back before speaking, in seconds of speech: past it waiting is worse than a pause
export const MAX_HEAD_START_SECONDS = 6;
// Counted on a voice a tenth slower than it measured, so a busy moment does not bring the pauses back
const HEAD_START_MARGIN = 0.9;

/**
 * How many seconds of speech must be ready before it starts playing so the rest, made at `speed` seconds of speech per
 * second of work, never runs dry: the voice falls behind by (1 - speed) for every second it plays, so the head start
 * covers that over what is still to be made. A voice at least as fast as it plays needs none.
 */
export function headStartSeconds(speed: number, remainingSeconds: number): number {
  const effective = speed * HEAD_START_MARGIN;
  if (!(effective > 0) || effective >= 1 || remainingSeconds <= 0) return 0;
  return Math.min(MAX_HEAD_START_SECONDS, (remainingSeconds * (1 - effective)) / effective);
}

export interface SpeakRequest {
  engine: LocalVoiceEngine;
  text: string;
  voice: string;
  // 1 is normal speed
  rate?: number;
}

interface Pending {
  id: number;
  engine: LocalVoiceEngine;
  // Characters in the sentences to say, and how many are made so far: the rest of the speech is estimated from them
  charsTotal: number;
  charsDone: number;
  // Speech made but kept back until there is enough ahead to play without a pause
  held: Float32Array[];
  heldSeconds: number;
  released: boolean;
  loadWaitMs: number | null;
  resolve: () => void;
  reject: (error: Error) => void;
  started: number;
  firstAudio: number | null;
  workMs: number;
  audioSeconds: number;
  done: boolean;
  // Rendering to a buffer (speech for a call), not playing: the sentences land here
  collect?: { chunks: Float32Array[]; sampleRate: number; cancelled: boolean };
}

/** Speech made but not played: mono float samples. */
export interface RenderedSpeech {
  samples: Float32Array;
  sampleRate: number;
}

export class LocalTts {
  private worker: Worker | null = null;
  private readonly player: PcmPlayer;
  private loads = new Map<LocalVoiceEngine, Promise<void>>();
  private loadWaiters = new Map<LocalVoiceEngine, { resolve: () => void; reject: (error: Error) => void }>();
  private pending: Pending | null = null;
  private nextId = 1;
  // Bumped by every stop and every new request: a request still loading knows it was overtaken
  private generation = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Told what each answer came to, once it has been heard (or cut off after some was)
  onSpoken: ((report: SpokenReport) => void) | null = null;
  readonly stats: LocalTtsStats = {
    engine: null,
    requests: 0,
    loadMs: null,
    firstAudioMs: null,
    speedFactor: null,
    peakRms: 0,
    playedSeconds: 0,
    gaps: { count: 0, totalMs: 0, longestMs: 0 },
    chunks: [],
  };

  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' }),
    private readonly modelBase = chrome.runtime.getURL('voice/'),
    player?: PcmPlayer,
  ) {
    this.player = player ?? new PcmPlayer();
  }

  /** Whether speech is being made or played right now. */
  get speaking(): boolean {
    return this.pending !== null || this.player.playing;
  }

  get loaded(): boolean {
    return this.worker !== null && this.loads.size > 0;
  }

  /** Switches the speaker local voices play through (Settings › Voice devices). */
  setOutputDevice(deviceId: string | null): void {
    this.player.setOutputDevice(deviceId);
  }

  /** Loads a voice's model now, so the first answer does not wait for it. */
  warm(engine: LocalVoiceEngine): Promise<void> {
    this.touch();
    let load = this.loads.get(engine);
    if (!load) {
      const started = performance.now();
      load = new Promise<void>((resolve, reject) => {
        this.loadWaiters.set(engine, { resolve, reject });
        this.post({ type: 'load', engine, base: this.modelBase });
      }).then(() => {
        this.stats.loadMs = Math.round(performance.now() - started);
        this.stats.engine = engine;
      });
      this.loads.set(engine, load);
      load.catch(() => this.loads.delete(engine));
    }
    return load;
  }

  /** Speaks text and resolves once it has been heard (or was stopped). */
  async speak(request: SpeakRequest): Promise<void> {
    this.stop();
    const generation = this.generation;
    const loadStarted = performance.now();
    await this.warm(request.engine);
    const loadWaitMs = performance.now() - loadStarted;
    // Stopped, or another request came, while the model loaded
    if (generation !== this.generation) return;
    const id = this.nextId++;
    this.player.resetStats();
    this.stats.requests++;
    this.stats.peakRms = 0;
    this.stats.playedSeconds = 0;
    this.stats.gaps = { count: 0, totalMs: 0, longestMs: 0 };
    this.stats.chunks = [];
    const finished = new Promise<void>((resolve, reject) => {
      this.pending = {
        id,
        engine: request.engine,
        charsTotal: splitSentences(request.text).reduce((sum, sentence) => sum + sentence.length, 0),
        charsDone: 0,
        held: [],
        heldSeconds: 0,
        released: false,
        loadWaitMs: loadWaitMs > 300 ? Math.round(loadWaitMs) : null,
        resolve,
        reject,
        started: performance.now(),
        firstAudio: null,
        workMs: 0,
        audioSeconds: 0,
        done: false,
      };
    });
    this.post({
      type: 'speak',
      id,
      engine: request.engine,
      text: request.text,
      voice: request.voice,
      speed: request.rate ?? 1,
    });
    return finished;
  }

  /**
   * Makes the speech without playing it (Ava's words for a call go to the companion, not this speaker). Shares
   * the one worker with speak(): a render cuts off what was playing, and a stop or a new request cancels it.
   */
  async render(request: SpeakRequest): Promise<RenderedSpeech> {
    this.stop();
    const generation = this.generation;
    await this.warm(request.engine);
    if (generation !== this.generation) throw new Error('Stopped');
    const id = this.nextId++;
    const collect = { chunks: [] as Float32Array[], sampleRate: 24_000, cancelled: false };
    const finished = new Promise<void>((resolve, reject) => {
      this.pending = {
        id,
        engine: request.engine,
        charsTotal: 0,
        charsDone: 0,
        held: [],
        heldSeconds: 0,
        released: true,
        loadWaitMs: null,
        resolve,
        reject,
        started: performance.now(),
        firstAudio: null,
        workMs: 0,
        audioSeconds: 0,
        done: false,
        collect,
      };
    });
    this.post({
      type: 'speak',
      id,
      engine: request.engine,
      text: request.text,
      voice: request.voice,
      speed: request.rate ?? 1,
    });
    await finished;
    if (collect.cancelled) throw new Error('Stopped');
    const length = collect.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of collect.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return { samples, sampleRate: collect.sampleRate };
  }

  /** Stops speaking at once; whatever was still being made is dropped. */
  stop(): void {
    this.cancelCurrent();
    this.touch();
  }

  /** Frees the model: the worker ends and its memory with it. */
  unload(): void {
    this.cancelCurrent();
    this.worker?.terminate();
    this.worker = null;
    for (const waiter of this.loadWaiters.values()) waiter.reject(new Error('The voice was unloaded'));
    this.loadWaiters.clear();
    this.loads.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private cancelCurrent(): void {
    this.generation++;
    const current = this.pending;
    this.pending = null;
    if (current && !current.done) this.worker?.postMessage({ type: 'cancel', id: current.id } satisfies ToTtsWorker);
    if (current?.collect) current.collect.cancelled = true;
    // What was heard before it was cut off still counts
    else if (current) {
      this.recordPlayback();
      this.report(current, true, 'cut-off');
    }
    this.player.stop();
    current?.resolve();
  }

  private recordPlayback(): void {
    this.stats.peakRms = this.player.peakRms;
    this.stats.playedSeconds = +this.player.playedSeconds.toFixed(2);
    this.stats.gaps = {
      count: this.player.gapCount,
      totalMs: Math.round(this.player.gapMs),
      longestMs: Math.round(this.player.longestGapMs),
    };
  }

  private post(message: ToTtsWorker): void {
    if (!this.worker) {
      this.worker = this.createWorker();
      this.worker.onmessage = event => this.handle(event.data as FromTtsWorker);
      this.worker.onerror = event => this.fail(event.message || 'The voice worker failed');
    }
    this.worker.postMessage(message);
  }

  private handle(message: FromTtsWorker): void {
    switch (message.type) {
      case 'loaded':
        this.loadWaiters.get(message.engine)?.resolve();
        this.loadWaiters.delete(message.engine);
        return;
      case 'audio': {
        const pending = this.pending;
        if (!pending || pending.id !== message.id) return;
        pending.firstAudio ??= performance.now();
        pending.workMs += message.ms;
        pending.audioSeconds += message.samples.length / message.sampleRate;
        if (!pending.collect) {
          this.stats.chunks.push({
            chars: message.chars ?? 0,
            tokens: message.tokens ?? 0,
            phonemeMs: Math.round(message.phonemeMs ?? 0),
            modelMs: Math.round(message.modelMs ?? 0),
            workMs: Math.round(message.ms),
            audioSeconds: +(message.samples.length / message.sampleRate).toFixed(2),
            arrivedMs: Math.round(performance.now() - pending.started),
          });
        }
        if (pending.collect) {
          pending.collect.chunks.push(message.samples);
          pending.collect.sampleRate = message.sampleRate;
        } else {
          pending.charsDone += message.chars ?? 0;
          this.hold(pending, message.samples);
        }
        return;
      }
      case 'done': {
        const pending = this.pending;
        if (!pending || pending.id !== message.id) return;
        pending.done = true;
        this.stats.firstAudioMs = pending.firstAudio === null ? null : Math.round(pending.firstAudio - pending.started);
        this.stats.speedFactor =
          pending.workMs > 0 ? +(pending.audioSeconds / (pending.workMs / 1000)).toFixed(2) : null;
        if (pending.collect) {
          this.pending = null;
          pending.resolve();
          this.touch();
          return;
        }
        // Whatever was held back plays now: nothing more is coming
        this.release(pending);
        void this.player.whenDrained().then(() => {
          if (this.pending !== pending) return;
          this.recordPlayback();
          this.report(pending, true);
          this.pending = null;
          pending.resolve();
          this.touch();
        });
        return;
      }
      case 'error':
        this.fail(message.message, message.id);
        return;
    }
  }

  /**
   * Speech arrives sentence by sentence. A voice that keeps up plays each at once; one slower than it plays keeps the
   * first sentences back until the head start covers the rest, so it speaks through instead of stopping after each
   * full stop.
   */
  private hold(pending: Pending, samples: Float32Array): void {
    if (pending.released) {
      this.player.enqueue(samples);
      return;
    }
    pending.held.push(samples);
    pending.heldSeconds += samples.length / 24_000;
    const speed = pending.workMs > 0 ? pending.audioSeconds / (pending.workMs / 1000) : Number.POSITIVE_INFINITY;
    const secondsPerChar = pending.charsDone > 0 ? pending.audioSeconds / pending.charsDone : 0;
    const remaining = Math.max(0, pending.charsTotal - pending.charsDone) * secondsPerChar;
    if (pending.heldSeconds >= headStartSeconds(speed, remaining)) this.release(pending);
  }

  private release(pending: Pending): void {
    pending.released = true;
    for (const samples of pending.held.splice(0)) this.player.enqueue(samples);
  }

  private report(pending: Pending, ok: boolean, note?: string): void {
    if (!this.onSpoken || pending.collect) return;
    // Nothing was made before it was cut off: nothing to say about it
    if (pending.audioSeconds === 0 && ok) return;
    const heard = this.player.playedSeconds;
    this.onSpoken({
      engine: pending.engine,
      ok,
      chars: pending.charsTotal,
      audioSeconds: +Math.max(heard, pending.audioSeconds).toFixed(2),
      workMs: Math.round(pending.workMs),
      speed: pending.workMs > 0 ? +(pending.audioSeconds / (pending.workMs / 1000)).toFixed(2) : null,
      firstAudioMs: pending.firstAudio === null ? null : Math.round(pending.firstAudio - pending.started),
      loadMs: pending.loadWaitMs,
      gaps: this.stats.gaps,
      note,
    });
  }

  private fail(reason: string, id?: number): void {
    const error = new Error(reason);
    if (id === undefined) {
      // A load failed (or the worker died): every waiter hears it, and the next use starts afresh
      for (const waiter of this.loadWaiters.values()) waiter.reject(error);
      this.loadWaiters.clear();
      this.loads.clear();
    }
    const pending = this.pending;
    if (pending && (id === undefined || pending.id === id)) {
      this.pending = null;
      this.player.stop();
      this.report(pending, false, 'failed');
      pending.reject(error);
    }
  }

  // The model stays while it is used; a quiet spell unloads it
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.speaking) this.unload();
    }, IDLE_UNLOAD_MS);
  }
}
