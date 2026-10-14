import { setAudioSinkId } from '@extension/shared';

/**
 * Plays the local voices' speech: clips scheduled back to back on one AudioContext, stopped at once when the user
 * talks over it. An AnalyserNode measures how loud the output really was, so a test (and the settings' "Say
 * something") can tell speech came out, not just that audio was made.
 */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private playAt = 0;
  private meter: ReturnType<typeof setInterval> | null = null;
  private drained: (() => void)[] = [];
  // The chosen speaker (Settings › Voice devices), or null for the system default; applied to a
  // context as soon as one exists, and to any later one `ensureContext` creates
  private sinkDeviceId: string | null = null;
  // The loudest output measured since the last reset, as root mean square
  peakRms = 0;
  // Seconds of speech played since the last reset
  playedSeconds = 0;

  constructor(private readonly sampleRate = 24_000) {}

  /** Switches the speaker this plays through, immediately if it is already playing. */
  setOutputDevice(deviceId: string | null): void {
    this.sinkDeviceId = deviceId;
    if (this.context) void setAudioSinkId(this.context, deviceId);
  }

  get playing(): boolean {
    return this.sources.length > 0;
  }

  /** Queues a clip after whatever is playing. */
  enqueue(samples: Float32Array): void {
    const context = this.ensureContext();
    if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser!);
    this.playAt = Math.max(this.playAt, context.currentTime + 0.02);
    source.start(this.playAt);
    this.playAt += buffer.duration;
    this.playedSeconds += buffer.duration;
    this.sources.push(source);
    this.startMeter();
    source.onended = () => {
      this.sources = this.sources.filter(item => item !== source);
      if (!this.sources.length) this.finish();
    };
  }

  /** Resolves once everything queued has played, or was stopped. */
  whenDrained(): Promise<void> {
    if (!this.playing) return Promise.resolve();
    return new Promise(resolve => this.drained.push(resolve));
  }

  /** Stops at once and drops what is queued. */
  stop(): void {
    const sources = this.sources;
    this.sources = [];
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Not started yet
      }
    }
    this.playAt = 0;
    this.finish();
  }

  resetStats(): void {
    this.peakRms = 0;
    this.playedSeconds = 0;
  }

  close(): void {
    this.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.analyser = null;
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.connect(this.context.destination);
      if (this.sinkDeviceId) void setAudioSinkId(this.context, this.sinkDeviceId);
    }
    void this.context.resume().catch(() => {});
    return this.context;
  }

  // An offscreen document gets no animation frames, so the output is sampled on a timer while it plays
  private startMeter(): void {
    if (this.meter || !this.analyser) return;
    const data = new Float32Array(this.analyser.fftSize);
    this.meter = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const value of data) sum += value * value;
      this.peakRms = Math.max(this.peakRms, Math.sqrt(sum / data.length));
    }, 50);
  }

  private finish(): void {
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    for (const resolve of this.drained.splice(0)) resolve();
  }
}
