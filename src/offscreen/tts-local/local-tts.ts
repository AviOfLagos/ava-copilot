import { PcmPlayer } from './player';
import type { FromTtsWorker, LocalVoiceEngine, ToTtsWorker } from './protocol';

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
  readonly stats: LocalTtsStats = {
    engine: null,
    requests: 0,
    loadMs: null,
    firstAudioMs: null,
    speedFactor: null,
    peakRms: 0,
    playedSeconds: 0,
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
    await this.warm(request.engine);
    // Stopped, or another request came, while the model loaded
    if (generation !== this.generation) return;
    const id = this.nextId++;
    this.player.resetStats();
    this.stats.requests++;
    this.stats.peakRms = 0;
    this.stats.playedSeconds = 0;
    const finished = new Promise<void>((resolve, reject) => {
      this.pending = {
        id,
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
    else if (current) this.recordPlayback();
    this.player.stop();
    current?.resolve();
  }

  private recordPlayback(): void {
    this.stats.peakRms = this.player.peakRms;
    this.stats.playedSeconds = +this.player.playedSeconds.toFixed(2);
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
        if (pending.collect) {
          pending.collect.chunks.push(message.samples);
          pending.collect.sampleRate = message.sampleRate;
        } else {
          this.player.enqueue(message.samples);
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
        void this.player.whenDrained().then(() => {
          if (this.pending !== pending) return;
          this.recordPlayback();
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
